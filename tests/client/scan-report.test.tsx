import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AIScanner } from '@/components/AIScanner';
import { DevModeProvider } from '@/contexts/DevModeContext';
import { formAPI } from '@/services/api';
import type { AnalyzedForm, ScanResults } from '@/lib/scan-types';

/**
 * Coverage for the report half of the scanner: the score strip, the visual
 * tab and its form picker, the tabs, and the actions and error surface.
 *
 * Written ahead of splitting `/` and `/scan` into separate pages, which moves
 * all of this into a `ScanResults` component (see docs/page-split-plan.md).
 * Everything here therefore goes through the rendered output rather than the
 * component's internals, so the same assertions should hold after the move.
 * If one of these breaks during that refactor, it broke the behaviour.
 */
vi.mock('@/services/api', () => ({
  formAPI: {
    startScan: vi.fn(),
    startDemo: vi.fn(),
    getReport: vi.fn(),
    analyzeForm: vi.fn()
  }
}));

const startScanMock = vi.mocked(formAPI.startScan);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

/** A scored form with no field-level findings. */
const form = (overrides: Partial<AnalyzedForm> = {}): AnalyzedForm => ({
  formId: 'contact-form',
  url: 'https://example.com/contact',
  accessibility: {
    score: 80,
    fieldIssues: []
  },
  ...overrides
});

/**
 * Drives a scan to completion through the form, so the report is reached the
 * way a visitor reaches it. The immediate-results branch is used because it
 * needs no polling.
 */
const renderReport = async (
  // devMode rides on the scan response rather than the results type, and
  // drives the sample labelling.
  results: Partial<ScanResults> & { devMode?: boolean } = {}
) => {
  startScanMock.mockResolvedValue({
    success: true,
    scanType: 'single-page',
    devMode: false,
    summary: { totalPages: 1, totalForms: 1 },
    forms: [form()],
    ...results
  } as never);

  render(
    <MemoryRouter initialEntries={['/']}>
      <DevModeProvider>
        <AIScanner />
      </DevModeProvider>
    </MemoryRouter>
  );

  fireEvent.change(screen.getByLabelText('Website URL for AI form analysis'), {
    target: { value: 'https://example.com' }
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start AI form analysis' }));
  });
};

/**
 * mouseDown, not click: the tabs activate on pointer-down, so a synthetic
 * click leaves the panel unchanged and every assertion after it passes for
 * the wrong reason.
 */
const openDetails = async () => {
  await act(async () => {
    fireEvent.mouseDown(screen.getByRole('tab', { name: /details/i }));
  });
};

describe('report score strip', () => {
  it('shows a single form score as the compatibility figure', async () => {
    await renderReport({ forms: [form({ accessibility: { score: 74, fieldIssues: [] } })] });

    expect(screen.getByText('74%')).toBeInTheDocument();
    expect(screen.getByText('AI compatibility')).toBeInTheDocument();
  });

  it('averages several forms and says so', async () => {
    await renderReport({
      forms: [
        form({ accessibility: { score: 90, fieldIssues: [] } }),
        form({ formId: 'b', accessibility: { score: 71, fieldIssues: [] } })
      ],
      summary: { totalPages: 1, totalForms: 2 }
    });

    // 161 / 2 = 80.5, rounded.
    expect(screen.getByText('81%')).toBeInTheDocument();
    expect(screen.getByText('Average AI compatibility')).toBeInTheDocument();
  });

  it('omits the figure when no form carries a score', async () => {
    await renderReport({ forms: [form({ accessibility: { fieldIssues: [] } })] });

    expect(screen.queryByText(/AI compatibility/)).not.toBeInTheDocument();
  });

  it('counts the forms it analysed and the pages they came from', async () => {
    await renderReport({
      forms: [form(), form({ formId: 'b' })],
      summary: { totalPages: 3, totalForms: 2 }
    });

    expect(screen.getByText(/Forms analyzed on 3 pages/)).toBeInTheDocument();
  });

  it('keeps the page count singular for one page', async () => {
    await renderReport({ summary: { totalPages: 1, totalForms: 1 } });

    expect(screen.getByText(/Form analyzed on 1 page$/)).toBeInTheDocument();
  });

  it('totals field issues by severity across every form', async () => {
    await renderReport({
      forms: [
        form({
          accessibility: {
            score: 50,
            fieldIssues: [
              { field: 'email', severity: 'high', issue: 'no label' },
              { field: 'name', severity: 'low', issue: 'vague placeholder' }
            ]
          }
        }),
        form({
          formId: 'b',
          accessibility: {
            score: 50,
            fieldIssues: [{ field: 'phone', severity: 'high', issue: 'no label' }]
          }
        })
      ],
      summary: { totalPages: 1, totalForms: 2 }
    });

    expect(screen.getByText(/^2 /)).toBeInTheDocument();
    expect(screen.queryByText(/No issues found/)).not.toBeInTheDocument();
  });

  it('says so plainly when there is nothing to report', async () => {
    await renderReport();

    // A row of three zeroes reads as a broken count rather than a clean bill.
    expect(screen.getByText(/No issues found/)).toBeInTheDocument();
  });
});

