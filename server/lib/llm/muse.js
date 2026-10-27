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

export const MUSE_ENDPOINT = 'https://api.meta.ai/v1/responses';
export const MUSE_DEFAULT_MODEL = 'muse-wonder-1.0';

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

    // user, and anything else, is plain input text.
    input.push({
      role: message.role,
      content: [{ type: 'input_text', text: message.content ?? '' }]
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
  apiKey = process.env.MODEL_API_KEY,
  model = process.env.MUSE_MODEL || MUSE_DEFAULT_MODEL,
  endpoint = MUSE_ENDPOINT,
  reasoningEffort = process.env.MUSE_REASONING_EFFORT || 'low',
  timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 120000)
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
        throw new Error(`Muse request failed: ${redactKey(error.message, apiKey)}`);
      }

      const raw = await response.text();

      if (!response.ok) {
        let detail = raw;
        try {
          detail = JSON.parse(raw)?.error?.message ?? raw;
        } catch {
          /* keep the raw body */
        }
        throw new Error(`Muse API error ${response.status}: ${redactKey(detail, apiKey)}`.trim());
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
  };
}
