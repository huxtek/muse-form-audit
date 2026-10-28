import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AIScanner } from '@/components/AIScanner';
import { DevModeProvider } from '@/contexts/DevModeContext';
import { formAPI } from '@/services/api';

/**
 * Two failure modes that would ship unnoticed:
 *
 * - polling that never stops, leaving the spinner turning forever on a job the
 *   backend already finished or failed;
 * - mock results rendered without a mock marker, which reads as a real audit.
 *
 * Everything below drives the component through its accessible surface with
 * `formAPI` mocked and fake timers, so no HTTP and no wall-clock waiting.
 */

vi.mock('@/services/api', () => ({
  formAPI: {
    startScan: vi.fn(),
    getReport: vi.fn(),
    analyzeForm: vi.fn()
  }
}));

const startScanMock = vi.mocked(formAPI.startScan);
const getReportMock = vi.mocked(formAPI.getReport);

const POLL_INTERVAL_MS = 2000;

/** A job record shaped like the one `/api/report/:jobId` returns. */
const jobRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'job-1',
  url: 'https://example.com',
  status: 'running',
  progress: 40,
  currentStep: 'Analyzing forms...',
  createdAt: '2024-01-01T00:00:00.000Z',
  ...overrides
});

/** Render the scanner, submit a URL, and settle the initial poll. */
const submitScan = async () => {
  render(
    <DevModeProvider>
      <AIScanner />
    </DevModeProvider>
  );

  fireEvent.change(screen.getByLabelText('Website URL for AI form analysis'), {
    target: { value: 'https://example.com' }
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start AI form analysis' }));
  });
};

/** Let the polling loop fire `count` more times. */
const advancePolls = async (count: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * count + 50);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  startScanMock.mockReset();
  getReportMock.mockReset();
  startScanMock.mockResolvedValue({ success: true, jobId: 'job-1' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AIScanner polling', () => {
  it('keeps polling while the job is running', async () => {
    getReportMock.mockResolvedValue(jobRecord({ status: 'running' }));

    await submitScan();

    expect(getReportMock).toHaveBeenCalledTimes(1);
    expect(getReportMock).toHaveBeenCalledWith('job-1');

    await advancePolls(1);

    expect(getReportMock).toHaveBeenCalledTimes(2);

    await advancePolls(1);

    expect(getReportMock).toHaveBeenCalledTimes(3);
  });

  it('keeps polling while the job is still queued', async () => {
    getReportMock.mockResolvedValue(jobRecord({ status: 'queued' }));

    await submitScan();
    await advancePolls(1);

    expect(getReportMock).toHaveBeenCalledTimes(2);
  });

  it('stops polling once the job is completed', async () => {
    getReportMock.mockResolvedValue(jobRecord({ status: 'completed', progress: 100 }));

    await submitScan();

    expect(getReportMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('COMPLETED')).toBeInTheDocument();

    await advancePolls(5);

    expect(getReportMock).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the job has failed, and shows the error', async () => {
    getReportMock.mockResolvedValue(
      jobRecord({ status: 'failed', error: 'Browser service unavailable' })
    );

    await submitScan();

    expect(screen.getByText('Error Occurred')).toBeInTheDocument();
    expect(screen.getByText('Browser service unavailable')).toBeInTheDocument();

    await advancePolls(5);

    expect(getReportMock).toHaveBeenCalledTimes(1);
  });

  it('stops polling after the job transitions from running to completed', async () => {
    getReportMock
      .mockResolvedValueOnce(jobRecord({ status: 'running' }))
      .mockResolvedValue(jobRecord({ status: 'completed', progress: 100 }));

    await submitScan();
    await advancePolls(1);

    expect(getReportMock).toHaveBeenCalledTimes(2);

    await advancePolls(5);

    expect(getReportMock).toHaveBeenCalledTimes(2);
  });
});

describe('AIScanner mock-data labelling', () => {
  it('marks a job the backend served from fixtures', async () => {
    getReportMock.mockResolvedValue(jobRecord({ status: 'running', devMode: true }));

    await submitScan();

    expect(screen.getByText('Mock Data')).toBeInTheDocument();
    expect(screen.getByText(/sample output, not a real scan/)).toBeInTheDocument();
  });

  it('shows no mock marker for a real scan', async () => {
    getReportMock.mockResolvedValue(jobRecord({ status: 'running', devMode: false }));

    await submitScan();

    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.queryByText('Mock Data')).not.toBeInTheDocument();
    expect(screen.queryByText(/sample output, not a real scan/)).not.toBeInTheDocument();
  });

  it('points a failed real scan at dev mode as a keyless fallback', async () => {
    getReportMock.mockResolvedValue(
      jobRecord({ status: 'failed', devMode: false, error: 'OpenAI key missing' })
    );

    await submitScan();

    expect(screen.getByText(/No API keys yet\?/)).toBeInTheDocument();
  });
});

