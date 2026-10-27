import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMuseProvider, fromMuseResponse, toMuseRequest } from '../../server/lib/llm/muse.js';
import {
  createLlmProvider,
  DEFAULT_PROVIDER,
  describeProviders,
  isValidProvider,
  PROVIDER_NAMES,
  resolveProviderName,
  UI_PROVIDER_NAMES
} from '../../server/lib/llm/index.js';

/**
 * Muse speaks the Responses API while the agent is built on Chat Completions
 * shapes. Every expectation below mirrors behaviour verified against the live
 * API: flat tool definitions, `max_output_tokens`, tool calls as `output`
 * items, and tool results as `function_call_output` input items. If any of
 * this drifts the agentic loop silently stops calling tools, which is the
 * failure these tests exist to catch.
 */

describe('toMuseRequest', () => {
  it('moves system messages into instructions and keeps user text as input', () => {
    const body = toMuseRequest({
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Analyze this form.' }
      ]
    });

    expect(body.instructions).toBe('Be terse.');
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Analyze this form.' }] }
    ]);
    expect(body.stream).toBe(false);
  });

  it('joins multiple system messages rather than dropping any', () => {
    const body = toMuseRequest({
      messages: [
        { role: 'system', content: 'First.' },
        { role: 'system', content: 'Second.' },
        { role: 'user', content: 'Go' }
      ]
    });

    expect(body.instructions).toBe('First.\n\nSecond.');
  });

  it('flattens Chat Completions tool definitions, which the API requires', () => {
    const body = toMuseRequest({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'goToPage',
            description: 'Navigate',
            parameters: { type: 'object', properties: { url: { type: 'string' } } }
          }
        }
      ]
    });

    // The nested `function` wrapper is rejected with a 400 by the real API.
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'goToPage',
        description: 'Navigate',
        parameters: { type: 'object', properties: { url: { type: 'string' } } }
      }
    ]);
    expect(body.tool_choice).toBe('auto');
  });

  it('omits tools and tool_choice entirely when there are none', () => {
    const body = toMuseRequest({ messages: [{ role: 'user', content: 'hi' }] });

    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('translates an assistant tool call into a function_call item', () => {
    const body = toMuseRequest({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: 'Checking.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'getWeather', arguments: '{"city":"Dallas"}' } }
          ]
        }
      ]
    });

    expect(body.input[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Checking.' }]
    });
    expect(body.input[2]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'getWeather',
      arguments: '{"city":"Dallas"}'
    });
  });

  it('translates a tool result into a function_call_output item', () => {
    const body = toMuseRequest({
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: '{"tempF":81}' }]
    });

    expect(body.input).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: '{"tempF":81}' }
    ]);
  });

  it('serializes a non-string tool result so the API always receives text', () => {
    const body = toMuseRequest({
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: { tempF: 81 } }]
    });

    expect(body.input[0].output).toBe('{"tempF":81}');
  });

  it('skips an assistant turn that carried only tool calls, with no text', () => {
    const body = toMuseRequest({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } }]
        }
      ]
    });

    expect(body.input).toHaveLength(1);
    expect(body.input[0].type).toBe('function_call');
  });

  it('uses max_output_tokens, the only token cap the API accepts', () => {
    const body = toMuseRequest({ messages: [], maxTokens: 4000 });

    // `max_tokens` and `max_completion_tokens` are both 400s.
    expect(body.max_output_tokens).toBe(4000);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('passes reasoning effort through only when asked', () => {
    expect(toMuseRequest({ messages: [], reasoningEffort: 'low' }).reasoning).toEqual({
      effort: 'low'
    });
    expect(toMuseRequest({ messages: [] })).not.toHaveProperty('reasoning');
  });
});

