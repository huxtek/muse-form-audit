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

/**
 * The PDF and the report page must say the same thing, because they are two
 * renderings of one scan and the PDF is the copy that gets forwarded.
 *
 * They did not. The page showed `accessibility.score` and the findings from
 * `fieldIssues`/`formFindings`; the PDF computed a private
 * 100-minus-penalties figure and listed only the `issues`/`recommendations`
 * strings. On the sample they disagreed on every form, and the newsletter
 * form printed 100/100 in the PDF while the page scored it 78 with three
 * findings against it.
 *
 * Both now read `@/lib/report-data`, so these assert the shared result
 * reaches the page's numbers rather than re-deriving anything.
 */
const scoredForms = [
  {
    formId: 'form-0',
    accessibility: {
      score: 57,
      categories: {
        structural: { score: 9, maxScore: 15 },
        identification: { score: 16, maxScore: 20 },
        dataTypes: { score: 2, maxScore: 15 }
      },
      fieldIssues: [
        { field: 'fullName', severity: 'high', issue: 'No id and no autocomplete token' },
        { field: 'phoneNumber', severity: 'low', issue: 'No autocomplete tel' }
      ],
      formFindings: [{ severity: 'medium', issue: 'Visual order fights DOM order' }]
    }
  },
  {
    formId: 'form-signin',
    accessibility: {
      score: 34,
      categories: { structural: { score: 6, maxScore: 15 } },
      fieldIssues: [{ field: 'password', severity: 'high', issue: 'No autocomplete token' }]
    }
  }
];

describe('PDFGenerator score', () => {
  it('prints the score the analysis produced', () => {
    new PDFGenerator().generateReport(
      reportWith({ forms: scoredForms as never }),
      'job-1'
    );

    // (57 + 34) / 2, the same average the report strip shows.
    expect(renderedText()).toContain('46/100');
    expect(renderedText()).toContain('averaged across 2 forms');
  });

  it('no longer prints a second, invented score beside it', () => {
    new PDFGenerator().generateReport(
      reportWith({ forms: scoredForms as never }),
      'job-1'
    );

    // The old figure was 100 minus 50 for a CAPTCHA, 30 for missing name
    // attributes, 20 for missing labels and 15 for a file upload. With no
    // aiAccessibility at all it scored every form a clean 100.
    expect(renderedText()).not.toContain('Accessibility Score:');
    expect(renderedText()).not.toContain('100/100');
  });

  it('breaks the score into the categories that produced it', () => {
    new PDFGenerator().generateReport(
      reportWith({ forms: scoredForms as never }),
      'job-1'
    );

    const text = renderedText();

    expect(text).toContain('Where the points went');
    // Structural is summed across both forms: 9 + 6 of 15 + 15.
    expect(text).toContain('15/30');
    expect(text).toContain('Data types');
  });

  it('survives a form with no accessibility block at all', () => {
    // This used to throw and take the whole download with it: the old score
    // read form.characteristics.hasCaptcha and
    // form.accessibility.aiAccessibility.hasNameAttributes unguarded, both
    // optional in scan-types.
    expect(() =>
      new PDFGenerator().generateReport(
        reportWith({ forms: [{ formId: 'bare' }] as never }),
        'job-1'
      )
    ).not.toThrow();
  });
});

describe('PDFGenerator findings', () => {
  it('lists every finding the report page lists, worst first', () => {
    new PDFGenerator().generateReport(
      reportWith({ forms: scoredForms as never }),
      'job-1'
    );

    const text = renderedText();

    expect(text).toContain('FINDINGS (4)');
    expect(text).toContain('2 high, 1 medium, 1 low');
    expect(text).toContain('No id and no autocomplete token');
    expect(text).toContain('Visual order fights DOM order');
    expect(text).toContain('No autocomplete tel');
  });

  it('orders them worst first, as the page does', () => {
    new PDFGenerator().generateReport(
      reportWith({ forms: scoredForms as never }),
      'job-1'
    );

    const text = renderedText();

    expect(text.indexOf('No id and no autocomplete token')).toBeLessThan(
      text.indexOf('Visual order fights DOM order')
    );
    expect(text.indexOf('Visual order fights DOM order')).toBeLessThan(
      text.indexOf('No autocomplete tel')
    );
  });

  it('says which form and which control each finding concerns', () => {
    new PDFGenerator().generateReport(
      reportWith({ forms: scoredForms as never }),
      'job-1'
    );

    const text = renderedText();

    expect(text).toContain('[HIGH] Form 1 / fullName');
    expect(text).toContain('[HIGH] Form 2 / password');
    expect(text).toContain('[MED] Form 1 / whole form');
  });

  it('omits the section when there is nothing to fix', () => {
    new PDFGenerator().generateReport(
      reportWith({
        forms: [{ formId: 'clean', accessibility: { score: 98, fieldIssues: [] } }] as never
      }),
      'job-1'
    );

    expect(renderedText()).not.toContain('FINDINGS');
  });
});

describe('PDFGenerator text encoding', () => {
  it('substitutes punctuation it cannot encode instead of deleting it', () => {
    new PDFGenerator().generateReport(
      reportWith({
        forms: [
          {
            formId: 'f',
            accessibility: {
              score: 50,
              fieldIssues: [
                {
                  field: 'card',
                  severity: 'high',
                  // An em dash and curly quotes, which a model writes and
                  // which jsPDF's built-in fonts cannot encode.
                  issue: 'Add autocomplete=\u201Ccc-number\u201D \u2014 otherwise agents guess\u2026'
                }
              ]
            }
          }
        ] as never
      }),
      'job-1'
    );

    const text = renderedText();

    // Previously these vanished mid-sentence, leaving "autocompletecc-number
    // otherwise agents guess".
    expect(text).toContain('Add autocomplete="cc-number" - otherwise agents guess...');
  });
});
