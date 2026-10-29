/**
 * Muse provider.
 *
 * Muse speaks the Responses API, not Chat Completions. The agent is built on
 * Chat Completions shapes, so this module translates in both directions and
 * returns an OpenAI-shaped response. Keeping Chat Completions as the internal
 * canonical format means `agent.js` needs no knowledge of either provider.
 *
 * Differences verified against the live API, not assumed:
 *   - tool definitions must be FLAT (`{type, name, description, parameters}`);
 *     the nested Chat Completions form returns 400.
 *   - the token cap is `max_output_tokens`; `max_tokens` and
 *     `max_completion_tokens` are both rejected as unknown parameters.
 *   - unknown parameters are hard 400s, so nothing is forwarded blindly.
 *   - a truncated response arrives as `status: "incomplete"`.
 *   - tool calls arrive as `output[]` items of type `function_call`, and
 *     results are fed back as `function_call_output` input items.
 */

import { readEnvValue } from './envValue.js';

export const MUSE_ENDPOINT = 'https://api.meta.ai/v1/responses';

/**
 * Statuses worth trying again.
 *
 * 404 is in here, which looks wrong: "not found" is normally permanent. It
 * is not, in practice. Measured on the deployment, three of six model calls
 * came back `404 The requested model was not found.` while the other three
 * succeeded, with the same key, the same model string and the same request
 * shape -- and the same requests succeeded 12 times out of 12 from a
 * developer machine. The model id stored on the host was read back directly
 * and is exactly "muse-wonder-1.0", so nothing was malformed. The most
 * likely reading is that some backends behind the API do not serve the
 * model and the error reports that honestly, per request.
 *
 * 401 and 403 are deliberately absent: a rejected credential will be
 * rejected again, and retrying only delays a clear failure. 400 likewise --
 * a malformed request stays malformed.
 */
const RETRYABLE_STATUSES = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504]);

const RETRYABLE = Symbol('retryable');

const asRetryable = (error) => {
  error[RETRYABLE] = true;

  return error;
};

const isRetryable = (error) => Boolean(error?.[RETRYABLE]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const MUSE_DEFAULT_MODEL = 'muse-wonder-1.0';

// NOTE: this default is also what a misconfigured MUSE_MODEL falls back to,
// which is why the startup banner cannot be used to tell whether the
// variable was read at all -- both paths print the same string.

/**
 * Chat Completions content part -> Muse content part.
 *
 * Verified against the live API: `image_url` must be a FLAT string here. The
 * nested `{ url }` form that Chat Completions uses is rejected with
 * "input[0].content did not match any supported type".
 */
function toMuseContentPart(part) {
  if (!part || typeof part !== 'object') {
    return null;
  }

  if (part.type === 'text') {
    return { type: 'input_text', text: part.text ?? '' };
  }

  if (part.type === 'image_url') {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;

    return url ? { type: 'input_image', image_url: url } : null;
  }

  // Already in Muse's vocabulary.
  if (part.type === 'input_text' || part.type === 'input_image') {
    return part;
  }

  return null;
}

/**
 * Chat Completions request -> Muse Responses request.
 *
 * System messages become top-level `instructions`; everything else becomes an
 * `input` item. Exported separately from the transport so it can be unit
 * tested without a network call.
 */
export function toMuseRequest({
  messages = [],
  tools,
  toolChoice,
  maxTokens,
  reasoningEffort,
  responseFormat,
  model = MUSE_DEFAULT_MODEL
}) {
  const instructions = [];
  const input = [];

  for (const message of messages) {
    // A tool result carries no role in Muse's vocabulary; it is its own item.
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      });
      continue;
    }

    if (message.role === 'system') {
      if (message.content) {
        instructions.push(message.content);
      }
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content) {
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content }]
        });
      }

      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments
        });
      }
      continue;
    }

    // user, and anything else. Content may be a plain string or the Chat
    // Completions parts array, which is how an image is attached.
    input.push({
      role: message.role,
      content: Array.isArray(message.content)
        ? message.content.map(toMuseContentPart).filter(Boolean)
        : [{ type: 'input_text', text: message.content ?? '' }]
    });
  }

  const body = { model, input, stream: false };

  if (instructions.length > 0) {
    body.instructions = instructions.join('\n\n');
  }

  if (tools?.length) {
    // Flatten `{type, function: {...}}` into `{type, name, ...}`.
    body.tools = tools.map((tool) =>
      tool.function
        ? {
            type: 'function',
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters
          }
        : tool
    );
    body.tool_choice = toolChoice ?? 'auto';
  }

  if (maxTokens) {
    body.max_output_tokens = maxTokens;
  }

  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort };
  }

  // Structured output lives under `text.format` here, not `response_format`.
  if (responseFormat === 'json_object') {
    body.text = { format: { type: 'json_object' } };
  }

  return body;
}

