import { describe, expect, it } from 'vitest';

import { getNormalizedResults } from '@/lib/scan-results';

/**
 * Regression cover for the contract mismatch that crashed PDF export on every
 * single-page scan: the full-crawl agent puts aiSummary/scanMode/targetUrl at
 * the top level of `results`, while the per-form agent nests aiSummary and
 * scanMode under `results.summary` and names the target `url`.
 */
describe('getNormalizedResults', () => {
  it('reads the full-crawl shape from the top level of results', () => {
    const normalized = getNormalizedResults({
      url: 'https://submitted.example',
      devMode: false,
      results: {
        aiSummary: 'Crawled 24 pages.',
        scanMode: 'full-crawl',
        targetUrl: 'https://crawled.example/'
      }
    });

    expect(normalized.aiSummary).toBe('Crawled 24 pages.');
    expect(normalized.scanMode).toBe('full-crawl');
    expect(normalized.targetUrl).toBe('https://crawled.example/');
    expect(normalized.isMockData).toBe(false);
  });

  it('reads the single-page shape nested under results.summary', () => {
    const normalized = getNormalizedResults({
      url: 'https://submitted.example',
      devMode: false,
      results: {
        url: 'https://scanned.example/contact',
        summary: {
          aiSummary: 'One contact form found.',
          scanMode: 'single-page'
        }
      }
    });

    expect(normalized.aiSummary).toBe('One contact form found.');
    expect(normalized.scanMode).toBe('single-page');
    expect(normalized.targetUrl).toBe('https://scanned.example/contact');
  });

  it('treats any scanMode other than full-crawl as single-page', () => {
    expect(getNormalizedResults({ results: { scanMode: 'something-else' } }).scanMode).toBe(
      'single-page'
    );
    expect(getNormalizedResults({ results: {} }).scanMode).toBe('single-page');
  });

  it('prefers the top-level fields when both shapes are present', () => {
    const normalized = getNormalizedResults({
      results: {
        aiSummary: 'top level',
        scanMode: 'full-crawl',
        targetUrl: 'https://top.example/',
        url: 'https://nested.example/',
        summary: { aiSummary: 'nested', scanMode: 'single-page' }
      }
    });

    expect(normalized.aiSummary).toBe('top level');
    expect(normalized.scanMode).toBe('full-crawl');
    expect(normalized.targetUrl).toBe('https://top.example/');
  });

  it('falls back to the job URL when results carry no target', () => {
    const normalized = getNormalizedResults({
      url: 'https://submitted.example/page',
      results: {}
    });

    expect(normalized.targetUrl).toBe('https://submitted.example/page');
  });

  it('preserves every other field on results', () => {
    const normalized = getNormalizedResults({
      results: {
        scanMode: 'full-crawl',
        summary: { totalPages: 24, totalForms: 14 },
        forms: [{ formId: 'form-1' }]
      }
    } as Parameters<typeof getNormalizedResults>[0]);

    expect(normalized.summary).toEqual({ totalPages: 24, totalForms: 14 });
    expect(normalized.forms).toEqual([{ formId: 'form-1' }]);
  });

  it('marks the report as mock data only when the job says so', () => {
    expect(getNormalizedResults({ devMode: true, results: {} }).isMockData).toBe(true);
    expect(getNormalizedResults({ devMode: false, results: {} }).isMockData).toBe(false);
    expect(getNormalizedResults({ results: {} }).isMockData).toBe(false);
  });

  it('returns safe defaults for an empty or missing job', () => {
    for (const job of [undefined, null, {}]) {
      const normalized = getNormalizedResults(job);

      expect(normalized.aiSummary).toBe('');
      expect(normalized.scanMode).toBe('single-page');
      expect(normalized.targetUrl).toBe('');
      expect(normalized.isMockData).toBe(false);
    }
  });
});
