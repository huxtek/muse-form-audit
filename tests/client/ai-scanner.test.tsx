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
  });

  it('points at its error region before there is an error to show', async () => {
    renderScanner();

    // Wiring the region in only once it has content means the association
    // never existed when assistive tech built its picture of the field, and
    // an agent re-reading the field after a failure cannot tell which element
    // holds the message.
    const describedBy = urlField().getAttribute('aria-describedby');
    expect(describedBy).toContain('url-input-error');
    expect(describedBy).toContain('url-input-description');

    // Still no error, so nothing is claimed about validity.
    expect(urlField()).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('alert')).toHaveTextContent('');
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
    // Names the option, and stays put when toggled: a control that
    // renames itself as its state changes is announced as its own state.
    expect(toggle).toHaveAccessibleName(/crawl entire website/i);

    expect(toggle).toHaveAttribute('name', 'fullCrawl');
    // One control carries both id and name now, where the Radix switch put
    // them on different elements.
    expect(toggle).toHaveAttribute('id', 'fullCrawl');
  });

  it('describes the crawl scope without contradicting itself', async () => {
    renderScanner();

    // "Scan entire website" used to sit directly above "Analyze only the
    // provided URL" whenever the switch was off. The heading now names the
    // option and the description states which way it is set.
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByText(/off: analyzing only the URL you provide/i)).toBeInTheDocument();
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

/**
 * The landing page used to describe itself five times -- a subtitle, a
 * paragraph, a card title, four process bullets and three feature cards --
 * while never showing what an audit produces, and led with the product's own
 * name in the largest type on the page.
 */
describe('AIScanner landing page', () => {
  const renderScanner = () =>
    render(
      <DevModeProvider>
        <AIScanner />
      </DevModeProvider>
    );

  it('leads with what the visitor cannot answer, not the product name', () => {
    renderScanner();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/can an ai agent fill in your form/i);
    // The name belongs in the header, where it already is.
    expect(heading).not.toHaveTextContent(/muse form audit/i);
  });

  it('shows an example report instead of only describing one', () => {
    renderScanner();

    // The annotated screenshot is the product's whole argument, and a visitor
    // used to see none of it before committing to a scan.
    expect(screen.getByRole('img', { name: /example report/i })).toBeInTheDocument();
  });

  it('carries no duplicate pitch or process copy', () => {
    renderScanner();

    expect(screen.queryByText(/Advanced AI-driven website analyzer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI agent will (systematically|autonomously)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI-Powered Deep Scan/i)).not.toBeInTheDocument();
  });

  it('makes no claim about a model or transport it does not use', () => {
    renderScanner();

    // Said "GPT-5 driven autonomous crawling" long after moving to Muse, and
    // advertised our WebSocket to people who do not have one.
    expect(screen.queryByText(/GPT-5/)).not.toBeInTheDocument();
    expect(screen.queryByText(/WebSocket/)).not.toBeInTheDocument();
  });

  it('keeps the scan options collapsed, with their state in the summary', () => {
    renderScanner();

    const options = screen.getByText(/^Options/).closest('details');
    expect(options).not.toBeNull();
    expect(options).not.toHaveAttribute('open');
    // Collapsed is only acceptable if you can still see what it is set to.
    expect(options).toHaveTextContent(/single page/i);
    expect(options).toHaveTextContent(/muse/i);
  });

  it('keeps the options inside the form so a native submit still carries them', () => {
    renderScanner();

    // A closed <details> hides its content but does not remove it from the
    // form, so fullCrawl is still submitted.
    const form = screen.getByLabelText('Website URL for AI form analysis').closest('form');
    expect(form?.querySelector('details #fullCrawl')).not.toBeNull();
    expect(form?.querySelector('details [name="modelProvider"]')).not.toBeNull();
  });

  it('does not promise a full scan while set to a single page', () => {
    renderScanner();

    // The button read "Full AI Scan" directly above options saying
    // "single page".
    const submit = screen.getByRole('button', { name: 'Start AI form analysis' });
    expect(submit).toHaveTextContent(/scan my form/i);
    expect(submit).not.toHaveTextContent(/full/i);
  });
});
