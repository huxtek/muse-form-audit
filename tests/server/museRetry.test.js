import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMuseProvider } from '../../server/lib/llm/muse.js';

/**
 * The deployment showed a 50% failure rate on model calls: three of six came
 * back `404 The requested model was not found.` while the rest succeeded,
 * with the same key, the same model string and the same request shape. The
 * stored env var was read back directly and is exactly "muse-wonder-1.0", and
 * the identical request succeeded 12 times out of 12 from a developer
 * machine. So the 404 is transient, and retrying is the fix.
 *
 * The interesting cases here are the ones that must NOT be retried.
 */
const ok = () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: '{"score":80}' }] }
      ],
      usage: { total_tokens: 10 }
    })
});

const fail = (status, message = 'boom') => ({
  ok: false,
  status,
  text: async () => JSON.stringify({ error: { message } })
});

const silent = { warn: () => {}, log: () => {} };

const provider = (overrides = {}) =>
  createMuseProvider({
    apiKey: 'test-key',
    model: 'muse-wonder-1.0',
    retryDelayMs: 0,
    // Counts are driven by maxAttempts here, with the time budget set
    // effectively infinite, so assertions are deterministic. Budget
    // behaviour has its own tests below.
    retryBudgetMs: 10 ** 9,
    maxAttempts: 3,
    // No stand-ins unless a test asks for one, so the counts below measure
    // retries of a single model rather than retries across the chain.
    fallbackModels: [],
    logger: silent,
    ...overrides
  });