describe('report visual tab', () => {
  it('opens on the visual, not the numbers', async () => {
    await renderReport();

    expect(screen.getByRole('tab', { name: /visual/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('explains an empty result rather than showing a blank panel', async () => {
    await renderReport({ forms: [], summary: { totalPages: 1, totalForms: 0 } });

    expect(
      screen.getByText(/No forms were found on this page/)
    ).toBeInTheDocument();
  });

  it('stacks a handful of forms with no picker', async () => {
    await renderReport({
      forms: [form(), form({ formId: 'b' }), form({ formId: 'c' })],
      summary: { totalPages: 1, totalForms: 3 }
    });

    expect(screen.getByRole('heading', { name: 'Form 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Form 3' })).toBeInTheDocument();
    expect(screen.queryByText(/Form 1 of 3/)).not.toBeInTheDocument();
  });

  it('switches to a picker once stacking would be unnavigable', async () => {
    await renderReport({
      forms: [form(), form({ formId: 'b' }), form({ formId: 'c' }), form({ formId: 'd' })],
      summary: { totalPages: 1, totalForms: 4 }
    });

    // A full crawl can return fourteen; stacking those is unusable.
    expect(screen.getByText(/Form 1 of 4/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Form 1' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Form 4' })).not.toBeInTheDocument();
  });

  it('shows the form the picker selects', async () => {
    await renderReport({
      forms: [
        form({ accessibility: { score: 10, fieldIssues: [] } }),
        form({ formId: 'b' }),
        form({ formId: 'c' }),
        form({ formId: 'd', accessibility: { score: 44, fieldIssues: [] } })
      ],
      summary: { totalPages: 1, totalForms: 4 }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '4' }));
    });

    expect(screen.getByRole('heading', { name: 'Form 4' })).toBeInTheDocument();
    expect(screen.getByText('44/100')).toBeInTheDocument();
    expect(screen.getByText(/Form 4 of 4/)).toBeInTheDocument();
  });

  it('marks which picker entry is current', async () => {
    await renderReport({
      forms: [form(), form({ formId: 'b' }), form({ formId: 'c' }), form({ formId: 'd' })],
      summary: { totalPages: 1, totalForms: 4 }
    });

    expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'false');
  });

  it('labels each form with its own score and identifier', async () => {
    await renderReport({
      forms: [form({ formId: 'signup', accessibility: { score: 63, fieldIssues: [] } })]
    });

    expect(screen.getByText('signup')).toBeInTheDocument();
    expect(screen.getByText('63/100')).toBeInTheDocument();
  });
});

