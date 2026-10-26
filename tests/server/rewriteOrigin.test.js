import { describe, expect, it } from 'vitest';

import { rewriteOrigin } from '../../server/lib/rewriteOrigin.js';

/**
 * Mock scans re-point the bundled fixture at whatever site the user submitted.
 * Only the ORIGIN may be taken from the submitted URL: the fixture's own paths
 * are the only thing that makes the sample read like a real multi-page crawl,
 * and leaking the submitted path into every fixture URL would flatten them.
 */
describe('rewriteOrigin', () => {
  it('takes only the origin of the submitted URL, ignoring its path and query', () => {
    expect(
      rewriteOrigin(
        'https://acme-roofing.example/services/roof-replacement/',
        'https://example.com/deep/path?x=1'
      )
    ).toBe('https://example.com/services/roof-replacement/');
  });

  it('preserves the fixture pathname, search and hash', () => {
    expect(
      rewriteOrigin('https://acme-roofing.example/contact?step=2#form', 'https://example.com')
    ).toBe('https://example.com/contact?step=2#form');
  });

  it('carries over a non-default port from the submitted origin', () => {
    expect(rewriteOrigin('https://acme-roofing.example/quote', 'http://example.com:8080/')).toBe(
      'http://example.com:8080/quote'
    );
  });

  it('maps a fixture root to the submitted root', () => {
    expect(rewriteOrigin('https://acme-roofing.example/', 'https://example.com/pricing')).toBe(
      'https://example.com/'
    );
  });

  it('returns the fixture URL unchanged when the submitted URL is unparseable', () => {
    expect(rewriteOrigin('https://acme-roofing.example/quote', 'not-a-url')).toBe(
      'https://acme-roofing.example/quote'
    );
  });

  it('returns the input unchanged when the fixture URL is unparseable', () => {
    expect(rewriteOrigin('/relative/path', 'https://example.com')).toBe('/relative/path');
  });
});
