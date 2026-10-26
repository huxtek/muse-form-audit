import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SSRF guard is the security boundary of this service: it decides which
 * user-supplied URLs the crawler is allowed to touch. Its original 13-case
 * verification was a throwaway script, so these tests are the only thing
 * standing between a well-meaning future edit and a reachable metadata
 * endpoint.
 *
 * Assertions are on `code`, never on message prose, so copy edits stay cheap.
 *
 * Hermetic by construction: `dns.lookup` is mocked, and every case that does
 * not need a hostname uses an IP literal, which the guard resolves without
 * touching the resolver at all.
 */

const dnsLookup = vi.hoisted(() => vi.fn());

vi.mock('dns', () => ({
  default: { lookup: dnsLookup }
}));

/** Point the mocked resolver at a set of addresses for any hostname. */
const resolvesTo = (...addresses) => {
  dnsLookup.mockImplementation((hostname, options, callback) => {
    callback(
      null,
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4
      }))
    );
  });
};

const { assertSafeUrl, safeFetch, validateURLMiddleware, UrlGuardError } = await import(
  '../../server/middleware/urlGuard.js'
);

/** Resolve to the thrown UrlGuardError so each case can assert on its code. */
const rejectionFrom = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  return null;
};

const originalEnv = { ...process.env };

