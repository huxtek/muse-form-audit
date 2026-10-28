import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression cover for two real defects.
 *
 * 1. `addExecutiveSummary` used to read `data.analysis?.*`, a field nothing
 *    ever populated, so every generated PDF printed the fallbacks
 *    "Pages Analyzed: 1 / Forms Found: 0 / Site Coverage: 100% / URLs
 *    Discovered: 1" no matter what the scan found. It now reads
 *    `data.summary?.*`.
 * 2. A mock-data report that is not labelled as such is indistinguishable from
 *    a real audit once it leaves the browser.
 *
 * jsPDF is replaced with a recorder so the assertions read the text the
 * generator emits, rather than inflating a binary PDF.
 */

const emitted = vi.hoisted(() => [] as string[]);

vi.mock('jspdf', () => {
  class FakeJsPdf {
    private pages = 1;

    text(value: string) {
      emitted.push(value);
    }

    setFontSize() {}
    setFont() {}
    setTextColor() {}
    setDrawColor() {}
    setFillColor() {}
    rect() {}
    line() {}
    setPage() {}
    save() {}

    // The sample-data notice is boxed, so it needs the page width. A line of
    // plain body copy is the first thing skimmed past in a forwarded PDF.
    internal = {
      pageSize: {
        getWidth: () => 210,
        getHeight: () => 297
      }
    };

    addPage() {
      this.pages += 1;
    }

    getNumberOfPages() {
      return this.pages;
    }

    splitTextToSize(value: string) {
      return String(value).split('\n');
    }
  }

  return { default: FakeJsPdf };
});

const { PDFGenerator } = await import('@/lib/pdf-generator');
type ReportData = Parameters<InstanceType<typeof PDFGenerator>['generateReport']>[0];

const reportWith = (overrides: Partial<ReportData> = {}): ReportData =>
  ({
    summary: {
      totalPages: 24,
      totalForms: 14,
      discoveredUrls: 24,
      visitedUrls: 24,
      coveragePercentage: 96
    },
    forms: [],
    aiSummary: 'Fourteen forms were analyzed.',
    scanMode: 'full-crawl',
    targetUrl: 'https://example.com/',
    ...overrides
  }) as ReportData;

/** Everything the generator wrote, as one searchable blob. */
const renderedText = () => emitted.join('\n');

beforeEach(() => {
  emitted.length = 0;
});

describe('PDFGenerator executive summary', () => {
  it('reports the values from `summary`, not the old fallbacks', () => {
    new PDFGenerator().generateReport(reportWith(), 'job-abc');

    const text = renderedText();

    expect(text).toContain('Pages Analyzed: 24');
    expect(text).toContain('Forms Found: 14');
    expect(text).toContain('Site Coverage: 96%');
    expect(text).toContain('URLs Discovered: 24');

    expect(text).not.toContain('Pages Analyzed: 1');
    expect(text).not.toContain('Forms Found: 0');
    expect(text).not.toContain('Site Coverage: 100%');
    expect(text).not.toContain('URLs Discovered: 1');
  });

  it('reports a single-page scan without inflating the numbers', () => {
    new PDFGenerator().generateReport(
      reportWith({
        summary: {
          totalPages: 1,
          totalForms: 3,
          discoveredUrls: 1,
          visitedUrls: 1,
          coveragePercentage: 100
        },
        scanMode: 'single-page'
      }),
      'job-single'
    );

    const text = renderedText();

    expect(text).toContain('Pages Analyzed: 1');
    expect(text).toContain('Forms Found: 3');
    expect(text).toContain('Scan Mode: Single Page Analysis');
  });

  it('still emits the fallbacks when no summary is present at all', () => {
    new PDFGenerator().generateReport(
      reportWith({ summary: undefined as unknown as ReportData['summary'] }),
      'job-empty'
    );

    const text = renderedText();

    expect(text).toContain('Pages Analyzed: 1');
    expect(text).toContain('Forms Found: 0');
  });
});

describe('PDFGenerator mock-data labelling', () => {
  it('marks the report when isMockData is true', () => {
    new PDFGenerator().generateReport(reportWith({ isMockData: true }), 'job-mock');

    expect(renderedText()).toContain('SAMPLE DATA - describes a fictional site, not a real audit');
  });

  it('omits the marker for a real scan', () => {
    new PDFGenerator().generateReport(reportWith({ isMockData: false }), 'job-real');

    expect(renderedText()).not.toContain('MOCK DATA');
  });

  it('omits the marker when the flag is absent', () => {
    new PDFGenerator().generateReport(reportWith(), 'job-real');

    expect(renderedText()).not.toContain('MOCK DATA');
  });
});

describe('PDFGenerator report framing', () => {
  it('stamps the job ID into the footer of every page', () => {
    new PDFGenerator().generateReport(reportWith(), 'job-abc');

    expect(renderedText()).toContain('Muse Form Audit Report - Job ID: job-abc');
  });

  it('includes the target URL and the AI summary', () => {
    new PDFGenerator().generateReport(reportWith(), 'job-abc');

    const text = renderedText();

    expect(text).toContain('Analysis of https://example.com/');
    expect(text).toContain('Fourteen forms were analyzed.');
  });
});