describe('fromMuseResponse', () => {
  const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [], status: 'completed' };

  it('reads the message item rather than output[0], which is reasoning', () => {
    const result = fromMuseResponse({
      status: 'completed',
      model: 'muse-wonder-1.0',
      output: [
        reasoningItem,
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'pong' }]
        }
      ],
      usage: { input_tokens: 10, output_tokens: 15, total_tokens: 25 }
    });

    expect(result.choices[0].message.content).toBe('pong');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.model).toBe('muse-wonder-1.0');
  });

  it('maps function_call items to Chat Completions tool_calls', () => {
    const result = fromMuseResponse({
      status: 'completed',
      output: [
        reasoningItem,
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
        {
          type: 'function_call',
          call_id: 'call_abc',
          name: 'getWeather',
          arguments: '{"city":"Dallas"}'
        }
      ]
    });

    expect(result.choices[0].message.tool_calls).toEqual([
      { id: 'call_abc', type: 'function', function: { name: 'getWeather', arguments: '{"city":"Dallas"}' } }
    ]);
    // The agent branches on this to decide whether to execute tools.
    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.content).toBe('Checking.');
  });

  it('reports truncation as a length finish reason', () => {
    const result = fromMuseResponse({
      status: 'incomplete',
      output: [reasoningItem, { type: 'message', content: [{ type: 'output_text', text: 'one two' }] }]
    });

    expect(result.choices[0].finish_reason).toBe('length');
  });

  it('returns null content when the model produced no message item', () => {
    const result = fromMuseResponse({ status: 'completed', output: [reasoningItem] });

    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message).not.toHaveProperty('tool_calls');
  });

  it('renames usage counters to the Chat Completions names', () => {
    const result = fromMuseResponse({
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 582,
        output_tokens: 174,
        total_tokens: 756,
        output_tokens_details: { reasoning_tokens: 156 }
      }
    });

    expect(result.usage).toEqual({
      prompt_tokens: 582,
      completion_tokens: 174,
      total_tokens: 756,
      reasoning_tokens: 156
    });
  });

  it('survives an empty payload without throwing', () => {
    expect(() => fromMuseResponse(undefined)).not.toThrow();
    expect(fromMuseResponse(undefined).choices[0].message.content).toBeNull();
  });
});

describe('provider registry', () => {
  it('registers the heuristic analyser plus both model providers', () => {
    expect(PROVIDER_NAMES.sort()).toEqual(['heuristic', 'muse', 'openai']);
    expect(DEFAULT_PROVIDER).toBe('muse');
    // The UI switch offers only these two; openai stays env-only.
    expect(UI_PROVIDER_NAMES).toEqual(['heuristic', 'muse']);
  });

  it('marks the heuristic analyser as needing no model call or key', () => {
    const described = describeProviders();

    expect(described.heuristic).toMatchObject({
      label: 'Heuristic',
      usesModel: false,
      configured: true,
      offeredInUi: true
    });
    expect(described.muse.usesModel).toBe(true);
    expect(described.openai.offeredInUi).toBe(false);
  });

  it('accepts only allowlisted provider names', () => {
    expect(isValidProvider('heuristic')).toBe(true);
    expect(isValidProvider('muse')).toBe(true);
    expect(isValidProvider('openai')).toBe(true);
    expect(isValidProvider('anthropic')).toBe(false);
    expect(isValidProvider('')).toBe(false);
    expect(isValidProvider(undefined)).toBe(false);
    // Guards against inherited Object.prototype keys being treated as valid.
    expect(isValidProvider('toString')).toBe(false);
    expect(isValidProvider('constructor')).toBe(false);
  });

  it('falls back to the default for an unknown request', () => {
    expect(resolveProviderName('openai')).toBe('openai');
    expect(resolveProviderName('nope')).toBe(DEFAULT_PROVIDER);
  });
});