/**
 * Muse Responses response -> Chat Completions response.
 *
 * The answer is NOT `output[0]`: index 0 is a reasoning item, and when a tool
 * is called there is also a commentary message. The text comes from the
 * `message` item and the calls from every `function_call` item.
 */
export function fromMuseResponse(payload) {
  const output = payload?.output ?? [];
  const message = output.find((item) => item.type === 'message');
  const calls = output.filter((item) => item.type === 'function_call');

  const text = (message?.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('');

  const toolCalls = calls.map((call) => ({
    id: call.call_id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments }
  }));

  let finishReason;
  if (toolCalls.length > 0) {
    finishReason = 'tool_calls';
  } else if (payload?.status === 'incomplete') {
    finishReason = 'length';
  } else {
    finishReason = 'stop';
  }

  const usage = payload?.usage ?? {};

  return {
    id: payload?.id,
    model: payload?.model,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        }
      }
    ],
    usage: {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens
    }
  };
}

/** Strips the API key out of anything headed for a log or an API response. */
function redactKey(text, key) {
  if (!key) {
    return String(text);
  }

  return String(text).split(key).join('[REDACTED]');
}

export function createMuseProvider({
  // Every one of these goes into an HTTP request, and every one arrives from
  // a dashboard or a clipboard. readEnvValue trims and unquotes, because a
  // trailing newline on MUSE_MODEL cost a deployment: it is invisible in a
  // log, and the API answers "404 The requested model was not found", which
  // points at the model id rather than at the whitespace around it.
  apiKey = readEnvValue('MODEL_API_KEY'),
  model = readEnvValue('MUSE_MODEL', MUSE_DEFAULT_MODEL),
  endpoint = readEnvValue('MUSE_ENDPOINT', MUSE_ENDPOINT),
  reasoningEffort = readEnvValue('MUSE_REASONING_EFFORT', 'low'),
  timeoutMs = Number(readEnvValue('MODEL_TIMEOUT_MS', '120000')),
  // Three attempts against a measured 50% per-call failure rate leaves
  // roughly one scan in eight still falling back, from one in two.
  maxAttempts = Number(readEnvValue('MUSE_MAX_ATTEMPTS', '3')),
  retryDelayMs = Number(readEnvValue('MUSE_RETRY_DELAY_MS', '600')),
  logger = console
} = {}) {
  return {
    name: 'muse',
    label: 'Muse',
    model,
    usesModel: true,
    isConfigured: () => Boolean(apiKey),
    requiredEnvVar: 'MODEL_API_KEY',

    async createCompletion({ messages, tools, toolChoice, maxTokens, responseFormat }) {
      if (!apiKey) {
        throw new Error(
          'Muse is selected but MODEL_API_KEY is not set. Add it to .env, switch the model to OpenAI, ' +
            'or turn on Dev Mode in the UI to run the full flow on mock data with no keys.'
        );
      }

      const body = toMuseRequest({
        messages,
        tools,
        toolChoice,
        maxTokens,
        reasoningEffort,
        responseFormat,
        model
      });

      let lastError;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await attemptCompletion(body);
        } catch (error) {
          lastError = error;

          if (!isRetryable(error) || attempt === maxAttempts) {
            throw error;
          }

          logger?.warn?.(
            `   ↻ ${error.message} - retrying (${attempt}/${maxAttempts - 1})`
          );

          await delay(retryDelayMs * attempt);
        }
      }

      throw lastError;
    }
  };

  async function attemptCompletion(body) {
    let response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw asRetryable(
        new Error(`Muse request failed: ${redactKey(error.message, apiKey)}`)
      );
    }

    const raw = await response.text();

    if (!response.ok) {
      let detail = raw;
      try {
        detail = JSON.parse(raw)?.error?.message ?? raw;
      } catch {
        /* keep the raw body */
      }

      const failure = new Error(
        `Muse API error ${response.status}: ${redactKey(detail, apiKey)}`.trim()
      );
      failure.status = response.status;

      throw RETRYABLE_STATUSES.has(response.status) ? asRetryable(failure) : failure;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('Muse returned a response that was not valid JSON.');
    }

    if (payload.error) {
      throw new Error(`Muse API error: ${redactKey(payload.error.message ?? 'unknown', apiKey)}`);
    }

    return fromMuseResponse(payload);
  }
}