beforeEach(() => {
  dnsLookup.mockReset();
  dnsLookup.mockImplementation(() => {
    throw new Error('Unexpected DNS lookup: this case should not need the resolver');
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('assertSafeUrl: the 13 documented verification cases', () => {
  it('rejects the AWS/GCP instance metadata address', async () => {
    const error = await rejectionFrom(assertSafeUrl('http://169.254.169.254/latest/meta-data/'));

    expect(error).toBeInstanceOf(UrlGuardError);
    expect(error.code).toBe('PRIVATE_TARGET_BLOCKED');
  });

  it('rejects localhost by hostname, without consulting DNS', async () => {
    const error = await rejectionFrom(assertSafeUrl('http://localhost:3000'));

    expect(error.code).toBe('PRIVATE_TARGET_BLOCKED');
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it('rejects the file: scheme', async () => {
    const error = await rejectionFrom(assertSafeUrl('file:///etc/passwd'));

    expect(error.code).toBe('SCHEME_BLOCKED');
  });

  it('rejects the gopher: scheme', async () => {
    const error = await rejectionFrom(assertSafeUrl('gopher://example.com/'));

    expect(error.code).toBe('SCHEME_BLOCKED');
  });

  it('allows a public host, reporting the resolved addresses', async () => {
    resolvesTo('93.184.216.34');

    const result = await assertSafeUrl('https://example.com');

    expect(result.hostname).toBe('example.com');
    expect(result.addresses).toEqual(['93.184.216.34']);
    expect(result.url).toBe('https://example.com/');
  });

  it.each([
    ['IPv4 loopback', 'http://127.0.0.1:8080/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['RFC1918 10/8', 'http://10.0.0.5/'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
    ['RFC1918 172.16/12', 'http://172.16.0.1/']
  ])('rejects %s', async (_label, url) => {
    const error = await rejectionFrom(assertSafeUrl(url));

    expect(error).toBeInstanceOf(UrlGuardError);
    expect(error.code).toBe('PRIVATE_TARGET_BLOCKED');
  });

  it('rejects the GCP metadata hostname before resolving it', async () => {
    const error = await rejectionFrom(assertSafeUrl('http://metadata.google.internal/'));

    expect(error.code).toBe('URL_BLOCKED');
    expect(dnsLookup).not.toHaveBeenCalled();
  });
});

describe('assertSafeUrl: properties a future edit is most likely to break', () => {
  it('keeps cloud metadata blocked even when allowPrivateTargets is on', async () => {
    const byAddress = await rejectionFrom(
      assertSafeUrl('http://169.254.169.254/latest/meta-data/', { allowPrivateTargets: true })
    );
    const byHostname = await rejectionFrom(
      assertSafeUrl('http://metadata.google.internal/', { allowPrivateTargets: true })
    );

    expect(byAddress.code).toBe('PRIVATE_TARGET_BLOCKED');
    expect(byHostname.code).toBe('URL_BLOCKED');
  });

  it('allows loopback only when allowPrivateTargets is explicitly on', async () => {
    const blocked = await rejectionFrom(assertSafeUrl('http://127.0.0.1:8080/'));

    expect(blocked.code).toBe('PRIVATE_TARGET_BLOCKED');

    const allowed = await assertSafeUrl('http://127.0.0.1:8080/', { allowPrivateTargets: true });

    expect(allowed.addresses).toEqual(['127.0.0.1']);
  });

  it('rejects URLs carrying embedded credentials', async () => {
    const error = await rejectionFrom(assertSafeUrl('https://admin:hunter2@example.com/'));

    expect(error.code).toBe('URL_BLOCKED');
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it('rejects a public hostname that resolves to a private address', async () => {
    resolvesTo('10.1.2.3');

    const error = await rejectionFrom(assertSafeUrl('https://dns-rebind.example'));

    expect(error.code).toBe('PRIVATE_TARGET_BLOCKED');
  });

  it('rejects when any one of several resolved addresses is private', async () => {
    resolvesTo('93.184.216.34', '169.254.169.254');

    const error = await rejectionFrom(assertSafeUrl('https://mixed.example'));

    expect(error.code).toBe('PRIVATE_TARGET_BLOCKED');
  });

  it('rejects known lateral-movement ports', async () => {
    const error = await rejectionFrom(assertSafeUrl('http://example.com:6379/'));

    expect(error.code).toBe('PORT_BLOCKED');
  });
});

describe('safeFetch: redirect handling', () => {
  const redirectTo = (location) => ({
    status: 302,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) }
  });

  const ok = () => ({
    status: 200,
    headers: { get: () => null }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-validates each hop, so an open redirect to metadata is blocked', async () => {
    resolvesTo('93.184.216.34');
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectTo('http://169.254.169.254/'));
    vi.stubGlobal('fetch', fetchMock);

    const error = await rejectionFrom(safeFetch('https://open-redirect.example/go'));

    expect(error).toBeInstanceOf(UrlGuardError);
    expect(error.code).toBe('PRIVATE_TARGET_BLOCKED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enforces the redirect cap', async () => {
    resolvesTo('93.184.216.34');
    const fetchMock = vi.fn().mockResolvedValue(redirectTo('https://loop.example/next'));
    vi.stubGlobal('fetch', fetchMock);

    const error = await rejectionFrom(
      safeFetch('https://loop.example/start', { guard: { maxRedirects: 2 } })
    );

    expect(error.code).toBe('TOO_MANY_REDIRECTS');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('follows an allowed redirect and reports the final URL', async () => {
    resolvesTo('93.184.216.34');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://example.com/final'))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);

    const { finalUrl, redirects } = await safeFetch('https://example.com/start');

    expect(finalUrl).toBe('https://example.com/final');
    expect(redirects).toBe(1);
  });
});

describe('validateURLMiddleware: configuration never comes from the request', () => {
  /** Minimal Express double that records the status and JSON body written. */
  const makeResponse = () => {
    const sent = {};

    return {
      sent,
      status(code) {
        sent.status = code;

        return this;
      },
      json(body) {
        sent.body = body;

        return this;
      }
    };
  };

  it('ignores x-allow-localhost and x-allow-private-ips headers', async () => {
    const res = makeResponse();
    const next = vi.fn();

    await validateURLMiddleware(
      {
        body: { url: 'http://127.0.0.1:8080/' },
        headers: {
          'x-allow-localhost': 'true',
          'x-allow-private-ips': 'true'
        }
      },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.sent.status).toBe(400);
    expect(res.sent.body.code).toBe('PRIVATE_TARGET_BLOCKED');
  });

  it('ignores an allowPrivateTargets field smuggled in the request body', async () => {
    const res = makeResponse();
    const next = vi.fn();

    await validateURLMiddleware(
      {
        body: { url: 'http://169.254.169.254/', allowPrivateTargets: true },
        headers: {}
      },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.sent.status).toBe(400);
    expect(res.sent.body.code).toBe('PRIVATE_TARGET_BLOCKED');
  });

  it('passes a vetted final URL downstream when the pre-flight is skipped', async () => {
    process.env.SKIP_URL_PREFLIGHT = 'true';
    resolvesTo('93.184.216.34');
    const req = { body: { url: 'https://example.com/page' }, headers: {} };
    const next = vi.fn();

    await validateURLMiddleware(req, makeResponse(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.validatedURL).toBe('https://example.com/page');
    expect(req.resolvedAddresses).toEqual(['93.184.216.34']);
  });
});