describe('createMuseProvider transport', () => {
  const KEY = 'LLM_fake_key_for_tests_0123456789abcdef';
  const ENDPOINT = 'https://example.invalid/responses';

  const provider = (overrides = {}) =>
    createMuseProvider({ apiKey: KEY, endpoint: ENDPOINT, model: 'muse-test', ...overrides });

  const respond = (body, { ok = true, status = 200 } = {}) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
    });
    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
  };

  const rejectionFrom = async (promise) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }

    return null;
  };

  const okPayload = {
    status: 'completed',
    model: 'muse-test',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the bearer token, endpoint and translated body', async () => {
    const fetchMock = respond(okPayload);

    await provider().createCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers['Content-Type']).toBe('application/json');
    // A request without a deadline could hang a scan indefinitely.
    expect(init.signal).toBeDefined();

    const body = JSON.parse(init.body);
    expect(body.model).toBe('muse-test');
    expect(body.max_output_tokens).toBe(50);
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
    ]);
  });

  it('forwards the JSON response format when asked', async () => {
    const fetchMock = respond(okPayload);

    await provider().createCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: 'json_object'
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toEqual({
      format: { type: 'json_object' }
    });
  });

  it('surfaces the API error message from a non-ok response', async () => {
    respond({ error: { message: 'Unauthorized' } }, { ok: false, status: 401 });

    const error = await rejectionFrom(
      provider().createCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(error.message).toContain('401');
    expect(error.message).toContain('Unauthorized');
  });

  it('falls back to the raw body when a non-ok response is not JSON', async () => {
    respond('<html>Gateway Timeout</html>', { ok: false, status: 504 });

    const error = await rejectionFrom(
      provider().createCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(error.message).toContain('504');
    expect(error.message).toContain('Gateway Timeout');
  });

  it('throws when a 200 response is not valid JSON', async () => {
    respond('not json at all');

    const error = await rejectionFrom(
      provider().createCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(error.message).toMatch(/not valid JSON/i);
  });

  it('throws when a 200 response carries an error object', async () => {
    respond({ error: { message: 'content filtered' } });

    const error = await rejectionFrom(
      provider().createCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(error.message).toContain('content filtered');
  });

  it('reports a transport failure rather than leaking a stack', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const error = await rejectionFrom(
      provider().createCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(error.message).toMatch(/Muse request failed/i);
    expect(error.message).toContain('ECONNREFUSED');
  });

  it('never includes the API key in any error it throws', async () => {
    // The scan error reaches the UI and the logs, so a key echoed back by the
    // provider would be published. This is the guarantee that prevents it.
    const cases = [
      () => respond({ error: { message: `bad key ${KEY}` } }, { ok: false, status: 401 }),
      () => respond(`raw body containing ${KEY}`, { ok: false, status: 500 }),
      () => respond({ error: { message: `echo ${KEY}` } })
    ];

    for (const setup of cases) {
      vi.unstubAllGlobals();
      setup();

      const error = await rejectionFrom(
        provider().createCompletion({ messages: [{ role: 'user', content: 'hi' }] })
      );

      expect(error.message).not.toContain(KEY);
      expect(error.message).toContain('[REDACTED]');
    }
  });

  it('redacts the key from a transport error too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error(`connect failed using ${KEY}`))
    );

    const error = await rejectionFrom(
      provider().createCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(error.message).not.toContain(KEY);
  });

  it('refuses to call out at all when no key is configured', async () => {
    const fetchMock = respond(okPayload);

    const error = await rejectionFrom(
      provider({ apiKey: '' }).createCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    // The message has to tell the user what to do about it.
    expect(error.message).toContain('MODEL_API_KEY');
    expect(error.message).toMatch(/Dev Mode/i);
  });

  it('reports configuration state without exposing the key', () => {
    expect(provider().isConfigured()).toBe(true);
    expect(provider({ apiKey: '' }).isConfigured()).toBe(false);
    expect(provider().requiredEnvVar).toBe('MODEL_API_KEY');
    expect(JSON.stringify(provider())).not.toContain(KEY);
  });

  it('returns a Chat Completions shaped result', async () => {
    respond(okPayload);

    const result = await provider().createCompletion({
      messages: [{ role: 'user', content: 'hi' }]
    });

    expect(result.choices[0].message.content).toBe('hi');
    expect(result.usage.total_tokens).toBe(3);
  });
});