describe('AIScanner input validation', () => {
  it('does not call the backend without a URL', async () => {
    render(
      <DevModeProvider>
        <AIScanner />
      </DevModeProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start AI form analysis' }));
    });

    expect(startScanMock).not.toHaveBeenCalled();
  });

  it('does not call the backend for a malformed URL', async () => {
    render(
      <DevModeProvider>
        <AIScanner />
      </DevModeProvider>
    );

    fireEvent.change(screen.getByLabelText('Website URL for AI form analysis'), {
      target: { value: 'not a url' }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start AI form analysis' }));
    });

    expect(startScanMock).not.toHaveBeenCalled();
  });
});

/**
 * Our own interface scored 42/100 against our own analyser, so these pin the
 * things that audit found. An AI-agent form auditor whose own controls are a
 * div with a click handler is the one bug we cannot ship.
 */
describe('AIScanner own-form compatibility', () => {
  const renderScanner = () =>
    render(
      <DevModeProvider>
        <AIScanner />
      </DevModeProvider>
    );

  const urlField = () => screen.getByLabelText('Website URL for AI form analysis');

  it('submits on Enter in the URL field', async () => {
    // Enter did nothing at all before: no form element, and the trigger was a
    // click handler on a type="button". For a single-field box that looks like
    // a search input, Enter is the reflex.
    startScanMock.mockResolvedValue({ jobId: 'job-1' });
    renderScanner();

    fireEvent.change(urlField(), { target: { value: 'https://example.com' } });

    await act(async () => {
      fireEvent.submit(urlField().closest('form')!);
    });

    expect(startScanMock).toHaveBeenCalled();
  });

  it('puts the controls in a real form with a submit button', async () => {
    renderScanner();

    const form = urlField().closest('form');
    expect(form).not.toBeNull();

    // An agent needs a submission boundary, not a div it has to infer one from.
    const submit = screen.getByRole('button', { name: 'Start AI form analysis' });
    expect(submit).toHaveAttribute('type', 'submit');
    expect(form).toContainElement(submit);
  });

  it('states the URL constraint in the markup', async () => {
    renderScanner();

    expect(urlField()).toBeRequired();
    // Named as /api/scan reads it, so the declared action works.
    expect(urlField()).toHaveAttribute('name', 'url');
  });

  it('writes a validation error beside the field, not only in a toast', async () => {
    renderScanner();

    await act(async () => {
      fireEvent.submit(urlField().closest('form')!);
    });

    // A toast is gone before an agent, or a screen reader user who looked
    // away, can read it.
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent(/enter a website url/i);
    expect(urlField()).toHaveAttribute('aria-invalid', 'true');
    expect(urlField().getAttribute('aria-describedby')).toContain('url-input-error');
  });

  it('clears the error once the field is edited', async () => {
    renderScanner();

    await act(async () => {
      fireEvent.submit(urlField().closest('form')!);
    });
    fireEvent.change(urlField(), { target: { value: 'https://example.com' } });

    expect(urlField()).not.toHaveAttribute('aria-invalid');
  });

  it('gives the crawl switch an accessible name and a name attribute', async () => {
    renderScanner();

    // It had neither: a screen reader announced an unnamed switch, and an
    // agent had nothing to target it by.
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAccessibleName(/scanning this page only/i);

    expect(toggle).toHaveAttribute('name', 'fullCrawl');
    // One control carries both id and name now, where the Radix switch put
    // them on different elements.
    expect(toggle).toHaveAttribute('id', 'fullCrawl');
  });

  it('describes the crawl scope without contradicting itself', async () => {
    renderScanner();

    // "Scan entire website" used to sit directly above "Analyze only the
    // provided URL" whenever the switch was off.
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByText(/scanning this page only/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Scan entire website$/)).not.toBeInTheDocument();
  });

  it('gives every analysis-model option a targetable id and name', async () => {
    renderScanner();

    const options = screen.getAllByRole('radio');
    expect(options.length).toBeGreaterThan(1);

    for (const option of options) {
      // Targetable by attribute rather than only by text and position.
      expect(option.getAttribute('id')).toMatch(/^modelProvider-/);
      expect(option).toHaveAttribute('name', 'modelProvider');
    }
  });
});
