import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { AIScanner } from '@/components/AIScanner';
import { DevModeProvider } from '@/contexts/DevModeContext';
import { formAPI } from '@/services/api';

/** Puts the address bar on screen so navigation can be asserted. */
const LocationProbe = () => {
  const { pathname, search } = useLocation();

  return <output data-testid="location">{`${pathname}${search}`}</output>;
};

/** Real history navigation, so Back is tested rather than approximated. */
const BackButton = () => {
  const navigate = useNavigate();

  return (
    <button type="button" onClick={() => navigate(-1)}>
      test-back
    </button>
  );
};

const ForwardButton = () => {
  const navigate = useNavigate();

  return (
    <button type="button" onClick={() => navigate(1)}>
      test-forward
    </button>
  );
};

/**
 * The scanner reads and writes the query string, so it needs a router in the
 * tree. Starting from a path also lets a test arrive the way a visitor
 * following a shared link does, which is where the interesting behaviour is.
 */
const renderScanner = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <DevModeProvider>
        <AIScanner />
        <LocationProbe />
        <BackButton />
        <ForwardButton />
      </DevModeProvider>
    </MemoryRouter>
  );

const location = () => screen.getByTestId('location').textContent;

const goBack = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'test-back' }));
  });
};

const goForward = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'test-forward' }));
  });
};

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
    startDemo: vi.fn(),
    getReport: vi.fn(),
    cancelScan: vi.fn(),
    analyzeForm: vi.fn()
  }
}));

