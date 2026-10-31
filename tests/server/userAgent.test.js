import { afterEach, describe, expect, it, vi } from 'vitest';

import { CRAWLER_USER_AGENT, crawlerRequestHeaders } from '../../server/lib/userAgent.js';
import { safeFetch, validateURLMiddleware } from '../../server/middleware/urlGuard.js';

/**
 * Both halves of the scanner have to ask for the page as the same client.
 *
 * The URL guard's pre-flight sent no User-Agent, and its final URL becomes
 * the scan target. Measured on https://www.google.com/travel/flights:
 *
 *   node fetch, no User-Agent   302 -> /travel/flights/unsupported?ucpp=...
 *   node fetch, browser UA      200, no redirect
 *
 * So the pre-flight was sent to Google's "unsupported browser" page, the
 * middleware adopted that URL, the crawler scanned it, and the report said
 * "no forms found" about Google Flights.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SKIP_URL_PREFLIGHT;
});

const ok = () => ({ status: 200, headers: { get: () => null }, body: null });

describe('how the scanner identifies itself', () => {
  it('sends a User-Agent at all', async () => {
    expect(crawlerRequestHeaders()['User-Agent']).toBe(CRAWLER_USER_AGENT);
    expect(CRAWLER_USER_AGENT).toMatch(/Mozilla\/5\.0/);
  });

  it('asks for HTML, as the browser that follows would', async () => {
    expect(crawlerRequestHeaders().Accept).toMatch(/text\/html/);
  });
});

describe('the pre-flight request', () => {
  it('carries the crawler User-Agent', async () => {
    // The header whose absence chose the page to scan.
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    await safeFetch('https://example.com/', {
      headers: crawlerRequestHeaders(),
      guard: { allowPrivateTargets: true, maxRedirects: 3, requestTimeoutMs: 1000 }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': CRAWLER_USER_AGENT })
      })
    );
  });

  it('is sent with that User-Agent by the middleware', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    const req = { body: { url: 'https://example.com/' }, headers: {} };
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
    const next = vi.fn();

    await validateURLMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers['User-Agent']).toBe(CRAWLER_USER_AGENT);
  });

  it('keeps the User-Agent on a redirect hop', async () => {
    // A server can redirect on the first request and serve on the second;
    // dropping the header on the way would reintroduce the split identity.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { get: (name) => (name.toLowerCase() === 'location' ? '/next' : null) }
      })
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);

    await safeFetch('https://example.com/', {
      headers: crawlerRequestHeaders(),
      guard: { allowPrivateTargets: true, maxRedirects: 3, requestTimeoutMs: 1000 }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers['User-Agent']).toBe(CRAWLER_USER_AGENT);
  });
});
