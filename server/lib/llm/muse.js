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

import { cancellableDelay, isCancellation, throwIfCancelled } from '../cancellation.js';
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
  /**
   * How long to keep trying before giving up on the model entirely.
   *
   * Sized by measurement, and the measurement is about spacing rather than
   * volume. `model_not_found` arrives in bad patches whose rate swings
   * between 0% and 50% over minutes, on every model, not just the preview
   * one. Crammed attempts share a patch: 20 rapid-fire requests gave 6
   * refusals with a run of 3, while 24 attempts spaced a second apart gave
   * zero across both models.
   *
   * So the budget is a minute and the gap is seconds. A scan during a bad
   * patch takes longer; the alternative is a fast report scored by rules,
   * which finds no field-level issues at all and leaves the annotated
   * screenshot empty.
   *
   * An earlier version made five attempts 200ms apart, which is exactly the
   * wrong shape: a real scan burned all ten attempts across two models in
   * six seconds and still fell back.
   */
  retryBudgetMs = Number(readEnvValue('MUSE_RETRY_BUDGET_MS', '60000')),
  /** Gap between attempts. Seconds, because spacing is what works. */
  retryDelayMs = Number(readEnvValue('MUSE_RETRY_DELAY_MS', '2000')),
  /** Hard ceiling, so a tiny delay cannot turn the budget into a hot loop. */
  maxAttempts = Number(readEnvValue('MUSE_MAX_ATTEMPTS', '40')),
  /**
   * Stand-ins, tried in order once the preferred model is exhausted.
   *
   * muse-spark-1.3 takes the same request on the same endpoint, so a report
   * it produces is still a real audit -- findings attributed to controls, a
   * written narrative -- which the rule-based fallback is not.
   *
   * It is not a safe harbour, though. Spark carries the same intermittent
   * refusal: 4 of 8 calls were refused in one window and 0 of 20 in
   * another, so it is a second independent chance rather than a reliable
   * stand-in. That is why attempts alternate across the chain instead of
   * exhausting the preferred model first.
   */
  fallbackModels = (readEnvValue('MUSE_FALLBACK_MODELS', 'muse-spark-1.3') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  logger = console
} = {}) {
  return {
    name: 'muse',
    label: 'Muse',
    model,
    usesModel: true,
    isConfigured: () => Boolean(apiKey),
    requiredEnvVar: 'MODEL_API_KEY',

    async createCompletion({
      messages,
      tools,
      toolChoice,
      maxTokens,
      responseFormat,
      // Called on each refusal so a caller can tell the user why the scan is
      // taking longer, instead of leaving it looking stalled.
      onRetry,
      /**
       * Aborted when the user cancels the scan.
       *
       * Checked between attempts and threaded into the request itself,
       * because a single attempt may take up to MODEL_TIMEOUT_MS -- two
       * minutes by default. Waiting for it to return before noticing the
       * cancel would make the button look broken.
       */
      signal
    }) {
      if (!apiKey) {
        throw new Error(
          'Muse is selected but MODEL_API_KEY is not set. Add it to .env, switch the model to OpenAI, ' +
            'or turn on Dev Mode in the UI to run the full flow on mock data with no keys.'
        );
      }

      /*
       * Attempts alternate across the chain rather than exhausting one model
       * before trying the next.
       *
       * Both models carry the same intermittent refusal -- measured at 30%
       * on one and 50% on the other within minutes of each other -- so
       * spending the whole budget on a model that is in a bad patch wastes
       * it. Alternating gives every attempt a fresh chance on either.
       */
      const chain = [model, ...fallbackModels].filter(Boolean);
      const startedAt = Date.now();
      let lastError;
      let attempt = 0;

      while (true) {
        throwIfCancelled(signal);

        attempt += 1;

        const candidate = chain[(attempt - 1) % chain.length];
        const body = toMuseRequest({
          messages,
          tools,
          toolChoice,
          maxTokens,
          reasoningEffort,
          responseFormat,
          model: candidate
        });

        try {
          const completion = await attemptCompletion(body, candidate, signal);

          if (attempt > 1) {
            logger?.log?.(
              `   ✓ ${candidate} answered on attempt ${attempt} after ${Math.round((Date.now() - startedAt) / 1000)}s`
            );
          }

          return completion;
        } catch (error) {
          // Not a failure to retry or report: the user asked us to stop.
          if (isCancellation(error)) {
            throw error;
          }

          lastError = error;

          // A rejected credential or a malformed request will be rejected by
          // every model and by every retry. Fail now rather than spending a
          // minute reaching the same answer.
          if (!isRetryable(error)) {
            throw error;
          }

          const elapsed = Date.now() - startedAt;
          const exhausted = elapsed + retryDelayMs > retryBudgetMs || attempt >= maxAttempts;

          if (exhausted) {
            logger?.warn?.(
              `   ⚠ gave up after ${attempt} attempts over ${Math.round(elapsed / 1000)}s`
            );

            throw error;
          }

          // Named, because a log that does not say which model was refused
          // cannot be read afterwards -- two groups of identical retry lines
          // had to be told apart by counting them.
          logger?.warn?.(
            `   ↻ ${candidate} refused (${error.errorCode ?? error.status ?? 'error'}, request ${error.requestId ?? 'unknown'}) - attempt ${attempt}, ${Math.round((retryBudgetMs - elapsed) / 1000)}s budget left`
          );

          onRetry?.({
            attempt,
            model: candidate,
            elapsedMs: elapsed,
            budgetMs: retryBudgetMs,
            requestId: error.requestId ?? null
          });

          await cancellableDelay(retryDelayMs, signal);
        }
      }
    }
  };

  async function attemptCompletion(body, candidate, signal) {
    let response;

    // A cancel and a timeout both abort the request, so both are expressed
    // as signals and combined. `AbortSignal.any` settles on whichever fires
    // first and the check below decides which it was.
    const deadline = AbortSignal.timeout(timeoutMs);
    const abortOn = signal ? AbortSignal.any([deadline, signal]) : deadline;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: abortOn
      });
    } catch (error) {
      // A cancelled request looks exactly like a timed-out one from here.
      // Without asking the signal which it was, a cancel would be reported
      // as a transport blip and retried for the rest of the budget.
      throwIfCancelled(signal);

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

      // The request id is what Meta's support asks for when reporting a
      // failure, and it is only available here. Without it in the message, a
      // 404 recorded in our logs cannot be traced on their side afterwards.
      // Optional chaining because `headers` is guaranteed by the fetch spec
      // but not by every stub a test might hand us, and a missing trace id
      // must never be the thing that turns a reportable failure into a
      // thrown TypeError.
      const requestId = response.headers?.get?.('x-request-id') ?? null;
      const errorCode = (() => {
        try {
          return JSON.parse(raw)?.error?.code;
        } catch {
          return undefined;
        }
      })();

      const failure = new Error(
        [
          `Muse API error ${response.status}:`,
          redactKey(detail, apiKey),
          errorCode ? `[code ${errorCode}]` : '',
          requestId ? `[request ${requestId}]` : ''
        ]
          .filter(Boolean)
          .join(' ')
      );
      failure.status = response.status;
      failure.requestId = requestId;
      failure.errorCode = errorCode;

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

    // The model that actually answered travels with the response, so a
    // report produced by a stand-in can say so rather than claiming the
    // model that was asked for.
    return { ...fromMuseResponse(payload), model: payload.model ?? candidate };
  }
}