describe('report details tab', () => {
  it('holds the written summary behind Details', async () => {
    await renderReport({
      forms: [form()],
      summary: { totalPages: 1, totalForms: 1, aiSummary: 'One form, mostly fine.' }
    });

    // The visual is what should land on screen; prose and numbers wait.
    expect(screen.queryByText('One form, mostly fine.')).not.toBeInTheDocument();

    await openDetails();

    expect(screen.getByText('One form, mostly fine.')).toBeInTheDocument();
  });

  it('decomposes the score into the categories that produced it', async () => {
    await renderReport({
      forms: [
        form({
          accessibility: {
            score: 57,
            fieldIssues: [],
            categories: {
              dataTypes: { score: 2, maxScore: 15 },
              identification: { score: 16, maxScore: 20 }
            }
          }
        })
      ]
    });

    await openDetails();

    // Replaces "AI Agent Success Rates", four bars whose values were the one
    // score minus 10, 5, 0 and 15. These are the real scored categories.
    expect(screen.getByText('Where the 57 comes from')).toBeInTheDocument();
    expect(screen.getByText('Data types')).toBeInTheDocument();
    expect(screen.getByText('2/15')).toBeInTheDocument();
    expect(screen.getByText('16/20')).toBeInTheDocument();
  });

  it('puts the biggest loss at the top of the breakdown', async () => {
    await renderReport({
      forms: [
        form({
          accessibility: {
            score: 40,
            fieldIssues: [],
            categories: {
              submission: { score: 9, maxScore: 10 },
              identification: { score: 2, maxScore: 20 }
            }
          }
        })
      ]
    });

    await openDetails();

    const labels = screen
      .getAllByText(/^(Submission|Identification)$/)
      .map((node) => node.textContent);

    expect(labels).toEqual(['Identification', 'Submission']);
  });

  it('no longer claims to have measured discovery or data entry', async () => {
    await renderReport({
      forms: [form({ accessibility: { score: 80, fieldIssues: [], categories: {} } })]
    });

    await openDetails();

    // Nothing measured these. They were arithmetic on the one score,
    // presented as success rates.
    expect(screen.queryByText(/AI Agent Success Rates/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Form Discovery/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI Compatibility Distribution/i)).not.toBeInTheDocument();
  });

  it('reads the summary from the top level as well as from summary', async () => {
    // The full-crawl and single-page agents disagree about where this lives,
    // and the normalizer is what reconciles them.
    await renderReport({
      forms: [form()],
      aiSummary: 'Top-level summary.',
      summary: { totalPages: 1, totalForms: 1 }
    });

    await openDetails();

    expect(screen.getByText('Top-level summary.')).toBeInTheDocument();
  });
});

describe('report failure surface', () => {
  const renderFailure = async (job: Record<string, unknown>) => {
    startScanMock.mockResolvedValue({ jobId: 'job-9' } as never);
    vi.mocked(formAPI.getReport).mockResolvedValue({
      id: 'job-9',
      url: 'https://example.com',
      status: 'failed',
      progress: 0,
      currentStep: 'Failed',
      createdAt: '2024-01-01T00:00:00.000Z',
      ...job
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <DevModeProvider>
          <AIScanner />
        </DevModeProvider>
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('Website URL for AI form analysis'), {
      target: { value: 'https://example.com' }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start AI form analysis' }));
    });
  };

  it('shows what went wrong rather than an empty report', async () => {
    await renderFailure({ error: 'Navigation timed out after 30000ms' });

    expect(screen.getByText('Navigation timed out after 30000ms')).toBeInTheDocument();
  });

  it('points a keyless visitor at Dev Mode', async () => {
    await renderFailure({ error: 'MODEL_API_KEY is not set', devMode: false });

    // The most common first failure is no API keys, and the fix is one
    // toggle away.
    expect(screen.getByText(/No API keys yet\?/)).toBeInTheDocument();
  });

  it('does not suggest Dev Mode to someone already in it', async () => {
    await renderFailure({ error: 'Fixture missing', devMode: true });

    expect(screen.queryByText(/No API keys yet\?/)).not.toBeInTheDocument();
  });

  it('offers no PDF when there is nothing to export', async () => {
    await renderFailure({ error: 'Navigation timed out' });

    expect(screen.queryByRole('button', { name: /download pdf/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /scan another form/i })).toBeInTheDocument();
  });
});

describe('report actions', () => {
  it('offers the PDF once there are results to put in it', async () => {
    await renderReport();

    expect(screen.getByRole('button', { name: /download pdf/i })).toBeInTheDocument();
  });

  it('always offers a way to start over', async () => {
    await renderReport();

    expect(screen.getByRole('button', { name: /scan another form/i })).toBeInTheDocument();
  });

  it('names the target and the job it ran as', async () => {
    await renderReport();

    const details = screen.getByText('Target URL:').parentElement as HTMLElement;

    expect(within(details).getByText('https://example.com/')).toBeInTheDocument();
    expect(screen.getByText('Job ID:')).toBeInTheDocument();
  });
});

/**
 * The report header. Its whole reason for existing is that "New Scan" used to
 * sit at y=715 inside the progress card on a 3,200px page, so the quickest
 * way to run another scan was the browser's Back button.
 */
describe('report header', () => {
  it('carries the score and both actions', async () => {
    await renderReport({
      forms: [form({ accessibility: { score: 57, fieldIssues: [] } })]
    });

    expect(screen.getByText('57')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /scan another form/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download pdf/i })).toBeInTheDocument();
  });

  it('names the target and what was scanned', async () => {
    await renderReport({
      forms: [form(), form({ formId: 'b' })],
      summary: { totalPages: 1, totalForms: 2 }
    });

    expect(screen.getByText(/https:\/\/example\.com\/ · 2 forms/)).toBeInTheDocument();
  });

  it('replaces the progress card rather than sitting under it', async () => {
    await renderReport();

    // 620px of progress reporting about a finished scan used to come first.
    expect(screen.queryByText('AI Scan Progress')).not.toBeInTheDocument();
    expect(screen.queryByText(/Per-Form Analysis Progress/)).not.toBeInTheDocument();
    expect(screen.getByText('Scan complete')).toBeInTheDocument();
  });

  it('keeps the job id reachable without spending space on it', async () => {
    await renderReport();

    // Collapsed into a disclosure rather than deleted: still there for a bug
    // report, no longer three columns above the results.
    expect(screen.getByText('Job ID:')).toBeInTheDocument();
    expect(screen.getByText(/scan details/i)).toBeInTheDocument();
  });

  it('marks a sample run in the pinned bar', async () => {
    await renderReport({ devMode: true });

    // The bar is the part most likely to be screenshotted on its own.
    expect(screen.getAllByText('Sample').length).toBeGreaterThan(0);
  });
});

