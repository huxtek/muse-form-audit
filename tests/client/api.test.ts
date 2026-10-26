import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formAPI } from '@/services/api';

/**
 * `formAPI` is the single HTTP seam between the UI and the backend, so the
 * request shapes and the error-message precedence are a contract. The
 * rate-limit toast in particular renders the server's `message` verbatim.
 */

const API = 'http://localhost:3001/api';

/** A fetch stub resolving to one JSON response. */
const respondWith = (body: unknown, init: { ok?: boolean; status?: number } = {}) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body)
  });
  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
};

/** Resolve to the rejection so the test can inspect message and `.response`. */
const rejectionFrom = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { response?: { status: number; data: unknown } };
  }

  return null;
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('formAPI.startScan', () => {
  it('posts the exact scan body to /api/scan', async () => {
    const fetchMock = respondWith({ success: true, jobId: 'job-1' });

    const result = await formAPI.startScan({
      url: 'https://example.com',
      fullCrawl: true,
      devMode: false
    });

    expect(result).toEqual({ success: true, jobId: 'job-1' });

    const [calledUrl, options] = fetchMock.mock.calls[0];

    expect(calledUrl).toBe(`${API}/scan`);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({
      url: 'https://example.com',
      fullCrawl: true,
      devMode: false
    });
  });

  it('throws the server message on the real 429 rate-limit shape', async () => {
    const body = {
      error: 'Scan Rate Limit Exceeded',
      message: 'Too many scan requests. Please wait before starting another scan.'
    };
    respondWith(body, { ok: false, status: 429 });

    const error = await rejectionFrom(
      formAPI.startScan({ url: 'https://example.com', fullCrawl: false, devMode: false })
    );

    expect(error?.message).toBe('Too many scan requests. Please wait before starting another scan.');
    expect(error?.response).toEqual({ status: 429, data: body });
  });

  it('falls back to errorData.error when the server sends no message', async () => {
    respondWith({ error: 'Invalid URL' }, { ok: false, status: 400 });

    const error = await rejectionFrom(
      formAPI.startScan({ url: 'http://127.0.0.1', fullCrawl: false, devMode: false })
    );

    expect(error?.message).toBe('Invalid URL');
  });

  it('falls back to HTTP <status> when the body carries neither field', async () => {
    respondWith({}, { ok: false, status: 503 });

    const error = await rejectionFrom(
      formAPI.startScan({ url: 'https://example.com', fullCrawl: false, devMode: false })
    );

    expect(error?.message).toBe('HTTP 503');
  });

  it('uses the per-call fallback when the error body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json'))
    });
    vi.stubGlobal('fetch', fetchMock);

    const error = await rejectionFrom(
      formAPI.startScan({ url: 'https://example.com', fullCrawl: false, devMode: false })
    );

    expect(error?.message).toBe('Scan failed');
  });
});

describe('formAPI.getReport', () => {
  it('GETs /api/report/:jobId', async () => {
    const fetchMock = respondWith({ id: 'job-1', status: 'running' });

    const result = await formAPI.getReport('job-1');

    expect(result).toEqual({ id: 'job-1', status: 'running' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/report/job-1`);
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
  });

  it('throws with the response attached when the job is missing', async () => {
    const body = { error: 'Not found', message: 'Scan job not found' };
    respondWith(body, { ok: false, status: 404 });

    const error = await rejectionFrom(formAPI.getReport('missing'));

    expect(error?.message).toBe('Scan job not found');
    expect(error?.response).toEqual({ status: 404, data: body });
  });
});

describe('formAPI.analyzeForm', () => {
  it('posts url, options and devMode to /api/analyze', async () => {
    const fetchMock = respondWith({ success: true });

    await formAPI.analyzeForm('https://example.com', { depth: 2 }, true);

    const [calledUrl, options] = fetchMock.mock.calls[0];

    expect(calledUrl).toBe(`${API}/analyze`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      url: 'https://example.com',
      options: { depth: 2 },
      devMode: true
    });
  });

  it('defaults devMode to false when omitted', async () => {
    const fetchMock = respondWith({ success: true });

    await formAPI.analyzeForm('https://example.com');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).devMode).toBe(false);
  });

  it('throws the server message on failure', async () => {
    respondWith({ message: 'Analysis failed for this page' }, { ok: false, status: 422 });

    const error = await rejectionFrom(formAPI.analyzeForm('https://example.com'));

    expect(error?.message).toBe('Analysis failed for this page');
    expect(error?.response).toEqual({
      status: 422,
      data: { message: 'Analysis failed for this page' }
    });
  });
});
