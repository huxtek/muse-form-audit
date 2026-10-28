import { describe, expect, it } from 'vitest';

import { MODEL_PROVIDERS, DEFAULT_MODEL_PROVIDER } from '@/defines/modelProviders';
import {
  buildDemoPath,
  buildScanPath,
  buildScanSearch,
  parseBooleanParam,
  parseModelProviderParam,
  parseScanParams,
  SCAN_DEMO_TARGET
} from '@/lib/scan-url';

/**
 * The query string is now a contract: it is what the Back button reads, what
 * a shared link carries, and what decides whether the page shows a form or a
 * report. Everything here is the pure half of that, kept away from the router
 * so the rules can be pinned without a DOM.
 */
const params = (search: string) => new URLSearchParams(search);

describe('parseBooleanParam', () => {
  it('accepts the spellings someone might type by hand', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(parseBooleanParam(value)).toBe(true);
    }
  });

  it('treats absent and unrecognised values as off', () => {
    // A malformed option should cost nobody their scan.
    for (const value of [null, '', '0', 'false', 'maybe']) {
      expect(parseBooleanParam(value)).toBe(false);
    }
  });
});

describe('parseModelProviderParam', () => {
  it('accepts the known providers', () => {
    expect(parseModelProviderParam('heuristic')).toBe(MODEL_PROVIDERS.HEURISTIC);
    expect(parseModelProviderParam('MUSE')).toBe(MODEL_PROVIDERS.MUSE);
  });

  it('falls back to the default for anything else', () => {
    // Otherwise a stale link could put the switch in a state the UI has no
    // control for, leaving it stuck.
    expect(parseModelProviderParam('gpt-9')).toBe(DEFAULT_MODEL_PROVIDER);
    expect(parseModelProviderParam(null)).toBe(DEFAULT_MODEL_PROVIDER);
  });
});

describe('parseScanParams', () => {
  it('reads a plain target', () => {
    expect(parseScanParams(params('url=https://example.com'))).toEqual({
      target: 'https://example.com',
      url: 'https://example.com',
      isDemo: false,
      fullCrawl: false,
      modelProvider: DEFAULT_MODEL_PROVIDER
    });
  });

  it('reads the options alongside it', () => {
    const parsed = parseScanParams(params('url=https://example.com&fullCrawl=1&modelProvider=heuristic'));

    expect(parsed.fullCrawl).toBe(true);
    expect(parsed.modelProvider).toBe(MODEL_PROVIDERS.HEURISTIC);
  });

  it('reports no target when the param is missing or blank', () => {
    // '' is what the page reads as "show me the form", so Back has to land
    // here rather than on a report with nothing behind it.
    expect(parseScanParams(params('')).target).toBe('');
    expect(parseScanParams(params('url=%20%20')).target).toBe('');
  });

  it('keeps the demo a target without making it a URL', () => {
    const parsed = parseScanParams(params(`url=${SCAN_DEMO_TARGET}`));

    // target stays truthy or the page would bin the sample as "nothing
    // asked for"; url stays empty or a prefilled `demo` would fail
    // validation the moment anyone pressed Scan.
    expect(parsed.target).toBe(SCAN_DEMO_TARGET);
    expect(parsed.isDemo).toBe(true);
    expect(parsed.url).toBe('');
  });
});

describe('buildScanSearch', () => {
  it('writes only the target when the options are at their defaults', () => {
    // Shared links are read by people, so the common case stays short.
    expect(buildScanSearch({ url: 'https://example.com' })).toBe(
      'url=https%3A%2F%2Fexample.com'
    );
  });

  it('writes the options when they differ from the defaults', () => {
    const search = buildScanSearch({
      url: 'https://example.com',
      fullCrawl: true,
      modelProvider: MODEL_PROVIDERS.HEURISTIC
    });

    expect(search).toContain('fullCrawl=1');
    expect(search).toContain('modelProvider=heuristic');
  });

  it('round-trips through the parser', () => {
    const options = {
      url: 'https://example.com/sign-up?step=2',
      fullCrawl: true,
      modelProvider: MODEL_PROVIDERS.HEURISTIC
    };

    const parsed = parseScanParams(params(buildScanSearch(options)));

    expect(parsed.url).toBe(options.url);
    expect(parsed.fullCrawl).toBe(true);
    expect(parsed.modelProvider).toBe(MODEL_PROVIDERS.HEURISTIC);
  });
});

describe('paths', () => {
  it('points a scan at /scan', () => {
    expect(buildScanPath({ url: 'https://example.com' })).toBe(
      '/scan?url=https%3A%2F%2Fexample.com'
    );
  });

  it('keeps the demo path short enough to quote', () => {
    expect(buildDemoPath()).toBe('/scan?url=demo');
  });
});