describe('report findings list', () => {
  const twoForms = [
    form({
      accessibility: {
        score: 57,
        fieldIssues: [
          { field: 'fullName', severity: 'high', issue: 'No id and no autocomplete token' },
          { field: 'phoneNumber', severity: 'low', issue: 'No autocomplete tel' }
        ],
        formFindings: [{ severity: 'medium', issue: 'Visual order fights DOM order' }]
      }
    }),
    form({
      formId: 'form-signin',
      accessibility: {
        score: 34,
        fieldIssues: [{ field: 'password', severity: 'high', issue: 'No autocomplete token' }]
      }
    })
  ];

  it('lists every finding from every form in one place', async () => {
    await renderReport({ forms: twoForms, summary: { totalPages: 1, totalForms: 2 } });

    await openDetails();

    expect(screen.getByText('4 findings')).toBeInTheDocument();
    expect(screen.getByText('No id and no autocomplete token')).toBeInTheDocument();
    expect(screen.getByText('No autocomplete token')).toBeInTheDocument();
  });

  it('says which form each finding came from', async () => {
    await renderReport({ forms: twoForms, summary: { totalPages: 1, totalForms: 2 } });

    await openDetails();

    // Flattening must not lose the form, or a finding is unactionable.
    // Scoped to the row, since the per-form cards below are also headed
    // "Form 2".
    const row = screen.getByText('No autocomplete token').closest('li') as HTMLElement;

    expect(within(row).getByText('Form 2')).toBeInTheDocument();
    expect(within(row).getByText('password')).toBeInTheDocument();
  });

  it('marks a whole-form finding as having no single control', async () => {
    await renderReport({ forms: twoForms, summary: { totalPages: 1, totalForms: 2 } });

    await openDetails();

    expect(screen.getByText('Whole form')).toBeInTheDocument();
  });

  it('narrows to one severity on request', async () => {
    await renderReport({ forms: twoForms, summary: { totalPages: 1, totalForms: 2 } });

    await openDetails();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /high 2/i }));
    });

    expect(screen.getByText('No id and no autocomplete token')).toBeInTheDocument();
    expect(screen.queryByText('No autocomplete tel')).not.toBeInTheDocument();
  });

  it('reports a clean form as clean rather than as empty', async () => {
    await renderReport({ forms: [form({ accessibility: { score: 95, fieldIssues: [] } })] });

    await openDetails();

    expect(screen.getByText(/Nothing to fix/)).toBeInTheDocument();
  });
});

/**
 * Guards two layout bugs that only showed up in a browser, both of which made
 * the pinned header unclickable. jsdom has no layout, so these assert the
 * classes that carry the decisions rather than the geometry. Brittle by
 * nature, but the alternative is a button that looks present and cannot be
 * pressed, which is worse than the buried one it replaced.
 */
