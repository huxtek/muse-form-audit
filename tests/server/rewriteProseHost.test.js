import { describe, expect, it } from 'vitest';

import {
  getFixtureHostname,
  rewriteProseHost,
  rewriteProseHostDeep
} from '../../server/lib/rewriteProseHost.js';

/**
 * Mock scans re-point the bundled fixture at whatever site the user submitted.
 * The structured rewrite only reaches known URL fields, so the fixture host
 * also has to be replaced inside prose: the single-page `aiSummary` sentence
 * quotes the scanned URL, and the crawl fixture's hidden page-title fields end
 * in `| <fixture host>`. The host is always derived from the fixture, never
 * hardcoded, so swapping the fixtures cannot silently break this.
 */
const FIXTURE_HOST = 'acme-roofing.example';
const SUBMITTED = 'https://example.com';

const rewrite = (text, submitted = SUBMITTED) => rewriteProseHost(text, FIXTURE_HOST, submitted);

describe('getFixtureHostname', () => {
  it('prefers the top-level url, the one field both bundled fixtures define', () => {
    expect(
      getFixtureHostname({
        url: 'https://acme-roofing.example/',
        results: { targetUrl: 'https://other.example/' }
      })
    ).toBe('acme-roofing.example');
  });

  it('falls back through results.targetUrl, results.url and metadata', () => {
    expect(getFixtureHostname({ results: { targetUrl: 'https://a.example/x' } })).toBe('a.example');
    expect(getFixtureHostname({ results: { url: 'https://b.example/x' } })).toBe('b.example');
    expect(getFixtureHostname({ results: { metadata: { targetUrl: 'https://c.example/' } } })).toBe(
      'c.example'
    );
    expect(getFixtureHostname({ results: { forms: [{ url: 'https://d.example/' }] } })).toBe(
      'd.example'
    );
  });

  it('returns null for a fixture with no parseable URL', () => {
    expect(getFixtureHostname({ url: 'not-a-url' })).toBeNull();
    expect(getFixtureHostname({})).toBeNull();
    expect(getFixtureHostname(undefined)).toBeNull();
  });
});

describe('rewriteProseHost', () => {
  it('re-bases a full URL inside prose, keeping path, query and hash', () => {
    expect(
      rewrite(
        'Comprehensive analysis of https://acme-roofing.example/services/?step=2#form completed.'
      )
    ).toBe('Comprehensive analysis of https://example.com/services/?step=2#form completed.');
  });

  it('uses only the ORIGIN of the submitted URL, never leaking its path', () => {
    expect(
      rewrite(
        'analysis of https://acme-roofing.example/ completed',
        'https://example.com/deep/path?x=1'
      )
    ).toBe('analysis of https://example.com/ completed');
  });

  it('replaces a bare fixture hostname with the submitted hostname', () => {
    expect(rewrite('Roof Inspection | FREE for Homes and Businesses | acme-roofing.example')).toBe(
      'Roof Inspection | FREE for Homes and Businesses | example.com'
    );
  });

  it('handles a full URL and a separate bare mention in the same string', () => {
    expect(
      rewrite('Scanned https://acme-roofing.example/services/ — titles read acme-roofing.example.')
    ).toBe('Scanned https://example.com/services/ — titles read example.com.');
  });

  it('returns a string that mentions neither byte-identical', () => {
    const untouched =
      'LABELING: Field showPriceInPoints lacks proper labeling, Field flexibleDates lacks proper labeling';

    expect(rewrite(untouched)).toBe(untouched);
  });

  it('leaves a longer hostname that merely contains the fixture host alone', () => {
    const nearMiss =
      'Referrer notacme-roofing.example.org and acme-roofing.example.org and acme-roofing.examples';

    expect(rewrite(nearMiss)).toBe(nearMiss);
  });

  it('leaves a full URL on a longer hostname alone', () => {
    const nearMiss = 'See https://acme-roofing.example.org/services/ for details';

    expect(rewrite(nearMiss)).toBe(nearMiss);
  });

  it('replaces a bare mention that ends a sentence, leaving the period in place', () => {
    expect(rewrite('Titles all end in acme-roofing.example.')).toBe(
      'Titles all end in example.com.'
    );
  });

  it('rewrites a URL that carries a port', () => {
    expect(rewrite('served from https://acme-roofing.example:8443/quote now')).toBe(
      'served from https://example.com/quote now'
    );
  });

  it('does not clip a bare mention out of a longer hyphenated token', () => {
    expect(rewrite('cdn-acme-roofing.example')).toBe('cdn-acme-roofing.example');
  });

  it('never double-rewrites, even when the submitted host contains the fixture host', () => {
    expect(
      rewrite(
        'analysis of https://acme-roofing.example/x/ completed',
        'https://cdn.acme-roofing.example'
      )
    ).toBe('analysis of https://cdn.acme-roofing.example/x/ completed');
  });

  it('does not swallow trailing sentence punctuation into the rewritten path', () => {
    expect(rewrite('See https://acme-roofing.example/contact/.')).toBe(
      'See https://example.com/contact/.'
    );
  });

  it('survives a fixture hostname full of regex metacharacters', () => {
    const text = 'host a+b(c).example and literal a+b(c).example only';

    expect(rewriteProseHost(text, 'a+b(c).example', SUBMITTED)).toBe(
      'host example.com and literal example.com only'
    );
    expect(rewriteProseHost('host aXbYcZ.example', 'a+b(c).example', SUBMITTED)).toBe(
      'host aXbYcZ.example'
    );
  });

  it('returns garbage and non-string input unchanged without throwing', () => {
    expect(rewrite('%%% not a url :// ???')).toBe('%%% not a url :// ???');
    expect(rewrite('acme-roofing.example', 'not-a-url')).toBe('acme-roofing.example');
    expect(rewriteProseHost(42, FIXTURE_HOST, SUBMITTED)).toBe(42);
    expect(rewriteProseHost(null, FIXTURE_HOST, SUBMITTED)).toBeNull();
    expect(rewriteProseHost('acme-roofing.example', null, SUBMITTED)).toBe('acme-roofing.example');
  });
});

describe('rewriteProseHostDeep', () => {
  it('rewrites string values anywhere in the tree and never object keys', () => {
    const tree = {
      'acme-roofing.example': 'Title | acme-roofing.example',
      nested: { forms: [{ value: 'https://acme-roofing.example/services/' }] },
      count: 14,
      flag: true,
      nothing: null
    };

    rewriteProseHostDeep(tree, FIXTURE_HOST, SUBMITTED);

    expect(Object.keys(tree)).toContain('acme-roofing.example');
    expect(tree['acme-roofing.example']).toBe('Title | example.com');
    expect(tree.nested.forms[0].value).toBe('https://example.com/services/');
    expect(tree.count).toBe(14);
    expect(tree.flag).toBe(true);
    expect(tree.nothing).toBeNull();
  });

  it('is idempotent, so running it after the structured rewrite cannot double-rewrite', () => {
    const once = { value: 'https://acme-roofing.example/services/ at acme-roofing.example' };

    rewriteProseHostDeep(once, FIXTURE_HOST, SUBMITTED);
    const afterFirst = once.value;
    rewriteProseHostDeep(once, FIXTURE_HOST, SUBMITTED);

    expect(once.value).toBe(afterFirst);
    expect(once.value).toBe('https://example.com/services/ at example.com');
  });
});