const ask = (instance) =>
  instance.createCompletion({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('muse retry: transient failures', () => {
  it('retries the 404 the deployment actually returned, and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(404, 'The requested model was not found.'))
      .mockResolvedValueOnce(ok());

    const result = await ask(provider());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.choices[0].message.content).toContain('80');
  });

  it('stops at the attempt ceiling', async () => {
    fetchMock.mockResolvedValue(fail(404, 'The requested model was not found.'));

    await expect(ask(provider({ maxAttempts: 4 }))).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stops when the time budget is spent, not at a fixed count', async () => {
    // The budget is what matters: refusals come in patches, and spacing is
    // what gets through them. A delay that does not fit the remaining
    // budget ends the attempt.
    fetchMock.mockResolvedValue(fail(404));

    await expect(
      ask(provider({ retryBudgetMs: 100, retryDelayMs: 80, maxAttempts: 99 }))
    ).rejects.toThrow(/404/);

    // One attempt, then 80ms does not fit twice inside 100ms.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('retries a rate limit', async () => {
    fetchMock.mockResolvedValueOnce(fail(429, 'slow down')).mockResolvedValueOnce(ok());

    await ask(provider());

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a gateway error', async () => {
    fetchMock.mockResolvedValueOnce(fail(503, 'unavailable')).mockResolvedValueOnce(ok());

    await ask(provider());

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure or timeout', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockResolvedValueOnce(ok());

    await ask(provider());

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours a configured attempt count', async () => {
    fetchMock.mockResolvedValue(fail(404));

    await expect(ask(provider({ maxAttempts: 5 }))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('makes a single attempt when retries are turned off', async () => {
    fetchMock.mockResolvedValue(fail(404));

    await expect(ask(provider({ maxAttempts: 1 }))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('muse retry: permanent failures are not retried', () => {
  it('does not retry a rejected credential', async () => {
    // A key that is wrong stays wrong. Retrying only delays a clear error
    // and triples the time before the fallback runs.
    fetchMock.mockResolvedValue(fail(401, 'Unauthorized'));

    await expect(ask(provider())).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a forbidden request', async () => {
    fetchMock.mockResolvedValue(fail(403, 'Forbidden'));

    await expect(ask(provider())).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a malformed request', async () => {
    // A bad body stays bad, and retrying would hide a bug of ours.
    fetchMock.mockResolvedValue(fail(400, 'invalid image payload'));

    await expect(ask(provider())).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unparseable body', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'not json' });

    await expect(ask(provider())).rejects.toThrow(/not valid JSON/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a missing key, and says what to do', async () => {
    await expect(ask(provider({ apiKey: undefined }))).rejects.toThrow(/MODEL_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('muse retry: secrecy and reporting', () => {
  it('keeps the key out of a failure message', async () => {
    // The API echoes the request back in some errors.
    fetchMock.mockResolvedValue(fail(404, 'no model for key sk-secret-value-123'));

    const instance = provider({ apiKey: 'sk-secret-value-123' });

    await expect(ask(instance)).rejects.toThrow(/\[REDACTED\]/);
    await expect(ask(instance)).rejects.not.toThrow(/sk-secret-value-123/);
  });

  it('reports each retry so a fallback is traceable in the logs', async () => {
    const warn = vi.fn();
    fetchMock.mockResolvedValueOnce(fail(404)).mockResolvedValueOnce(ok());

    await ask(provider({ logger: { warn, log: () => {} } }));

    expect(warn).toHaveBeenCalledTimes(1);
    // The model is named: two groups of identical retry lines previously had
    // to be told apart by counting them.
    expect(warn.mock.calls[0][0]).toMatch(/muse-wonder-1\.0 refused/);
    expect(warn.mock.calls[0][0]).toMatch(/attempt 1/);
  });

  it('does not log a retry when the first attempt works', async () => {
    const warn = vi.fn();
    fetchMock.mockResolvedValue(ok());

    await ask(provider({ logger: { warn, log: () => {} } }));

    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * Meta's support asks for the request id when reporting a failure, and it is
 * only available at the moment of the response. Without it in the error, a
 * 404 in our logs cannot be traced on their side afterwards -- which is
 * exactly the position we were in for the first six failures.
 */
describe('muse failure reporting carries a request id', () => {
  const failWithHeaders = (status, { requestId, code }) => ({
    ok: false,
    status,
    headers: { get: (name) => (name === 'x-request-id' ? requestId : null) },
    text: async () => JSON.stringify({ error: { code, message: 'The requested model was not found.' } })
  });

  it('puts the request id and error code in the message', async () => {
    fetchMock.mockResolvedValue(
      failWithHeaders(404, { requestId: 'b17ca636-50e4-4e62-a66d-9072e18f28d5', code: 'model_not_found' })
    );

    await expect(ask(provider())).rejects.toThrow(/request b17ca636-50e4-4e62-a66d-9072e18f28d5/);
    await expect(ask(provider())).rejects.toThrow(/code model_not_found/);
  });

  it('exposes them on the error for a caller that wants them structured', async () => {
    fetchMock.mockResolvedValue(failWithHeaders(404, { requestId: 'abc-123', code: 'model_not_found' }));

    await ask(provider()).catch((error) => {
      expect(error.requestId).toBe('abc-123');
      expect(error.errorCode).toBe('model_not_found');
      expect(error.status).toBe(404);
    });
  });

  it('still reports cleanly when the header is absent', async () => {
    fetchMock.mockResolvedValue(failWithHeaders(500, { requestId: null, code: undefined }));

    await expect(ask(provider())).rejects.toThrow(/Muse API error 500/);
    await expect(ask(provider())).rejects.not.toThrow(/request null/);
  });
});

/**
 * The stand-in chain.
 *
 * `muse-wonder-1.0` is in preview and refuses about a quarter of calls with
 * `model_not_found`. Five attempts leave roughly one in a thousand unserved,
 * and for those the alternative is a rule-based analysis that produces no
 * field-level findings at all -- an empty annotated screenshot and a report
 * that reads "Nothing to fix" for a form with real problems.
 *
 * `muse-spark-1.3` is generally available, takes the same request on the
 * same endpoint, and answered every call in every observation including
 * vision. A report it produces is still a real audit.
 */
describe('muse model chain', () => {
  const okFrom = (model) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        model,
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', content: [{ type: 'output_text', text: '{"score":70}' }] }
        ],
        usage: { total_tokens: 20 }
      })
  });

  const chained = (overrides = {}) =>
    createMuseProvider({
      apiKey: 'test-key',
      model: 'muse-wonder-1.0',
      fallbackModels: ['muse-spark-1.3'],
      retryDelayMs: 0,
      retryBudgetMs: 10 ** 9,
      maxAttempts: 4,
      logger: silent,
      ...overrides
    });

  const bodyModels = () =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).model);

  it('alternates models across attempts rather than exhausting one first', async () => {
    // Both models carry the same intermittent refusal -- 30% on one and 50%
    // on the other within minutes -- so spending the whole budget on a model
    // that is in a bad patch wastes it.
    fetchMock.mockResolvedValue(fail(404, 'The requested model was not found.'));

    await expect(ask(chained())).rejects.toThrow(/404/);

    expect(bodyModels()).toEqual([
      'muse-wonder-1.0',
      'muse-spark-1.3',
      'muse-wonder-1.0',
      'muse-spark-1.3'
    ]);
  });

  it('takes the stand-in on the second attempt when the first is refused', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(404))
      .mockResolvedValueOnce(okFrom('muse-spark-1.3'));

    const result = await ask(chained());

    expect(bodyModels()).toEqual(['muse-wonder-1.0', 'muse-spark-1.3']);
    expect(result.model).toBe('muse-spark-1.3');
  });

  it('reports which model actually answered', async () => {
    // Without this the report would name the model that was requested and
    // claim work the stand-in did.
    fetchMock
      .mockResolvedValueOnce(fail(404))
      .mockResolvedValueOnce(okFrom('muse-spark-1.3'));

    expect((await ask(chained())).model).toBe('muse-spark-1.3');
  });

  it('names the preferred model when it answers first', async () => {
    fetchMock.mockResolvedValueOnce(okFrom('muse-wonder-1.0'));

    const result = await ask(chained());

    expect(result.model).toBe('muse-wonder-1.0');
    expect(bodyModels()).toEqual(['muse-wonder-1.0']);
  });

  it('does not touch the stand-in when the preferred model works', async () => {
    fetchMock.mockResolvedValue(okFrom('muse-wonder-1.0'));

    await ask(chained());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records which attempt and how long it took when a retry succeeds', async () => {
    const log = vi.fn();
    fetchMock
      .mockResolvedValueOnce(fail(404))
      .mockResolvedValueOnce(okFrom('muse-spark-1.3'));

    await ask(chained({ logger: { warn: () => {}, log } }));

    expect(log.mock.calls.map(([l]) => l).join('\n')).toMatch(
      /muse-spark-1\.3 answered on attempt 2/
    );
  });

  it('does not work through the chain for a rejected credential', async () => {
    // A bad key is bad for every model and every retry. Trying each one only
    // makes the same failure arrive a minute later.
    fetchMock.mockResolvedValue(fail(401, 'Unauthorized'));

    await expect(ask(chained())).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not work through the chain for a malformed request', async () => {
    fetchMock.mockResolvedValue(fail(400, 'bad body'));

    await expect(ask(chained())).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runs on one model when no stand-in is configured', async () => {
    fetchMock.mockResolvedValue(fail(404));

    await expect(ask(chained({ fallbackModels: [], maxAttempts: 2 }))).rejects.toThrow(/404/);
    expect(bodyModels()).toEqual(['muse-wonder-1.0', 'muse-wonder-1.0']);
  });
});

describe('muse retry reporting to the caller', () => {
  it('calls onRetry for each refusal so the UI can explain the wait', async () => {
    // A scan that goes quiet for a minute looks stalled. This is what lets
    // the job say "the model is briefly unavailable, still trying".
    const onRetry = vi.fn();
    fetchMock
      .mockResolvedValueOnce(fail(404, 'The requested model was not found.'))
      .mockResolvedValueOnce(ok());

    await provider().createCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      onRetry
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, model: 'muse-wonder-1.0' });
    expect(onRetry.mock.calls[0][0].budgetMs).toBeGreaterThan(0);
  });

  it('does not call onRetry when the first attempt works', async () => {
    const onRetry = vi.fn();
    fetchMock.mockResolvedValue(ok());

    await provider().createCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      onRetry
    });

    expect(onRetry).not.toHaveBeenCalled();
  });

  it('runs without an onRetry callback', async () => {
    fetchMock.mockResolvedValueOnce(fail(404)).mockResolvedValueOnce(ok());

    await expect(ask(provider())).resolves.toBeDefined();
  });
});