describe('report header pinning', () => {
  const stickyBar = () =>
    screen.getByRole('button', { name: /scan another form/i }).closest('div.sticky');

  it('clears the fixed site header rather than parking behind it', async () => {
    await renderReport();

    // Measured at top-0: the bar sat at viewport y=18-54 with the 64px fixed
    // header over it, and elementFromPoint returned the header.
    expect(stickyBar()).toHaveClass('top-16');
  });

  it('does not let the sample strip pin on top of it', async () => {
    await renderReport({ devMode: true });

    // Both pinned at top-16 and the strip won on z-index, swallowing clicks
    // meant for "Scan another form". The bar's own SAMPLE badge carries the
    // labelling once the report is up.
    const strip = screen.getByRole('status');

    expect(strip).not.toHaveClass('sticky');
    expect(stickyBar()).toHaveClass('sticky');
  });
});

/**
 * The score strip and the findings list must agree.
 *
 * They did not. The strip ran its own inline reduce over `fieldIssues` only,
 * while the list collected `fieldIssues` plus `formFindings`, so the live
 * sample showed "5 high, 4 medium, 7 low" at the top of the report and
 * "20 findings" under Details -- the four whole-form findings counted in one
 * place and not the other. Both now go through `collectFindings`.
 */
describe('report finding totals agree', () => {
  const mixedForms = [
    form({
      accessibility: {
        score: 57,
        fieldIssues: [
          { field: 'a', severity: 'high', issue: 'field high' },
          { field: 'b', severity: 'low', issue: 'field low' }
        ],
        formFindings: [
          { severity: 'high', issue: 'whole-form high' },
          { severity: 'medium', issue: 'whole-form medium' }
        ]
      }
    }),
    form({
      formId: 'second',
      accessibility: {
        score: 34,
        fieldIssues: [{ field: 'c', severity: 'low', issue: 'another field low' }],
        formFindings: [{ severity: 'low', issue: 'whole-form low' }]
      }
    })
  ];

  /**
   * The strip's badges read "<count> <label>". Matched on exact trimmed text
   * and taking the innermost hit, because an ancestor wrapping only that
   * badge matches the same string.
   */
  const stripBadge = (text: string) => {
    const matches = screen.getAllByText(
      (_, element) => element?.textContent?.trim() === text
    );

    return matches[matches.length - 1];
  };

  it('counts whole-form findings in the score strip, not just field ones', async () => {
    await renderReport({ forms: mixedForms, summary: { totalPages: 1, totalForms: 2 } });

    // 2 high (1 field + 1 whole-form), 1 medium (whole-form only),
    // 3 low (2 field + 1 whole-form). The old strip counted field issues
    // alone and would have said 1 high, 0 medium, 2 low.
    expect(stripBadge('2 high')).toBeInTheDocument();
    expect(stripBadge('1 medium')).toBeInTheDocument();
    expect(stripBadge('3 low')).toBeInTheDocument();
  });

  it('reports the same total in both places', async () => {
    await renderReport({ forms: mixedForms, summary: { totalPages: 1, totalForms: 2 } });

    await openDetails();

    // Six findings in total: three field-level and three whole-form.
    expect(screen.getByText('6 findings')).toBeInTheDocument();

    const [highFilter] = screen.getAllByRole('button', { name: /high 2/i });

    // The filter counts come from the same place as the strip's badges, so
    // agreeing here is the invariant that was broken.
    expect(highFilter).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /medium 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /low 3/i })).toBeInTheDocument();
  });

  it('still shows the row when one severity is zero but others are not', async () => {
    // The shape a real scan of httpbin produced: 11 findings, 10 low and
    // 1 medium, no high at all. The row must still appear -- collapsing to
    // "No issues found" here would claim a clean bill for a form with
    // eleven things wrong with it.
    await renderReport({
      forms: [
        form({
          accessibility: {
            score: 75,
            fieldIssues: [
              ...Array.from({ length: 10 }, (_, index) => ({
                field: `f${index}`,
                severity: 'low' as const,
                issue: `low ${index}`
              })),
              { field: 'g', severity: 'medium' as const, issue: 'one medium' }
            ]
          }
        })
      ]
    });

    expect(stripBadge('0 high')).toBeInTheDocument();
    expect(stripBadge('1 medium')).toBeInTheDocument();
    expect(stripBadge('10 low')).toBeInTheDocument();
    expect(screen.queryByText(/No issues found/)).not.toBeInTheDocument();
  });

  it('calls a clean report clean without claiming only fields were checked', async () => {
    await renderReport({
      forms: [form({ accessibility: { score: 96, fieldIssues: [], formFindings: [] } })]
    });

    // Scoped to the strip's own badge: "field-level" is still the right
    // wording in the per-form overlay, which genuinely shows only those.
    expect(stripBadge('No issues found')).toBeInTheDocument();
  });
});
