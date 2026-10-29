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

  it('retries twice before giving up, by default', async () => {
    fetchMock.mockResolvedValue(fail(404, 'The requested model was not found.'));

    await expect(ask(provider())).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
    expect(warn.mock.calls[0][0]).toMatch(/retrying/i);
  });

  it('does not log a retry when the first attempt works', async () => {
    const warn = vi.fn();
    fetchMock.mockResolvedValue(ok());

    await ask(provider({ logger: { warn, log: () => {} } }));

    expect(warn).not.toHaveBeenCalled();
  });
});
