import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SCAN_CONFIG, fetchScanConfig } from '@/lib/scan-config';

/**
 * The demo gate has to be readable at runtime rather than compiled in: Vite
 * inlines its own variables at build time, so a build-time flag would turn
 * "enable real scans" into "rebuild and redeploy the front end", which is not
 * a thing to be doing minutes before a demo.
 */
const okResponse = (payload: unknown) => ({
  ok: true,
  json: async () => payload
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchScanConfig', () => {
  it('reports the gate as the server states it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ realScansEnabled: false })));

    expect(await fetchScanConfig()).toEqual({ realScansEnabled: false });
  });

  it('reports real scans available when the server says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ realScansEnabled: true })));

    expect(await fetchScanConfig()).toEqual({ realScansEnabled: true });
  });

  it('fails open when the request throws', async () => {
    // The API is what enforces the gate, so the worst case here is a clear
    // 403 on submit. Failing closed would let one flaky request tell
    // everybody that scanning is switched off on a working deployment.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    expect(await fetchScanConfig()).toEqual(DEFAULT_SCAN_CONFIG);
    expect(DEFAULT_SCAN_CONFIG.realScansEnabled).toBe(true);
  });

  it('fails open on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    expect(await fetchScanConfig()).toEqual(DEFAULT_SCAN_CONFIG);
  });

  it('treats a missing field as enabled rather than disabled', async () => {
    // Only an explicit false switches it off, so a partial or older response
    // cannot accidentally hide the product's main action.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({})));

    expect(await fetchScanConfig()).toEqual({ realScansEnabled: true });
  });

  it('treats a malformed body as enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('not json');
        }
      })
    );

    expect(await fetchScanConfig()).toEqual(DEFAULT_SCAN_CONFIG);
  });
});
