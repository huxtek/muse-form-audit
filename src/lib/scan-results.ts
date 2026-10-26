import type { ReportData } from '@/lib/pdf-generator';

/** The two result shapes the backend can return, as far as this module cares. */
interface NormalizableResults {
  aiSummary?: string;
  scanMode?: string;
  summary?: {
    aiSummary?: string;
    scanMode?: string;
  };
  targetUrl?: string;
  url?: string;
}

/** The slice of a scan job record the normalizer reads. */
export interface NormalizableJob {
  url?: string;
  devMode?: boolean;
  results?: NormalizableResults;
}

/**
 * The full-crawl agent returns aiSummary/scanMode/targetUrl at the top level of
 * `results`, while the per-form (single page) agent nests them under
 * `results.summary` and uses `url`. Normalize both shapes for consumers.
 *
 * The declared return type is the PDF generator's payload because that is the
 * strictest consumer; the cast mirrors the looseness of the agent responses,
 * which carry no compile-time guarantee of `summary` or `forms`.
 */
export const getNormalizedResults = (job?: NormalizableJob | null): ReportData => {
  const results = job?.results;
  const scanMode = results?.scanMode || results?.summary?.scanMode;

  return {
    ...results,
    aiSummary: results?.aiSummary || results?.summary?.aiSummary || '',
    scanMode: scanMode === 'full-crawl' ? 'full-crawl' : 'single-page',
    targetUrl: results?.targetUrl || results?.url || job?.url || '',
    isMockData: job?.devMode === true
  } as ReportData;
};
