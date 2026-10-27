/**
 * OpenAI provider.
 *
 * This is the "before" side of the demo toggle: the Chat Completions path the
 * scanner originally shipped with. Since Chat Completions is the internal
 * canonical format, this is a thin pass-through -- no translation needed.
 */
import OpenAI from 'openai';

export const OPENAI_DEFAULT_MODEL = 'gpt-5';

export function createOpenAiProvider({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL,
  client
} = {}) {
  // Constructed lazily so an unset key does not throw at import time.
  let openai = client ?? null;

  return {
    name: 'openai',
    label: 'OpenAI',
    model,
    usesModel: true,
    isConfigured: () => Boolean(apiKey),
    requiredEnvVar: 'OPENAI_API_KEY',

    async createCompletion({ messages, tools, toolChoice, maxTokens, responseFormat }) {
      if (!apiKey && !client) {
        throw new Error(
          'OpenAI is selected but OPENAI_API_KEY is not set. Add it to .env, switch the model to Muse, ' +
            'or turn on Dev Mode in the UI to run the full flow on mock data with no keys.'
        );
      }

      openai = openai ?? new OpenAI({ apiKey });

      const request = { model, messages };

      if (tools?.length) {
        request.tools = tools;
        request.tool_choice = toolChoice ?? 'auto';
      }

      if (maxTokens) {
        // GPT-5 takes max_completion_tokens rather than max_tokens.
        request.max_completion_tokens = maxTokens;
      }

      if (responseFormat === 'json_object') {
        request.response_format = { type: 'json_object' };
      }

      return openai.chat.completions.create(request);
    }
  };
}
