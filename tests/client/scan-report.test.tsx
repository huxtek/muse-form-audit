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
const renderReport = async (results: Partial<ScanResults> = {}) => {
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
    expect(screen.queryByText(/No field-level issues/)).not.toBeInTheDocument();
  });

  it('says so plainly when there is nothing to report', async () => {
    await renderReport();

    // A row of three zeroes reads as a broken count rather than a clean bill.
    expect(screen.getByText(/No field-level issues/)).toBeInTheDocument();
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

  it('shows the scored breakdown there too', async () => {
    await renderReport({
      forms: [form({ accessibility: { score: 80, fieldIssues: [] } })]
    });

    await openDetails();

    expect(screen.getByText(/AI Agent Performance Analysis/i)).toBeInTheDocument();
    expect(screen.getByText(/Individual Form Analysis/i)).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: /new scan/i })).toBeInTheDocument();
  });
});

describe('report actions', () => {
  it('offers the PDF once there are results to put in it', async () => {
    await renderReport();

    expect(screen.getByRole('button', { name: /download pdf report/i })).toBeInTheDocument();
  });

  it('always offers a way to start over', async () => {
    await renderReport();

    expect(screen.getByRole('button', { name: /new scan/i })).toBeInTheDocument();
  });

  it('names the target and the job it ran as', async () => {
    await renderReport();

    const details = screen.getByText('Target URL:').parentElement as HTMLElement;

    expect(within(details).getByText('https://example.com')).toBeInTheDocument();
    expect(screen.getByText('Job ID:')).toBeInTheDocument();
  });
});