const startScanMock = vi.mocked(formAPI.startScan);
const startDemoMock = vi.mocked(formAPI.startDemo);
const getReportMock = vi.mocked(formAPI.getReport);
const cancelScanMock = vi.mocked(formAPI.cancelScan);

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
  renderScanner();

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
    // The progress card gives way to the report header once there is no
    // progress left to report.
    expect(screen.getByText('Scan complete')).toBeInTheDocument();
    expect(screen.queryByText(/Per-Form Analysis Progress/)).not.toBeInTheDocument();

    await advancePolls(5);

    expect(getReportMock).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the job has failed, and shows the error', async () => {
    getReportMock.mockResolvedValue(
      jobRecord({ status: 'failed', error: 'Browser service unavailable' })
    );

    await submitScan();

    expect(screen.getAllByText('Scan failed').length).toBeGreaterThan(0);
    expect(screen.getByText('Browser service unavailable')).toBeInTheDocument();

    await advancePolls(5);

    expect(getReportMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The progress card used to carry a "New Scan" button, and since the card
   * only renders while a scan is queued or running, that button was reachable
   * at exactly one moment: mid-scan, where its only effect is to abandon the
   * scan just started. It did not even cancel the job -- it navigates to `/`
   * and leaves the crawler running.
   *
   * Removing it is only safe while every finished state still offers a way
   * out, so both halves are asserted here.
   */
  it('offers no action inside the progress card while a scan is running, except stopping it', async () => {
    getReportMock.mockResolvedValue(jobRecord({ status: 'running', progress: 45 }));

    await submitScan();

    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new scan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel scan/i })).toBeInTheDocument();
  });

  it('asks the server to stop the scan it is actually showing', async () => {
    // The previous mid-scan button navigated away and left the crawler
    // running. This one has to reach the backend with the right job id.
    getReportMock.mockResolvedValue(jobRecord({ status: 'running', progress: 45 }));
    cancelScanMock.mockResolvedValue({ success: true, status: 'cancelled' });

    await submitScan();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cancel scan/i }));
    });

    expect(cancelScanMock).toHaveBeenCalledWith('job-1');
  });

  it('stops polling a cancelled job and says it was cancelled', async () => {
    getReportMock.mockResolvedValue(
      jobRecord({ status: 'cancelled', currentStep: 'Scan cancelled after 0 of 1 forms' })
    );

    await submitScan();

    expect(getReportMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Scan cancelled').length).toBeGreaterThan(0);

    await advancePolls(5);

    expect(getReportMock).toHaveBeenCalledTimes(1);
  });

  it('offers a way out of a cancelled scan, and nothing to download', async () => {
    getReportMock.mockResolvedValue(jobRecord({ status: 'cancelled' }));

    await submitScan();

    expect(screen.getByRole('button', { name: /scan another form/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download pdf/i })).not.toBeInTheDocument();
  });

  it('still offers a way out when the scan has failed', async () => {
    // A failure is the state that most needs an exit, and the pinned report
    // bar renders for it because 'failed' is a terminal status.
    getReportMock.mockResolvedValue(
      jobRecord({ status: 'failed', error: 'Browser service unavailable' })
    );

    await submitScan();

    expect(screen.getByRole('button', { name: /scan another form/i })).toBeInTheDocument();
  });

  it('offers a rescan once the scan has completed', async () => {
    getReportMock.mockResolvedValue(jobRecord({ status: 'completed', progress: 100 }));

    await submitScan();

    expect(screen.getByRole('button', { name: /scan another form/i })).toBeInTheDocument();
  });

  it('offers the download only once there are results to download', async () => {
    // A completed job with nothing in `results` has no report to export, and
    // a button that produces an empty PDF is worse than no button.
    getReportMock.mockResolvedValue(jobRecord({ status: 'completed', progress: 100 }));

    await submitScan();

    expect(screen.queryByRole('button', { name: /download pdf/i })).not.toBeInTheDocument();
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
    renderScanner();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start AI form analysis' }));
    });

    expect(startScanMock).not.toHaveBeenCalled();
  });

  it('does not call the backend for a malformed URL', async () => {
    renderScanner();

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
  it('leads with what the visitor cannot answer, not the product name', () => {
    renderScanner();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/can an ai agent fill in your form/i);
    // The name belongs in the header, where it already is.
    expect(heading).not.toHaveTextContent(/huxtek/i);
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

describe('AIScanner sample report', () => {
  const entryPoints = () => screen.getAllByRole('button', { name: /sample report/i });

  it('offers exactly one way in, on the panel that explains it', () => {
    // It was a buried link, then a link plus a panel button, which was the
    // same action twice within a few hundred pixels. One button, on the
    // thing that does the explaining.
    renderScanner();

    expect(entryPoints()).toHaveLength(1);
    expect(entryPoints()[0]).toHaveTextContent(/see a full sample report/i);
  });

  it('asks the demo endpoint, not a scan of a made-up URL', async () => {
    startDemoMock.mockResolvedValue({ jobId: 'job-1', url: 'https://skyline-air.example/' });
    renderScanner();

    await act(async () => {
      fireEvent.click(entryPoints()[0]);
    });

    expect(startDemoMock).toHaveBeenCalled();
    // No target to resolve, nothing re-pointed at a real company, and the
    // scan rate limit is left for actual scans.
    expect(startScanMock).not.toHaveBeenCalled();
  });

  it('needs no URL at all', async () => {
    startDemoMock.mockResolvedValue({ jobId: 'job-1' });
    renderScanner();

    const field = screen.getByLabelText('Website URL for AI form analysis');
    expect(field).toHaveValue('');

    await act(async () => {
      fireEvent.click(entryPoints()[0]);
    });

    expect(startDemoMock).toHaveBeenCalled();
  });

  it('marks the run as sample data, not merely as dev mode', async () => {
    startDemoMock.mockResolvedValue({ jobId: 'job-1', url: 'https://skyline-air.example/' });
    getReportMock.mockResolvedValue(
      jobRecord({ status: 'running', devMode: true, isSampleData: true })
    );
    renderScanner();

    await act(async () => {
      fireEvent.click(entryPoints()[0]);
    });

    // Fabricated scores need saying so wherever they are shown, and the
    // cards' own banners scroll away while the findings stay on screen.
    expect(screen.getByText(/Sample data\./i)).toBeInTheDocument();
    expect(screen.getByText(/not a real audit/i)).toBeInTheDocument();
  });

  it('never submits the form', () => {
    renderScanner();

    // A submit-type button here would run a real scan on whatever was typed.
    expect(entryPoints()[0]).toHaveAttribute('type', 'button');
  });

  it('offers the sample when someone submits with no URL', async () => {
    renderScanner();

    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Website URL for AI form analysis').closest('form'));
    });

    // The moment someone is most likely to want it is the moment they have
    // nothing to type.
    expect(screen.getByRole('alert')).toHaveTextContent(/sample report/i);
  });
});

describe('AIScanner submit feedback', () => {
  const urlField = () => screen.getByLabelText('Website URL for AI form analysis');
  const scanButton = () => screen.getByRole('button', { name: 'Start AI form analysis' });

  /** A start request that stays in flight until it is resolved by hand. */
  const pendingStart = () => {
    let resolve: (value: unknown) => void = () => {};
    const pending = new Promise((r) => {
      resolve = r;
    });

    startScanMock.mockReturnValue(pending as ReturnType<typeof formAPI.startScan>);

    return { resolve };
  };

  it('acknowledges the click before the request returns', async () => {
    // Nothing on screen used to change for the length of the round trip --
    // around half a second on a throttled connection -- so the button sat
    // reading "Scan my form" and invited a second press.
    pendingStart();
    renderScanner();

    fireEvent.change(urlField(), { target: { value: 'https://example.com' } });

    await act(async () => {
      fireEvent.submit(urlField().closest('form')!);
    });

    expect(scanButton()).toBeDisabled();
    expect(scanButton()).toHaveAttribute('aria-busy', 'true');
    expect(scanButton()).toHaveTextContent(/starting/i);
  });

  it('starts one scan however many times it is submitted', async () => {
    // Two clicks 120ms apart really did start two scans: two rate-limit
    // slots, two browser sessions and two sets of model calls.
    pendingStart();
    renderScanner();

    fireEvent.change(urlField(), { target: { value: 'https://example.com' } });

    await act(async () => {
      fireEvent.submit(urlField().closest('form')!);
      fireEvent.submit(urlField().closest('form')!);
      fireEvent.submit(urlField().closest('form')!);
    });

    expect(startScanMock).toHaveBeenCalledTimes(1);
  });

  it('releases the button when the scan fails to start', async () => {
    // Otherwise a rejected scan leaves it spinning with no way back.
    startScanMock.mockRejectedValue(new Error('rate limited'));
    renderScanner();

    fireEvent.change(urlField(), { target: { value: 'https://example.com' } });

    await act(async () => {
      fireEvent.submit(urlField().closest('form')!);
    });

    expect(scanButton()).not.toBeDisabled();
    expect(scanButton()).toHaveTextContent(/scan my form/i);
  });

  it('leaves the button alone when the URL never passed validation', async () => {
    renderScanner();

    await act(async () => {
      fireEvent.submit(urlField().closest('form')!);
    });

    // A rejected URL must not strand the button in a starting state the
    // user cannot clear.
    expect(scanButton()).not.toBeDisabled();
    expect(startScanMock).not.toHaveBeenCalled();
  });

  it('guards the sample report the same way', async () => {
    let resolve: (value: unknown) => void = () => {};
    startDemoMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }) as ReturnType<typeof formAPI.startDemo>
    );
    renderScanner();

    const sample = screen.getByRole('button', { name: /sample report/i });

    await act(async () => {
      fireEvent.click(sample);
      fireEvent.click(sample);
    });

    expect(startDemoMock).toHaveBeenCalledTimes(1);
    expect(sample).toBeDisabled();
    expect(sample).toHaveTextContent(/loading sample/i);
  });
});

/**
 * The report used to be a state flip on `/`, so the address bar read the same
 * whether you were looking at the form or at a finished audit. People took
 * the report for its own page, pressed Back to get at the form, and left the
 * site. These pin the two views to two addresses.
 */
describe('AIScanner scan route', () => {
  const urlField = () => screen.getByLabelText('Website URL for AI form analysis');
  const submit = () => screen.getByRole('button', { name: 'Start AI form analysis' });

  const scanFor = async (value: string) => {
    fireEvent.change(urlField(), { target: { value } });

    await act(async () => {
      fireEvent.click(submit());
    });
  };

  it('puts the target in the address bar when a scan starts', async () => {
    startScanMock.mockResolvedValue({ jobId: 'job-1' });
    getReportMock.mockResolvedValue(jobRecord());
    renderScanner();

    expect(location()).toBe('/');

    await scanFor('https://example.com');

    expect(location()).toBe('/scan?url=https%3A%2F%2Fexample.com');
  });

  it('carries the options that are not at their defaults', async () => {
    startScanMock.mockResolvedValue({ jobId: 'job-1' });
    getReportMock.mockResolvedValue(jobRecord());
    renderScanner();

    fireEvent.click(screen.getByRole('switch'));
    await scanFor('https://example.com');

    expect(location()).toContain('fullCrawl=1');
  });

  it('prefills a shared link without scanning anything', async () => {
    renderScanner('/scan?url=https%3A%2F%2Fexample.com');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The whole point: opening someone else's link must not aim the crawler
    // at their site, spend a rate-limit slot or run up a model bill on the
    // strength of a click nobody made.
    expect(urlField()).toHaveValue('https://example.com');
    expect(startScanMock).not.toHaveBeenCalled();
    expect(submit()).toHaveTextContent(/scan my form/i);
  });

  it('restores the options from a shared link', async () => {
    renderScanner('/scan?url=https%3A%2F%2Fexample.com&fullCrawl=1&modelProvider=heuristic');

    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByRole('radio', { name: /heuristic/i })).toBeChecked();
  });

  it('runs the sample for someone who arrives at the demo address', async () => {
    startDemoMock.mockResolvedValue({ jobId: 'job-1' });
    getReportMock.mockResolvedValue(
      jobRecord({ status: 'running', devMode: true, isSampleData: true })
    );

    renderScanner('/scan?url=demo');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The one target that runs unasked: it touches no third party, spends no
    // rate-limit slot and calls no model.
    expect(startDemoMock).toHaveBeenCalledTimes(1);
    expect(startScanMock).not.toHaveBeenCalled();
  });

  it('never prefills the field with the demo token', () => {
    startDemoMock.mockResolvedValue({ jobId: 'job-1' });
    getReportMock.mockResolvedValue(jobRecord());

    // Read on arrival, before the deferred sample load replaces the form:
    // `demo` is not a URL, so a prefilled field would fail validation the
    // moment anyone pressed Scan.
    renderScanner('/scan?url=demo');

    expect(urlField()).toHaveValue('');
  });

  it('shows the form again when Back leaves the report', async () => {
    startScanMock.mockResolvedValue({ jobId: 'job-1' });
    getReportMock.mockResolvedValue(jobRecord({ status: 'completed', progress: 100 }));
    renderScanner();

    await scanFor('https://example.com');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(screen.queryByLabelText('Website URL for AI form analysis')).not.toBeInTheDocument();

    await goBack();

    expect(location()).toBe('/');
    expect(urlField()).toBeInTheDocument();
  });

  it('brings the report back on Forward rather than binning it', async () => {
    startScanMock.mockResolvedValue({ jobId: 'job-1' });
    getReportMock.mockResolvedValue(jobRecord({ status: 'completed', progress: 100 }));
    renderScanner();

    await scanFor('https://example.com');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    await goBack();
    await goForward();

    expect(location()).toBe('/scan?url=https%3A%2F%2Fexample.com');
    expect(screen.queryByLabelText('Website URL for AI form analysis')).not.toBeInTheDocument();
  });

  it('sends New Scan back to a blank form at the root', async () => {
    startScanMock.mockResolvedValue({ jobId: 'job-1' });
    getReportMock.mockResolvedValue(jobRecord({ status: 'completed', progress: 100 }));
    renderScanner();

    await scanFor('https://example.com');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /scan another form/i }));
    });

    // Unlike Back, this one means start from nothing.
    expect(location()).toBe('/');
    expect(urlField()).toHaveValue('');
  });

  it('does not navigate when the URL is rejected', async () => {
    renderScanner();

    await scanFor('not a url');

    // A rejected URL must not strand someone on a scan address with no scan.
    expect(location()).toBe('/');
    expect(startScanMock).not.toHaveBeenCalled();
  });
});

/**
 * The deployed demo runs with real scans switched off at the API. The gate is
 * enforced there, because /api/scan is public and callable directly, but the
 * interface has to explain it rather than let someone fill the field, press
 * Scan and collect a 403.
 */
describe('AIScanner demo mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const withScanConfig = (realScansEnabled: boolean) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ realScansEnabled })
      })
    );
  };

  it('says so when the instance will not accept a real target', async () => {
    withScanConfig(false);
    renderScanner();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText(/Demo mode\./)).toBeInTheDocument();
    expect(screen.getByText(/Live scans are switched off/)).toBeInTheDocument();
  });

  it('stays out of the way on an instance that does accept them', async () => {
    withScanConfig(true);
    renderScanner();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.queryByText(/Demo mode\./)).not.toBeInTheDocument();
  });

  it('keeps the sample report reachable in demo mode', async () => {
    withScanConfig(false);
    renderScanner();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The sample is the whole product in demo mode, so it must not be gated.
    expect(
      screen.getByRole('button', { name: /see a full sample report/i })
    ).toBeEnabled();
  });
});
