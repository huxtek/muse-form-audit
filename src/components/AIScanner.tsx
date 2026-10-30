import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Bot, Scan, AlertTriangle, CheckCircle, ChevronRight, CircleSlash, Clock, Loader2, MinusCircle, Zap, Globe, FileText, FlaskConical, Sparkles, Eye, EyeOff } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { useDevMode } from "@/contexts/DevModeContext";
import { getScanUrl, getWebSocketUrl } from "@/lib/api-config";
import {
  buildDemoPath,
  buildScanPath,
  parseScanParams,
  SCAN_DEMO_TARGET
} from "@/lib/scan-url";
import { normalizeTargetUrl } from "@/lib/target-url";
import { formTabHint, isFormNotRendered } from "@/lib/form-purpose";
import { useScanConfig } from "@/hooks/useScanConfig";
import FormPreviewIllustration from "@/components/FormPreviewIllustration";
import { formAPI } from "@/services/api";
import { PDFGenerator } from "@/lib/pdf-generator";
import { getNormalizedResults } from "@/lib/scan-results";
import type { ScanResults } from "@/lib/scan-types";
import {
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
  MODEL_PROVIDER_DETAILS,
  type ModelProvider
} from "@/defines/modelProviders";
import { SEVERITY_ORDER, SEVERITY_STYLES } from "@/defines/severities";
import FormAnalysisDisplay from "@/components/FormAnalysisDisplay";
import FormVisualPanel from "@/components/FormVisualPanel";
import PageMapView from "@/components/PageMapView";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ReportActionBar from "@/components/ReportActionBar";
import ScoreBreakdown from "@/components/ScoreBreakdown";
import FindingsList from "@/components/FindingsList";
import {
  averageScore,
  collectFindings,
  countSeverities,
  describeAnalyser
} from "@/lib/report-data";

/** Result view tabs. Visual is the default; the written findings sit behind Details. */
const RESULT_TABS = {
  VISUAL: 'visual',
  DETAILS: 'details'
} as const;

/**
 * Up to this many forms are stacked in the visual tab. Beyond it a picker
 * shows one at a time, because a full crawl can return fourteen screenshots
 * and stacking them buries everything below the first.
 */
const STACKED_FORM_LIMIT = 3;

/**
 * The site the sample report describes.
 *
 * A reserved .example host, so it cannot belong to anyone. The server keeps
 * it rather than re-pointing the fixture at a URL the visitor typed, which
 * is what would make a fabricated report dangerous: every URL and sentence
 * would name a real company beside invented scores.
 */
const SAMPLE_REPORT_URL = 'https://skyline-air.example/';

/**
 * Statuses after which nothing more will arrive.
 *
 * Reaching one of these swaps the progress card for the report header. The
 * card used to stay put, so a finished scan still opened with 620px of
 * progress reporting -- a bar at 100%, a per-form progress panel, and a
 * status badge reading COMPLETED -- before any result.
 */
const TERMINAL_STATUSES = ['cancelled', 'completed', 'completed_with_errors', 'failed'];

/**
 * How often to ask a running job for its progress.
 *
 * Two seconds while there is something to watch, then slower once the scan
 * is plainly in a long wait. A scan that waits out a model outage can run
 * for minutes, and at a flat two seconds a measured 133-second scan spent
 * 66 requests -- two of those locked the operator out of their own instance
 * against a 100-request budget. The WebSocket carries the interesting
 * updates anyway; this is the backup for when it does not.
 */
const POLL_INTERVAL_MS = 2000;
const SLOW_POLL_INTERVAL_MS = 5000;
/** 15 polls at 2s is the first 30 seconds, where the visible steps happen. */
const SLOW_POLL_AFTER_POLLS = 15;

/** Widening delays for a poll that failed, rather than giving up on it. */
const POLL_RETRY_DELAYS_MS = [2000, 5000, 10_000, 20_000];
const MAX_POLL_RETRIES = 6;

/**
 * Headings for failures that are the target's doing, not ours.
 *
 * "Error Occurred" over a bot-detection block reads as a fault in the
 * scanner, which sends someone looking for a problem on the wrong side.
 */
const PAGE_ACCESS_HEADINGS: Record<string, string> = {
  'bot-protected': 'Blocked by bot protection',
  forbidden: 'The site refused the request',
  unauthorized: 'That page requires sign-in',
  'not-found': 'That page does not exist',
  'rate-limited': 'The site is rate limiting us',
  'server-error': 'The site returned an error',
  'load-failed': 'The page could not be read',
  'nav-timeout': 'The page took too long to load',
  unreadable: 'The page could not be read'
};

/** How the collapsed summary line names each way a scan can end. */
const FINISHED_HEADLINES: Record<string, string> = {
  cancelled: 'Scan cancelled',
  completed: 'Scan complete',
  completed_with_errors: 'Scan complete',
  failed: 'Scan failed'
};

interface ScanJob {
  id: string;
  url: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'completed_with_errors' | 'cancelled';
  /**
   * Set when the target refused the request rather than when anything of
   * ours broke, so the failure can be described as the site's restriction
   * instead of an unexplained error.
   */
  errorKind?: string;
  progress: number;
  currentStep: string;
  results?: ScanResults;
  error?: string;
  createdAt: string;
  /**
   * Bundled sample output rather than an audit of a real site. Distinct from
   * `devMode`, which also covers a developer running a keyless scan against
   * a URL they chose.
   */
  isSampleData?: boolean;
  // Per-form analysis fields
  formsFound?: number;
  formsAnalyzed?: number;
  // True when the backend served this job from the bundled mock fixtures.
  // Read off the job record rather than the live toggle, so a result stays
  // labelled correctly even if Dev Mode is flipped afterwards.
  devMode?: boolean;
  // Which model produced this result. Read off the job for the same reason as
  // `devMode`: flipping the switch afterwards must not relabel a finished scan.
  modelProvider?: ModelProvider;
  modelLabel?: string;
  model?: string;
}

interface PerFormProgress {
  formsFound: number;
  formsAnalyzed: number;
  currentFormIndex?: number;
}

/**
 * Builds the client-side id for a scan whose results came back immediately,
 * so the completed job has a stable key even though the backend never issued
 * a job id for it. Lives at module scope because reading the clock is impure:
 * inside the component body React's lint rules (correctly) treat it as render
 * work that could produce a different value on every re-render.
 */
const createImmediateScanId = () => `scan-${Date.now()}`;

export const AIScanner = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const { target: scanTarget, isDemo } = parseScanParams(searchParams);

  // Named apart from the local `url` inside startAIScan, which shadows it
  // when the sample report supplies its own target.
  //
  // Seeded from the query string rather than synced to it: a shared
  // `/scan?url=example.com` arrives as a fresh mount, which is the only
  // moment the field needs to follow the address bar. Every later change
  // comes from someone typing, and an effect copying the param back over
  // the top would fight them for the field.
  const [urlFromState, setUrl] = useState(() => parseScanParams(searchParams).url);
  const [fullCrawl, setFullCrawl] = useState(
    () => parseScanParams(searchParams).fullCrawl
  );
  const [modelProvider, setModelProvider] = useState<ModelProvider>(
    () => parseScanParams(searchParams).modelProvider
  );
  // Which form the visual tab is showing when there are too many to stack.
  const [selectedFormIndex, setSelectedFormIndex] = useState(0);
  /**
   * The scan itself, and the target it belongs to.
   *
   * Kept as two pieces so which view is on screen can be *derived* from the
   * address bar rather than kept in step with it. An effect that copied the
   * query string into state would be a second source of truth, and the one
   * that loses: it cannot run until after a render has already drawn the
   * wrong thing.
   */
  const [jobState, setJobState] = useState<ScanJob | null>(null);
  const [jobTarget, setJobTarget] = useState<string | null>(null);

  /**
   * The report is shown only while the address bar still names the scan that
   * produced it.
   *
   * This is the whole Back-button fix, and it is a derivation rather than a
   * reaction: going back to `/` leaves no target, so there is nothing to
   * match and the form is what renders -- no state to clear, and no window
   * in which a stale report could flash. Going forward again re-matches, so
   * an interrupted scan is not needlessly thrown away.
   */
  const currentJob = jobTarget !== null && jobTarget === scanTarget ? jobState : null;

  /**
   * Points the view at a target whose results have not arrived yet.
   *
   * Both pieces move together, and that is the whole point of having it.
   * The target used to be set here on its own, the moment the scan was
   * asked for, while the job could only be set when the POST came back.
   * For the length of that round trip the two disagreed, and `currentJob`
   * resolved to the previous scan's finished report under the new scan's
   * address -- a complete report, with a score, describing the wrong site.
   *
   * It was easy to miss locally, where the request takes a few hundred
   * milliseconds. A cold Render instance takes twenty seconds, and a
   * request that fails never replaces the job at all, so the stale report
   * simply stayed.
   */
  const beginJobFor = (target: string) => {
    setJobTarget(target);
    setJobState(null);

    return claimScan();
  };

  /**
   * Which scan the view belongs to, as a number that only goes up.
   *
   * Polling is a recursive `setTimeout` that writes whatever it fetches into
   * the single `jobState`. It stops when the job it is watching reaches a
   * terminal status, which means there is almost always one more request
   * either scheduled or already in flight when someone starts a new scan.
   * That late response restored the previous report a second after the new
   * scan had cleared it -- clearing the state was not enough on its own,
   * because the thing that put it back ran afterwards.
   *
   * A generation rather than a job-id comparison: the id of the new job is
   * not known until its POST returns, and the stale window opens before
   * that.
   */
  const scanGenerationRef = useRef(0);

  /** Starts a new generation, invalidating anything in flight for the last. */
  const claimScan = () => {
    scanGenerationRef.current += 1;

    return scanGenerationRef.current;
  };

  /** The demo target we have already auto-run, so it runs once per arrival. */
  const demoRanForRef = useRef<string | null>(null);
  // The live socket is an external resource, not render input: nothing in the
  // JSX reads it, only `resetScan` needs a handle to close it. A ref keeps it
  // out of the render cycle, which is also what React's set-state-in-effect
  // rule asks for.
  const wsRef = useRef<WebSocket | null>(null);
  /** The selected form's detail, scrolled to when a map region is chosen. */
  const formDetailRef = useRef<HTMLDivElement | null>(null);
  /** Validation message for the URL field, shown beside it and announced. */
  const [urlError, setUrlError] = useState<string | null>(null);

  /**
   * A start request is in flight.
   *
   * Nothing on screen used to acknowledge the click until the POST came
   * back -- measured at around half a second on a throttled connection --
   * so the button still read "Scan my form" and invited a second press.
   * Two clicks 120ms apart really did start two scans: two rate-limit
   * slots, two browser sessions and two sets of model calls.
   *
   * The ref is the guard and the state is the label. State alone is not
   * enough: two clicks inside one render would both read the old value.
   */
  const [isStarting, setIsStarting] = useState(false);
  const startInFlight = useRef(false);
  /** Keeps the cancel button from being pressed twice while the POST is out. */
  const [isCancelling, setIsCancelling] = useState(false);

  const beginStart = () => {
    if (startInFlight.current) {
      return false;
    }

    startInFlight.current = true;
    setIsStarting(true);

    return true;
  };

  const endStart = () => {
    startInFlight.current = false;
    setIsStarting(false);
  };

  /**
   * True for anything fabricated: the one-click sample report, and a keyless
   * dev-mode scan of a URL someone chose. Both produce numbers that describe
   * no real site, so both need saying so.
   */
  const isSampleRun = currentJob?.isSampleData === true || currentJob?.devMode === true;

  /**
   * Nothing more is coming, so the progress card gives way to the report
   * header. Covers failure as well as success: a failed scan has no progress
   * left to report either, and still needs a way to start another.
   *
   * Checked for truthiness rather than against null, because a poll that
   * comes back empty writes undefined into the job and `!== null` would let
   * that straight through to a property read.
   */
  const isFinished = Boolean(currentJob) && TERMINAL_STATUSES.includes(currentJob?.status ?? '');
  const reportForms = currentJob?.results?.forms ?? [];
  const reportScore = averageScore(reportForms);
  /** What scored the report: a named model, rules, or a mix of both. */
  const reportAnalyser = describeAnalyser(reportForms);
  const [perFormProgress, setPerFormProgress] = useState<PerFormProgress>({
    formsFound: 0,
    formsAnalyzed: 0
  });
  const { toast } = useToast();
  const { isDevMode } = useDevMode();

  /**
   * Whether this deployment accepts real targets. Asked at runtime so the
   * demo gate can be flipped with a server restart instead of a UI rebuild.
   */
  const { realScansEnabled } = useScanConfig();

  // WebSocket connection for real-time updates
  useEffect(() => {
    if (currentJob && currentJob.status === 'running') {
      const wsUrl = getWebSocketUrl();
      const websocket = new WebSocket(wsUrl);
      
      websocket.onopen = () => {
        console.log('WebSocket connected');
        websocket.send(JSON.stringify({
          type: 'subscribe',
          jobId: currentJob.id
        }));
      };
      
      websocket.onmessage = (event) => {
        try {
          const update = JSON.parse(event.data);
          if (update.jobId === currentJob.id) {
            // Handle per-form progress updates
            if (update.type === 'forms_discovered') {
              setPerFormProgress(prev => ({
                ...prev,
                formsFound: update.formsCount || 0
              }));
              
              // A page with no form announced "Forms Discovered -- Found 0
              // forms. Starting individual analysis...", which promises
              // work that cannot happen. Counted properly, and singular
              // when there is one.
              toast(
                update.formsCount
                  ? {
                      title: 'Forms Discovered',
                      description: `Found ${update.formsCount} form${update.formsCount === 1 ? '' : 's'} on the page. Starting individual analysis...`
                    }
                  : {
                      title: 'No forms found',
                      description: 'This page has no form elements to analyse.'
                    }
              );
            }
            
            if (update.type === 'form_analyzed') {
              setPerFormProgress(prev => ({
                ...prev,
                formsAnalyzed: prev.formsAnalyzed + 1,
                currentFormIndex: update.formData?.formIndex
              }));
              
              toast({
                title: "Form Analyzed",
                description: `Completed analysis of form ${update.formData?.formIndex} of ${update.formData?.totalForms}`,
              });
            }
            
            // Regular progress update
            setJobState(prev => prev ? { 
              ...prev, 
              ...update,
              formsFound: update.formsFound || prev.formsFound || 0,
              formsAnalyzed: update.formsAnalyzed || prev.formsAnalyzed || 0
            } : null);
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
        }
      };
      
      websocket.onclose = () => {
        console.log('WebSocket disconnected');
      };
      
      wsRef.current = websocket;
      
      return () => {
        websocket.close();
      };
    }
  }, [currentJob?.id, currentJob?.status]);

  const handleFullCrawlToggle = (checked: boolean) => {
    setFullCrawl(checked);
  };

  const handleModelProviderSelect = (provider: ModelProvider) => {
    setModelProvider(provider);
  };

  /**
   * Selecting a form on the page map used to change something below the fold,
   * which reads as nothing having happened at all. Bring the detail to the
   * user instead of leaving them to find it.
   *
   * Scrolled on the event rather than from an effect watching the index: the
   * panel is keyed by form identity and remounts, so this waits a frame for
   * the new one to lay out.
   */
  const handleSelectForm = (index: number, options?: { reveal?: boolean }) => {
    setSelectedFormIndex(index);

    if (options?.reveal) {
      requestAnimationFrame(() => {
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

        formDetailRef.current?.scrollIntoView({
          behavior: reduced ? 'auto' : 'smooth',
          block: 'start'
        });
      });
    }
  };

  /**
   * Submitting the scan form. Exists so Enter in the URL field works, which
   * it did not when the controls were a div and the button a click handler.
   */
  const handleScanSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startAIScan();
  };

  /**
   * Runs the bundled sample report.
   *
   * Understanding this tool used to cost a URL and, for a real scan, API
   * keys -- so a visitor had to commit before they could see what an audit
   * even looks like. The fixtures that make Dev Mode work answer that in a
   * click, and the results carry their own "sample output, not a real scan"
   * banners, so nothing here can be mistaken for an audit of a real site.
   *
   * Passes devMode explicitly rather than flipping the header toggle: the
   * visitor should not be left in a different mode than they arrived in.
   */
  const showSampleReport = async () => {
    if (!beginStart()) {
      return;
    }

    setUrlError(null);

    try {
      const started = await formAPI.startDemo();

      if (started?.jobId) {
        // Binds the sample to `?url=demo`, so it shows while that is the
        // address and stops showing the moment it is not.
        const generation = claimScan();

        setJobTarget(SCAN_DEMO_TARGET);
        setJobState({
          id: started.jobId,
          url: started.url ?? SAMPLE_REPORT_URL,
          status: 'queued',
          progress: 0,
          currentStep: 'Starting sample report...',
          createdAt: new Date().toISOString(),
          devMode: true,
          isSampleData: true,
          modelProvider: started.modelProvider,
          modelLabel: started.modelLabel,
          model: started.model
        });

        // Same path a real scan takes: the socket is opened by the effect
        // watching currentJob, and polling backs it up.
        pollJobStatus(started.jobId, generation);
      }
    } catch (error) {
      toast({
        title: 'Sample report unavailable',
        description: error instanceof Error ? error.message : 'Could not load the sample report',
        variant: 'destructive'
      });
    } finally {
      endStart();
    }
  };

  /**
   * Follows a queued job to completion.
   *
   * Declared ahead of the two callers that use it, against the usual
   * step-down order, because both the sample and a real scan hand off to it
   * and one of them is now reached from an effect -- where a reference to a
   * `const` declared further down is an access before declaration.
   */
  const pollJobStatus = async (
    jobId: string,
    generation: number,
    { polls = 0, retries = 0 }: { polls?: number; retries?: number } = {}
  ) => {
    // Checked before the request and again after it: a scan started while
    // this one was waiting on the network would otherwise have its state
    // overwritten by a job it has nothing to do with.
    if (generation !== scanGenerationRef.current) {
      return;
    }

    try {
      const job = await formAPI.getReport(jobId);

      if (generation !== scanGenerationRef.current) {
        return;
      }

      setJobState(job);

      if (job.status === 'running' || job.status === 'queued') {
        setTimeout(
          () => pollJobStatus(jobId, generation, { polls: polls + 1, retries: 0 }),
          pollDelayFor(polls)
        );
      }
    } catch (error) {
      /*
       * A failed poll used to end the loop for good. One rate-limited
       * response -- or any network blip -- and the scan froze at whatever
       * progress it had last reported, with no error and no further updates,
       * while the backend carried on working and finished normally.
       *
       * Retried with a widening delay instead, so a scan survives a blip and
       * a server asking us to slow down gets what it asked for.
       */
      console.error('Polling error:', error);

      if (generation !== scanGenerationRef.current || retries >= MAX_POLL_RETRIES) {
        return;
      }

      setTimeout(
        () => pollJobStatus(jobId, generation, { polls, retries: retries + 1 }),
        POLL_RETRY_DELAYS_MS[Math.min(retries, POLL_RETRY_DELAYS_MS.length - 1)]
      );
    }
  };

  /**
   * The sample is a destination as well as an action, so the button does
   * both: it moves to `/scan?url=demo`, which makes the sample a link worth
   * putting in a README, and starts the load itself.
   *
   * Claiming the ref first tells the arrival effect to stand down, so the
   * two paths cannot both fire. Running it here rather than leaving it to
   * that effect keeps the press acknowledged on the spot.
   */
  const handleShowSample = () => {
    demoRanForRef.current = SCAN_DEMO_TARGET;
    navigate(buildDemoPath());
    void showSampleReport();
  };

  /**
   * Loads the sample for someone who arrives at `/scan?url=demo` directly,
   * by shared link or reload, rather than by pressing the button.
   *
   * `?url=demo` is the one target that runs unasked, and it can afford to:
   * the fixture touches no third party, spends no rate-limit slot and calls
   * no model. A real target is deliberately left alone -- opening someone's
   * shared `/scan?url=their-site.com` must not aim our crawler at it, or run
   * up a bill, on the strength of a click nobody made. Those arrive
   * prefilled and wait to be started.
   *
   * The button does not come through here: it marks the ref and runs the
   * load itself, so the click keeps its immediate feedback and this stands
   * down. That leaves the effect responsible for arrivals only, which is the
   * one case a handler cannot cover.
   *
   * Deferred by a timer rather than run inline because setting state in an
   * effect's synchronous phase invites the cascading render React warns
   * about. The ref guard, keyed on the target, is what holds it to one run
   * per arrival.
   */
  useEffect(() => {
    if (!isDemo || demoRanForRef.current === scanTarget) {
      return;
    }

    demoRanForRef.current = scanTarget;

    const timer = setTimeout(() => {
      void showSampleReport();
    }, 0);

    return () => clearTimeout(timer);
    // showSampleReport is redefined every render; the ref guard above, not
    // the dependency list, is what keeps this to one run per arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDemo, scanTarget]);

  const startAIScan = async (overrides?: { url?: string; devMode?: boolean }) => {
    const url = overrides?.url ?? urlFromState;
    const devMode = overrides?.devMode ?? isDevMode;

    if (!url) {
      // Also written beside the field: a toast is gone before an agent, or a
      // screen reader user who looked away, can read it. And this is the
      // moment someone is most likely to want the sample, so offer it rather
      // than only refusing.
      // No direction given: the sample button sits beside the form on a wide
      // screen and below it on a narrow one.
      setUrlError('Enter a website URL to scan, or try the sample report.');
      toast({
        title: "Please enter a URL",
        description: "Enter a website URL, or see the sample report if you do not have one to hand",
        variant: "destructive",
      });
      return;
    }

    /*
     * `aa.com` is a website address, so it is accepted and completed to
     * `https://aa.com/`. The normalised form is what gets navigated to,
     * requested and shown in the field, so the address bar, the input and
     * the report all name the same thing.
     */
    const normalized = normalizeTargetUrl(url);

    if (!normalized.url) {
      setUrlError(normalized.error ?? 'That does not look like a website URL.');
      toast({
        title: 'Check the URL',
        description: normalized.error ?? 'Please enter a valid website URL.',
        variant: 'destructive'
      });
      return;
    }

    const target = normalized.url;

    setUrlError(null);
    // So the field shows what is actually being scanned rather than the
    // shorthand that was typed.
    setUrl(target);

    // After validation, so a rejected URL does not leave the button stuck
    // in a starting state the user cannot clear.
    if (!beginStart()) {
      return;
    }

    // Before the request, not after: the address bar is part of the
    // acknowledgement that the click landed, and it should not wait on a
    // round trip. The URL effect treats this as "a target was asked for",
    // so it prefills over the top with identical values and leaves the job
    // that is about to arrive alone.
    navigate(buildScanPath({ url: target, fullCrawl, modelProvider }));

    // Set alongside the navigation so the results, whenever they land, are
    // bound to the address that asked for them.
    const generation = beginJobFor(target);

    try {
      const scanResults = await formAPI.startScan({
        url: target,
        fullCrawl, // Pass the crawling mode to the backend
        devMode, // Header toggle, or forced on by the sample report
        modelProvider // Which model should run the analysis
      });
      
      // Check if this is immediate results (our current backend) or job-based response
      if (scanResults.success && scanResults.scanType) {
        // Immediate results - create a completed job structure
        setJobState({
          id: createImmediateScanId(),
          url: target,
          status: 'completed',
          progress: 100,
          currentStep: 'Scan completed',
          createdAt: new Date().toISOString(),
          results: scanResults,
          devMode: scanResults.devMode === true,
          modelProvider: scanResults.modelProvider,
          modelLabel: scanResults.modelLabel,
          model: scanResults.model
        });

        toast({
          title: "AI Scan Complete",
          description: `Analyzed ${scanResults.summary.totalPages} page${scanResults.summary.totalPages !== 1 ? 's' : ''} and found ${scanResults.summary.totalForms} form${scanResults.summary.totalForms !== 1 ? 's' : ''}`,
        });
      } else if (scanResults.jobId) {
        // Job-based response - use polling
        setJobState({
          id: scanResults.jobId,
          url: target,
          status: 'queued',
          progress: 0,
          currentStep: 'Queued for processing...',
          createdAt: new Date().toISOString(),
          devMode: scanResults.devMode === true,
          modelProvider: scanResults.modelProvider,
          modelLabel: scanResults.modelLabel,
          model: scanResults.model
        });

        toast({
          title: "AI Scan Started",
          description: fullCrawl 
            ? "The AI agent is now crawling and analyzing your entire website"
            : "The AI agent is now analyzing the provided URL",
        });

        // Start polling for updates
        pollJobStatus(scanResults.jobId, generation);
      } else {
        throw new Error('Invalid response format');
      }

    } catch (error: unknown) {
      console.error('Scan start error:', error);

      toast({
        title: "Scan Failed",
        description: error instanceof Error ? error.message : "Failed to start scan",
        variant: "destructive",
      });
    } finally {
      // Must clear on failure too, or a rejected scan leaves the button
      // spinning with no way back.
      endStart();
    }
  };

  /**
   * Headline numbers for the visual tab. The full dashboard lives in Details,
   * so this keeps the score and the finding counts in view without pushing the
   * screenshot down the page.
   */
  const renderScoreStrip = () => {
    const forms = currentJob?.results?.forms ?? [];
    const summary = currentJob?.results?.summary;
    const scores = forms
      .map((form) => form.accessibility?.score)
      .filter((score): score is number => typeof score === 'number');
    const averageScore = scores.length
      ? Math.round(scores.reduce((total, score) => total + score, 0) / scores.length)
      : null;

    // The same counter the findings list uses, over the same collection.
    //
    // This strip used to tally `fieldIssues` alone with its own inline
    // reduce, so a report with whole-form findings showed two different
    // totals for the same thing: the live sample read "5 high, 4 medium,
    // 7 low" here and "20 findings" under Details, because the four
    // formFindings were counted in one place and not the other. Sharing
    // `collectFindings` makes that impossible rather than merely fixed.
    const counts = countSeverities(collectFindings(forms));

    return (
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4 rounded-lg border border-border/40 bg-muted/20">
        {averageScore !== null && (
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold text-foreground leading-none">
                {averageScore}%
              </span>

              {/* Marked here specifically. The surrounding cards carry a
                  banner, but this strip is the part that gets screenshotted
                  on its own, and a score with no provenance beside it is
                  indistinguishable from a real result. */}
              {isSampleRun && (
                <Badge
                  variant="outline"
                  className="text-[10px] uppercase tracking-wide border-amber-500/60 text-amber-400"
                >
                  Sample
                </Badge>
              )}
            </div>

            <div className="text-xs text-muted-foreground mt-1">
              {forms.length > 1 ? 'Average AI compatibility' : 'AI compatibility'}
              {/* Named here too: this strip is the part that gets
                  screenshotted on its own, and a score with no attribution
                  reads as whatever the viewer assumes. */}
              {reportAnalyser.label && (
                <span className={reportAnalyser.usedFallback ? 'text-amber-400' : ''}>
                  {' · '}
                  {reportAnalyser.label}
                </span>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="text-2xl font-bold text-foreground leading-none">{forms.length}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {forms.length === 1 ? 'Form analyzed' : 'Forms analyzed'}
            {summary?.totalPages ? ` on ${summary.totalPages} page${summary.totalPages === 1 ? '' : 's'}` : ''}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {forms.length === 0 ? (
            /*
             * "No issues found" would be a clean bill of health for a page
             * nothing was checked on. A scan of MDN's documentation *about*
             * forms finds no form element, and the badge read as though the
             * page had passed an audit it never had.
             */
            <Badge variant="outline" className="text-xs text-muted-foreground">
              <MinusCircle className="h-3 w-3 mr-1" />
              Nothing to check
            </Badge>
          ) : SEVERITY_ORDER.every((severity) => counts[severity] === 0) ? (
            <Badge variant="outline" className="text-xs">
              <CheckCircle className="h-3 w-3 mr-1" />
              {/* Not "no field-level issues" any more: this now counts
                  whole-form findings too, so claiming only the field level
                  would understate what was checked. */}
              No issues found
            </Badge>
          ) : (
            SEVERITY_ORDER.map((severity) => (
              <Badge key={severity} variant="outline" className="text-xs">
                <span className={`inline-block h-2 w-2 rounded-full mr-2 ${SEVERITY_STYLES[severity].dot}`} />
                {counts[severity]} {SEVERITY_STYLES[severity].label}
              </Badge>
            ))
          )}
        </div>
      </div>
    );
  };

  /**
   * The default results view: one annotated screenshot per form.
   *
   * A handful of forms stack; beyond that a picker shows one at a time, since
   * a full crawl can return fourteen and stacking them is unnavigable.
   */
  const renderVisualTab = () => {
    const forms = currentJob?.results?.forms ?? [];

    if (forms.length === 0) {
      return (
        <div className="p-4 rounded-lg border border-border/50 bg-muted/30 text-sm text-muted-foreground">
          No forms were found on this page, so there is nothing to highlight.
        </div>
      );
    }

    const index = Math.min(selectedFormIndex, forms.length - 1);
    const hasPageMap = forms.some((form) => form.visual?.pageMap);

    // The map shows the page that was scanned, with each form outlined on it.
    if (hasPageMap) {
      return (
        <div className="space-y-5">
          {/* Shown for any multi-form scan, not just a multi-page crawl. The
              map reaches a form only if that form has an outline on it, and a
              form that is not rendered has none, so the picker is the only
              route to those -- and hunting for an outline on a screenshot of
              a whole page is work even when there is one. */}
          {forms.length > 1 && renderFormPicker(forms, index)}

          <PageMapView
            forms={forms}
            jobId={currentJob?.id ?? ''}
            selectedIndex={index}
            onSelect={handleSelectForm}
          />

          {/* Scroll target. On the wrapper, not the panel: the panel remounts
              when the selection changes, which would drop the ref. */}
          <div ref={formDetailRef} className="scroll-mt-4">
            {renderVisualForm(forms[index], index)}
          </div>
        </div>
      );
    }

    if (forms.length <= STACKED_FORM_LIMIT) {
      return <div className="space-y-8">{forms.map(renderVisualForm)}</div>;
    }

    return (
      <div className="space-y-4">
        {renderFormPicker(forms, index)}
        {renderVisualForm(forms[index], index)}
      </div>
    );
  };

  /**
   * One tab per form, so a form can be chosen by name instead of hunted for.
   *
   * Previously shown only when a crawl spanned several pages, on the
   * reasoning that the page map is itself a picker. It is, for a form you can
   * already see: reaching a form meant finding its outline on a screenshot of
   * the whole page first. A form that is not rendered has no outline at all,
   * so after the map stopped inventing positions for those, they became
   * unreachable in the visual tab entirely.
   *
   * Each tab carries what distinguishes the form -- whether it is hidden,
   * what kind it is, what it scored -- because "1 2 3" tells a reader nothing
   * about which one they want. Selecting a tab scrolls the page map to that
   * form, which the map already did for its own clicks.
   */
  const renderFormPicker = (forms: ScanResults['forms'], index: number) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground mr-1">
        Form {index + 1} of {forms.length}
      </span>

      {forms.map((form, formIndex) => {
        const hint = formTabHint(form);
        const current = formIndex === index;
        /*
         * Labelled explicitly, because the accessible name computed from the
         * children trims each one before joining them: the tab announced
         * itself as "Form 2· hidden· 71".
         */
        const label = [
          `Form ${formIndex + 1}`,
          hint,
          typeof form.accessibility?.score === 'number' ? `${form.accessibility.score}` : null
        ]
          .filter(Boolean)
          .join(' · ');

        return (
          <button
            key={`pick-${form.formId || 'form'}-${formIndex}`}
            type="button"
            aria-label={label}
            aria-current={current}
            onClick={() => handleSelectForm(formIndex)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
              current
                ? 'bg-sky-600 border-sky-600 text-white'
                : 'bg-muted/40 border-border/50 text-muted-foreground hover:bg-muted/70'
            }`}
          >
            {isFormNotRendered(form) && <EyeOff className="h-3 w-3" />}
            {/* Spaces are explicit: JSX drops the whitespace between an
                expression and the next element, which made the accessible
                name read "Form 2· hidden· 71". */}
            <span>{`Form ${formIndex + 1}`}</span>
            {hint && <span className="font-normal opacity-80">{` · ${hint}`}</span>}
            {typeof form.accessibility?.score === 'number' && (
              <span className="font-normal opacity-80">{` · ${form.accessibility.score}`}</span>
            )}
          </button>
        );
      })}
    </div>
  );

  const renderVisualForm = (form: ScanResults['forms'][number], index: number) => (
    <div key={`${form.url || 'page'}-${form.formId || 'form'}-${index}`} className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold text-foreground">Form {index + 1}</h4>
        {form.formId && (
          <code className="text-xs font-mono text-muted-foreground">{form.formId}</code>
        )}
        {typeof form.accessibility?.score === 'number' && (
          <Badge variant="outline" className="text-xs">
            {form.accessibility.score}/100
          </Badge>
        )}
        {form.url && (
          <span className="text-xs text-muted-foreground truncate max-w-full">{form.url}</span>
        )}
      </div>

      {/* Keyed by form identity so switching forms resets the pinned
          selection without the panel clearing state in an effect. */}
      <FormVisualPanel
        key={`panel-${form.formId || 'form'}-${form.visual?.visualIndex ?? index}`}
        form={form}
        jobId={currentJob?.id ?? ''}
        showSeverityCounts={(currentJob?.results?.forms?.length ?? 0) > 1}
      />
    </div>
  );

  const downloadReport = () => {
    if (currentJob?.results) {
      try {
        const pdfGenerator = new PDFGenerator();
        pdfGenerator.generateReport(getNormalizedResults(currentJob), currentJob.id);
        
        const timestamp = new Date().toISOString().split('T')[0];
        const filename = `huxtek-${timestamp}-${currentJob.id.substring(0, 8)}.pdf`;
        
        pdfGenerator.download(filename);
        
        toast({
          title: "PDF Report Downloaded",
          description: "Your HuxTek report has been saved as a PDF",
        });
      } catch (error) {
        console.error('PDF generation failed:', error);
        toast({
          title: "Download Failed",
          description: "Unable to generate PDF report. Please try again.",
          variant: "destructive",
        });
      }
    }
  };

  /**
   * Slower once a scan has been going a while, because the early seconds are
   * where the visible steps happen and the later minutes are usually one
   * long wait on a single model call.
   *
   * Counted in polls rather than measured against `createdAt`: the timestamp
   * comes from the server, so a clock difference would decide the interval,
   * and a job record whose date is old would start at the slow rate on its
   * very first poll.
   */
  const pollDelayFor = (polls: number) =>
    polls < SLOW_POLL_AFTER_POLLS ? POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;

  /**
   * Stops the running scan, once the confirmation has been accepted.
   *
   * This originally had no confirmation, on the reasoning that a scan is
   * cheap to restart and a modal between someone and a stop button is worse
   * than an accidental stop. That trade is wrong here: the scan is not
   * cheap in the setting that matters, since a mis-click during a
   * presentation throws away a minute of waiting in front of an audience,
   * and a cancelled scan keeps no partial report to fall back on.
   *
   * The server marks the job cancelled before its agent reaches a
   * checkpoint, so the next poll already reports it. A 409 means the scan
   * finished in the meantime, which needs no apology -- the poll that
   * follows shows the report.
   */
  const handleCancelScan = async () => {
    if (!currentJob || isCancelling) {
      return;
    }

    setIsCancelling(true);

    try {
      await formAPI.cancelScan(currentJob.id);
      toast({
        title: 'Scan cancelled',
        description: 'Nothing further will be analysed.'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not cancel the scan';

      // A scan that has already finished is not a failed cancel.
      if (!/already finished/i.test(message)) {
        toast({
          title: 'Could not cancel the scan',
          description: message,
          variant: 'destructive'
        });
      }
    } finally {
      setIsCancelling(false);
    }
  };

  /**
   * "New Scan" is a navigation, not a state reset.
   *
   * Clearing state here as well would leave the address bar still naming the
   * old target while the form claimed otherwise. Going to `/` instead lets
   * the URL effect do the clearing, which keeps one rule in force: what the
   * query string says is what is on screen.
   */
  const resetScan = () => {
    // Clearing the field here, in a handler, rather than reacting to the
    // navigation: "New Scan" means start from nothing, whereas arriving at
    // `/` with Back means "let me look at the form again" and should keep
    // what was typed. Same destination, different intent.
    setUrl("");
    setFullCrawl(false);
    setUrlError(null);
    setSelectedFormIndex(0);
    setPerFormProgress({
      formsFound: 0,
      formsAnalyzed: 0
    });
    // Ends the finished scan's last poll. It would otherwise keep fetching a
    // job nobody is looking at, and its answer would be waiting to overwrite
    // whatever came next.
    claimScan();
    navigate("/");
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'queued':
        return <Clock className="h-5 w-5 text-yellow-500" />;
      case 'running':
        return <Zap className="h-5 w-5 text-blue-500 animate-pulse" />;
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'failed':
        return <AlertTriangle className="h-5 w-5 text-red-500" />;
      case 'cancelled':
        // Not an error icon: the scan did what it was told.
        return <CircleSlash className="h-5 w-5 text-muted-foreground" />;
      default:
        return <Bot className="h-5 w-5" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'queued':
        return 'bg-yellow-500/20 text-yellow-700 border-yellow-500/30';
      case 'running':
        return 'bg-blue-500/20 text-blue-700 border-blue-500/30';
      case 'completed':
        return 'bg-green-500/20 text-green-700 border-green-500/30';
      case 'failed':
        return 'bg-red-500/20 text-red-700 border-red-500/30';
      default:
        return 'bg-gray-500/20 text-gray-700 border-gray-500/30';
    }
  };

  return (
    <>
      <div>
        <div>

          {/* Pins below the header while fabricated results are on screen and
              nothing else is holding that job. The cards carry their own
              banners, but those scroll away and the findings underneath look
              exactly like a real audit once they do.

              It stops pinning once the report header is up, for two reasons.
              Both pinned at top-16 and collided -- measured: this strip, with
              the higher z-index, sat on top of the header bar and swallowed
              clicks meant for "Scan another form". And it would be saying the
              same thing twice inside 100px, since the bar carries a SAMPLE
              badge beside the score, which is the better label anyway: a
              screenshot of it shows the figure and its provenance together. */}
          {isSampleRun && (
            <div
              role="status"
              className={`${isFinished ? 'relative' : 'sticky top-16'} z-40 -mx-4 mb-6 flex items-center justify-center gap-2 border-y border-amber-500/40 bg-amber-950/80 px-4 py-2 text-sm text-amber-200 backdrop-blur`}
            >
              <FlaskConical className="h-4 w-4 shrink-0" />
              <span>
                <strong className="font-semibold">Sample data.</strong> These scores describe a
                fictional site, not a real audit.
              </span>
            </div>
          )}

          {/* The message, the action and the outcome in one grid, so "what is
              this", "what do I do" and "what do I get" are answered together.
              The headline used to be the product's own name in the largest
              type on the page, directly under the same name in the header,
              with the input a screenful below. All of this clears out once a
              scan starts, giving the results the full width. */}
          {!currentJob && (
            <div className="grid gap-10 lg:grid-cols-2 lg:gap-14 lg:items-center mb-16">
              <div className="text-center lg:text-left">
                {/* A real form, so Enter submits and an agent has a
                    submission boundary to work with rather than a div and a
                    click handler. noValidate keeps our own messaging
                    authoritative: `required` below states the constraint for
                    anything reading the markup, but letting the browser
                    enforce type="url" would start rejecting the bare domains
                    this has always accepted. */}
                <h1 className="text-4xl md:text-5xl font-bold text-foreground leading-tight mb-5">
                  Can an AI agent fill in your form?
                </h1>

                <p className="text-lg text-muted-foreground leading-relaxed mb-8">
                  Agents are starting to book, buy and sign up for real people. When one
                  cannot read your form, that is a customer you never hear about.
                </p>

                <form
                  className="space-y-4"
                  // A real submission path, not a decorative one: /api/scan
                  // accepts form-encoded bodies, so an agent that submits
                  // this natively starts a scan and gets the job id back.
                  // Declaring an action that 400s would be markup lying to
                  // the agent we are trying to help.
                  action={getScanUrl()}
                  method="post"
                  onSubmit={handleScanSubmit}
                  noValidate
                >
                  {/* URL Input */}
                  <div className="flex flex-col md:flex-row gap-4">
                    <div className="flex-1 relative">
                      {/* A real label, associated by `for`, rather than an
                          aria-label: the association is then in the markup
                          itself. Visually hidden because the placeholder and
                          the card title already carry it on screen. Wording
                          matches what screen readers already announced. */}
                      <label htmlFor="huxtek-url-input" className="sr-only">
                        Website URL for AI form analysis
                      </label>

                      <Input
                        type="url"
                        placeholder="https://example.com"
                        value={urlFromState}
                        onChange={(e) => {
                          setUrl(e.target.value);
                          setUrlError(null);
                        }}
                        className="h-14 text-lg bg-input/50 border-border/50 focus:border-primary"
                        // AI Agent friendly attributes
                        data-ai-role="website-url-input"
                        data-ai-description="Enter website URL to analyze forms for AI agent compatibility"
                        data-ai-expected-format="https://example.com"
                        data-ai-validation="url"
                        // Both referenced unconditionally. Wiring the error
                        // region in only once an error exists means the
                        // association never existed when assistive tech built
                        // its picture of the field, and an agent re-reading
                        // the field after a failure has no way to know which
                        // element holds the message. An empty region
                        // contributes nothing to the description, so there is
                        // no cost to naming it up front.
                        aria-describedby="url-input-description url-input-error"
                        // Only ever true when it IS invalid, which is the
                        // one of the two that should be conditional.
                        aria-invalid={urlError ? true : undefined}
                        id="huxtek-url-input"
                        // Named exactly as /api/scan reads it, so a native
                        // submit genuinely works and the markup and the API
                        // speak one vocabulary.
                        name="url"
                        autoComplete="url"
                        required
                      />
                      <div id="url-input-description" className="sr-only">
                        Enter the complete URL of the website you want to analyze for AI agent form compatibility. Include https:// at the beginning.
                      </div>

                      {/* Announced as it appears, and readable after a failed
                          submit -- a toast is gone before an agent can look. */}
                      <p
                        id="url-input-error"
                        role="alert"
                        aria-live="polite"
                        className={`mt-2 text-sm text-left text-destructive ${urlError ? '' : 'sr-only'}`}
                      >
                        {urlError ?? ''}
                      </p>
                    </div>
                    
                    {/* Says so when the deployment will not accept a real
                        target, rather than letting someone fill the field,
                        press Scan and collect a 403. The API is what enforces
                        it; this is only the explanation. */}
                    {!realScansEnabled && (
                      <div
                        role="status"
                        className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-200 text-left"
                      >
                        <strong className="font-semibold">Demo mode.</strong> Live scans are
                        switched off on this instance, so the field below will not accept a
                        site. The sample report shows the complete output.
                      </div>
                    )}

                    {/* Analysis Button */}
                    <div className="flex justify-center">
                      <Button
                        variant="scan"
                        size="xl"
                        className="min-w-[160px]"
                        // AI Agent friendly attributes
                        data-ai-role="form-analysis-trigger"
                        data-ai-action="analyze-website-forms"
                        data-ai-description="Start AI-powered analysis of website forms for compatibility and accessibility"
                        aria-label="Start AI form analysis"
                        id="huxtek-scan-button"
                        type="submit"
                        // Acknowledges the click immediately. Without this
                        // the label sat unchanged for the length of the
                        // round trip and a second press started a second
                        // scan.
                        disabled={isStarting}
                        aria-busy={isStarting}
                      >
                        {isStarting ? (
                          <>
                            <Loader2 className="h-5 w-5 animate-spin" />
                            Starting&hellip;
                          </>
                        ) : (
                          <>
                            <Scan className="h-5 w-5" />
                            {/* Was "Full AI Scan", which contradicted the
                                options immediately below reading
                                "single page". */}
                            Scan my form
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Both options behind a disclosure, with their current
                      state in the summary. Two toggles above the fold were
                      two decisions a first-time visitor had no basis to make.
                      A native <details> keeps them in the DOM and in the
                      form, so a native submit still carries their values. */}
                  <details className="group rounded-lg border border-border/30 bg-muted/20">
                    <summary className="cursor-pointer list-none px-4 py-3 text-sm text-muted-foreground hover:text-foreground">
                      <span className="inline-flex items-center gap-2">
                        <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                        Options
                        <span className="text-muted-foreground/70">
                          &mdash; {fullCrawl ? 'entire site' : 'single page'} &middot;{' '}
                          {MODEL_PROVIDER_DETAILS[modelProvider].label}
                        </span>
                      </span>
                    </summary>

                    <div className="space-y-4 p-4 pt-1">
                  {/* Full Website Crawl Toggle.
                      Grouped in markup, not just visually: the card reads as
                      a group on screen, but without a fieldset that grouping
                      has to be inferred from layout. min-w-0 and the reset
                      keep the fieldset from drawing its own box or breaking
                      the flex layout inside it. */}
                  <fieldset className="min-w-0 border-0 p-0 m-0">
                    <legend className="sr-only">Scan scope</legend>

                    <div className="relative p-4 rounded-lg border transition-all duration-200 bg-muted/30 border-border/30">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-4 flex-1">
                          <div className={`p-2 rounded-lg ${
                            fullCrawl
                              ? 'bg-violet-500/20 text-violet-400' 
                              : 'bg-slate-700/50 text-slate-400'
                          }`}>
                            {fullCrawl ? (
                              <Globe className="h-5 w-5" />
                            ) : (
                              <FileText className="h-5 w-5" />
                            )}
                          </div>
                          
                          <div className="flex-1">
                            {/* Names the option, and does not change with the
                                state. This heading is the switch's accessible
                                name, so making it state-dependent -- which it
                                was, to resolve a contradiction with the text
                                below -- meant a screen reader announced
                                "Scanning this page only, switch, off" and the
                                control renamed itself when toggled. The state
                                belongs in the description instead. */}
                            <h3
                              id="full-crawl-heading"
                              className="text-base font-semibold text-white mb-1"
                            >
                              Crawl entire website
                            </h3>

                            <p id="full-crawl-description" className="text-sm text-slate-400">
                              {fullCrawl
                                ? "On: crawling all discoverable pages across the website"
                                : "Off: analyzing only the URL you provide"
                              }
                            </p>
                          </div>
                        </div>
                        
                        {/* A native checkbox, not a custom widget. The
                            previous Radix switch put `id` on a button while
                            the submittable value lived on a hidden checkbox
                            carrying `name`, so id-based and name-based
                            targeting acted on different elements. One control
                            now carries both, and its value really submits.
                            role="switch" keeps the toggle semantics. */}
                        <input
                          type="checkbox"
                          role="switch"
                          // id and name identical, and both exactly what the
                          // endpoint reads.
                          id="fullCrawl"
                          name="fullCrawl"
                          aria-labelledby="full-crawl-heading"
                          aria-describedby="full-crawl-description"
                          checked={fullCrawl}
                          onChange={(event) => handleFullCrawlToggle(event.target.checked)}
                          className="relative h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-full border-2 border-slate-500 bg-slate-600 transition-colors before:absolute before:left-0.5 before:top-0.5 before:h-4 before:w-4 before:rounded-full before:bg-white before:transition-transform before:content-[''] checked:border-violet-600 checked:bg-violet-600 checked:before:translate-x-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                        />
                      </div>
                    </div>
                  </fieldset>

                  {/* Analysis model switch */}
                  <fieldset className="min-w-0 border-0 p-0 m-0">
                    <legend className="sr-only">Analysis model</legend>

                    <div className="relative p-4 rounded-lg border transition-all duration-200 bg-muted/30 border-border/30">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center space-x-4 flex-1">
                        <div className="p-2 rounded-lg bg-sky-500/20 text-sky-400">
                          <Sparkles className="h-5 w-5" />
                        </div>

                        <div className="flex-1">
                          <h3 className="text-base font-semibold text-white mb-1">
                            Analysis model
                          </h3>

                          <p className="text-sm text-slate-400">
                            {MODEL_PROVIDER_DETAILS[modelProvider].blurb}
                          </p>
                        </div>
                      </div>

                      <div
                        role="radiogroup"
                        aria-label="Analysis model"
                        className="flex rounded-lg border border-slate-600 overflow-hidden"
                      >
                        {/* Native radios with real labels. They were buttons
                            carrying aria-checked and no submittable input, so
                            an agent could read the selection but never set or
                            submit it. The input is visually hidden rather
                            than removed, so it still takes focus and still
                            posts its value; the label is what you see. */}
                        {Object.values(MODEL_PROVIDERS).map((provider) => (
                          <span key={provider} className="flex">
                            <input
                              type="radio"
                              id={`modelProvider-${provider}`}
                              name="modelProvider"
                              value={provider}
                              checked={modelProvider === provider}
                              onChange={() => handleModelProviderSelect(provider)}
                              className="peer sr-only"
                            />

                            <label
                              htmlFor={`modelProvider-${provider}`}
                              className={`cursor-pointer px-4 py-2 text-sm font-medium transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-sky-300 ${
                                modelProvider === provider
                                  ? 'bg-sky-600 text-white'
                                  : 'bg-slate-800/60 text-slate-300 hover:bg-slate-700/60'
                              }`}
                            >
                              {MODEL_PROVIDER_DETAILS[provider].label}
                            </label>
                          </span>
                        ))}
                      </div>
                    </div>
                    </div>
                  </fieldset>
                    </div>
                  </details>

                  {/* Dev Mode lives in the header, outside this form, so a
                      native submit would otherwise silently lose it and run
                      a real scan against someone's site. */}
                  <input
                    type="hidden"
                    id="devMode"
                    name="devMode"
                    value={isDevMode ? 'true' : 'false'}
                  />

                </form>
              </div>

              <div className="rounded-xl border border-border/50 bg-card/40 backdrop-blur-sm p-4 shadow-glow">
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
                  What you get
                </p>

                <FormPreviewIllustration />

                <p className="text-sm text-muted-foreground mt-3 text-left">
                  Every problem marked on a screenshot of your own form, with the fix
                  written out field by field.
                </p>

                {/* The only way in, and the right one: the panel already does
                    the work of explaining the product, so the button that
                    delivers it belongs here. A second one beside the input
                    was the same action twice within a few hundred pixels,
                    competing with the primary for attention.
                    
                    Lighter border and a surface of its own so it reads as a
                    button against the panel behind it. The default outline
                    on this dark theme is nearly borderless, which is how the
                    first version of this ended up looking like a link. */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleShowSample}
                  disabled={isStarting}
                  aria-busy={isStarting}
                  className="mt-4 w-full border-border bg-muted/50 text-foreground hover:bg-muted hover:text-foreground"
                >
                  {isStarting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Loading sample&hellip;
                    </>
                  ) : (
                    <>
                      <Eye className="h-4 w-4 mr-2" />
                      See a full sample report
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* The report's own header, pinned. Replaces a "New Scan" button
              that sat mid-page inside the progress card, far enough down a
              3,000px report that the Back button was the quicker way to run
              another scan. */}
          {isFinished && currentJob && (
            /*
             * No wrapper around this block. A sticky element only sticks
             * within its own parent's box, and a wrapper sized to the header
             * gave it a 141px travel before it scrolled away with the rest.
             * Its parent has to be the element that spans the whole report.
             */
            <>
              <ReportActionBar
                score={reportScore}
                url={currentJob.url}
                formCount={reportForms.length}
                modelLabel={currentJob.modelLabel}
                isSampleRun={isSampleRun}
                analyser={reportAnalyser}
                /*
                 * Offered only when there is a form in the report. A
                 * zero-form scan has results -- a page was fetched, a
                 * summary written -- but a PDF of it is a cover sheet and
                 * empty sections, which is worse than no button.
                 */
                onDownload={reportForms.length > 0 ? downloadReport : undefined}
                onNewScan={resetScan}
              />

              {/* What the progress card is worth once it has nothing left to
                  report: one line, expandable for the job id and the step it
                  finished on. */}
              <details className="mb-6 rounded-lg border border-border/40 bg-muted/20 px-4 py-2.5">
                <summary className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground cursor-pointer list-none">
                  {getStatusIcon(currentJob.status)}
                  <span className="text-foreground font-medium">
                    {FINISHED_HEADLINES[currentJob.status] ?? 'Scan complete'}
                  </span>
                  <span>&middot;</span>
                  <span>{currentJob.modelLabel ?? 'Unknown model'}</span>
                  {currentJob.model && <span>&middot; {currentJob.model}</span>}
                  {currentJob.devMode && (
                    <Badge variant="secondary" className="text-[10px]">
                      <FlaskConical className="h-3 w-3 mr-1" />
                      Mock Data
                    </Badge>
                  )}
                  <span className="ml-auto underline">scan details</span>
                </summary>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs mt-3 pt-3 border-t border-border/40">
                  <div>
                    <span className="text-muted-foreground">Target URL:</span>
                    <div className="font-medium truncate">{currentJob.url}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Job ID:</span>
                    <div className="font-mono">{currentJob.id}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Started:</span>
                    <div className="font-medium">
                      {new Date(currentJob.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              </details>

              {currentJob.error && (
                <div className="bg-destructive/10 p-4 rounded-lg border border-destructive/30 text-left mb-6">
                  {/*
                    The panel a failed scan actually reaches. 'failed' is a
                    terminal status, so the progress card and its own error
                    block are already gone by the time there is an error to
                    show -- which is why the first version of this fix
                    changed the wrong one of the two and nothing happened.
                  */}
                  <h4 className="font-semibold text-destructive mb-2">
                    {PAGE_ACCESS_HEADINGS[currentJob.errorKind ?? ''] ?? 'Scan failed'}
                  </h4>
                  <p className="text-destructive text-sm">{currentJob.error}</p>
                  {currentJob.errorKind ? (
                    <p className="text-muted-foreground text-xs mt-3">
                      Nothing is wrong with your setup, and this says nothing about the
                      page's forms &mdash; there was simply no page to read. Try a URL that
                      is not behind the block.
                    </p>
                  ) : (
                    !currentJob.devMode && (
                      <p className="text-muted-foreground text-xs mt-3">
                        No API keys yet? Switch the header toggle to Dev Mode to walk the
                        entire flow on sample data &mdash; no keys required.
                      </p>
                    )
                  )}
                </div>
              )}
            </>
          )}

          {/* Scan Progress */}
          {currentJob && !isFinished && (
            <Card className="bg-card/50 backdrop-blur-sm border-border/50 shadow-glow mb-12 max-w-4xl mx-auto">
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(currentJob.status)}
                    AI Scan Progress
                  </div>
                  <div className="flex items-center gap-2">
                    {currentJob.modelLabel && (
                      <Badge variant="outline" className="text-xs">
                        <Sparkles className="h-3 w-3 mr-1" />
                        {currentJob.modelLabel}
                        {currentJob.model ? ` \u00b7 ${currentJob.model}` : ''}
                      </Badge>
                    )}
                    {currentJob.devMode && (
                      <Badge variant="secondary" className="text-xs">
                        <FlaskConical className="h-3 w-3 mr-1" />
                        Mock Data
                      </Badge>
                    )}
                    <Badge className={getStatusColor(currentJob.status)}>
                      {currentJob.status.toUpperCase()}
                    </Badge>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Mock-run marker, driven by the job record rather than the toggle */}
                {currentJob.devMode && (
                  <Alert className="bg-muted/30 border-border/50 text-left">
                    <FlaskConical className="h-4 w-4" />
                    <AlertTitle>Mock Data &mdash; sample output, not a real scan</AlertTitle>
                    <AlertDescription className="text-muted-foreground">
                      These results come from the bundled sample fixtures. Switch the header
                      toggle to Production and add API keys to run a real audit.
                    </AlertDescription>
                  </Alert>
                )}

                {/* Progress Bar */}
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>{currentJob.currentStep}</span>
                    <span>{currentJob.progress}%</span>
                  </div>
                  <Progress value={currentJob.progress} className="h-3" />
                </div>

                {/* Per-Form Analysis Progress */}
                {(perFormProgress.formsFound > 0 || (currentJob.formsFound || 0) > 0) && (
                  <div className="bg-muted/30 backdrop-blur-sm p-4 rounded-lg border border-border/30">
                    <h4 className="font-semibold text-foreground mb-3 flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Per-Form Analysis Progress
                    </h4>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm mb-3">
                      <div className="text-center">
                        <div className="text-2xl font-bold text-blue-500">
                          {currentJob.formsFound || perFormProgress.formsFound}
                        </div>
                        <div className="text-muted-foreground">Forms Found</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-green-500">
                          {currentJob.formsAnalyzed || perFormProgress.formsAnalyzed}
                        </div>
                        <div className="text-muted-foreground">Forms Analyzed</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-orange-500">
                          {Math.max(0, (currentJob.formsFound || perFormProgress.formsFound) - (currentJob.formsAnalyzed || perFormProgress.formsAnalyzed))}
                        </div>
                        <div className="text-muted-foreground">Remaining</div>
                      </div>
                    </div>
                    
                    {/* Per-form progress bar */}
                    {(currentJob.formsFound || perFormProgress.formsFound) > 0 && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs">
                          <span>Form Analysis Progress</span>
                          <span>
                            {currentJob.formsAnalyzed || perFormProgress.formsAnalyzed} / {currentJob.formsFound || perFormProgress.formsFound}
                          </span>
                        </div>
                        <Progress 
                          value={((currentJob.formsAnalyzed || perFormProgress.formsAnalyzed) / (currentJob.formsFound || perFormProgress.formsFound)) * 100} 
                          className="h-2" 
                        />
                      </div>
                    )}
                    
                  </div>
                )}

                {/* Scan Details */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Target URL:</span>
                    <div className="font-medium truncate">{currentJob.url}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Job ID:</span>
                    <div className="font-mono text-xs">{currentJob.id}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Started:</span>
                    <div className="font-medium">
                      {new Date(currentJob.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                </div>

                {/* Error Display */}
                {currentJob.error && (
                  <div className="bg-red-500/20 backdrop-blur-sm p-4 rounded-lg border border-red-500/30 text-left">
                    <h4 className="font-semibold text-red-600 mb-2">
                      {PAGE_ACCESS_HEADINGS[currentJob.errorKind ?? ''] ?? 'Error Occurred'}
                    </h4>
                    <p className="text-red-500 text-sm">{currentJob.error}</p>
                    {/*
                      The follow-up depends on whose problem it was. This used
                      to offer "no API keys yet? try Dev Mode" for every
                      failure, which is irrelevant advice when the truth is
                      that the site refused the request -- and it quietly
                      implies the scan failed because of our configuration.
                    */}
                    {currentJob.errorKind ? (
                      <p className="text-muted-foreground text-xs mt-3">
                        Nothing is wrong with your setup, and this says nothing about the
                        page's forms &mdash; there was simply no page to read. Try a URL
                        that is not behind the block.
                      </p>
                    ) : (
                      !currentJob.devMode && (
                        <p className="text-muted-foreground text-xs mt-3">
                          No API keys yet? Switch the header toggle to Dev Mode to walk the
                          entire flow on sample data &mdash; no keys required.
                        </p>
                      )
                    )}
                  </div>
                )}

                {/*
                  One action, and it is the only one that makes sense while a
                  scan is running. "New Scan" used to sit here, which offered
                  to walk away from the scan without stopping it.

                  Every finished state, failures included, gets
                  ReportActionBar above with its own new-scan and download
                  actions, so this card needs nothing else.
                */}
                <div className="flex justify-center">
                  <AlertDialog>
                    {/*
                      Outline until hovered, then destructive. The action is
                      not reversible -- a cancelled scan keeps no partial
                      report -- so the colour says so at the moment of
                      pointing at it, without painting a permanent red
                      button into the middle of a working scan.
                    */}
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isCancelling}
                        className="hover:bg-destructive hover:text-destructive-foreground hover:border-destructive focus-visible:ring-destructive"
                      >
                        <CircleSlash className="h-4 w-4 mr-2" />
                        {isCancelling ? 'Stopping...' : 'Cancel scan'}
                      </Button>
                    </AlertDialogTrigger>

                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Stop this scan?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The scan will stop where it is and no report will be produced.
                          Anything analysed so far is discarded, and scanning
                          {currentJob.url ? ' this page' : ' again'} means starting over.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        {/* Carrying on is the safe option, so it is the one
                            that reads as ordinary. */}
                        <AlertDialogCancel>Keep scanning</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleCancelScan}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Stop scan
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Results Summary */}
          {currentJob?.results && (
            <Card className="bg-card/50 backdrop-blur-sm border-border/50 shadow-glow mb-12 max-w-6xl mx-auto">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle className="h-6 w-6 text-green-500" />
                  Comprehensive Scan Results
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/* Mock-run marker, so sample results are never read as a real audit */}
                {currentJob.devMode && (
                  <Alert className="mb-6 bg-muted/30 border-border/50 text-left">
                    <FlaskConical className="h-4 w-4" />
                    <AlertTitle>Mock Data &mdash; sample output, not a real scan</AlertTitle>
                    <AlertDescription className="text-muted-foreground">
                      Every score, form and URL below comes from the bundled sample fixtures.
                      The downloaded PDF is marked as mock output too.
                    </AlertDescription>
                  </Alert>
                )}

                {/* The scanned form comes first; numbers and prose sit behind
                    the Details tab so the visual is what lands on screen. */}
                <Tabs defaultValue={RESULT_TABS.VISUAL} className="w-full">
                  <TabsList>
                    <TabsTrigger value={RESULT_TABS.VISUAL}>
                      <Eye className="h-4 w-4 mr-2" />
                      Visual
                    </TabsTrigger>
                    <TabsTrigger value={RESULT_TABS.DETAILS}>
                      <FileText className="h-4 w-4 mr-2" />
                      Details
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value={RESULT_TABS.VISUAL} className="mt-4 space-y-5">
                    {renderScoreStrip()}
                    {renderVisualTab()}
                  </TabsContent>

                  {/* Score, then what to do about it, then the reference
                      detail. The dashboard that used to open this tab stated
                      the same figure three more ways and fabricated four
                      metrics to fill the space. */}
                  <TabsContent value={RESULT_TABS.DETAILS} className="mt-4 space-y-6">
                    <ScoreBreakdown forms={reportForms} score={reportScore} />

                    <FindingsList forms={reportForms} />

                    <FormAnalysisDisplay
                      forms={currentJob.results.forms || []}
                      summary={currentJob.results.summary}
                      aiSummary={getNormalizedResults(currentJob).aiSummary}
                      scanMode={getNormalizedResults(currentJob).scanMode}
                    />
                  </TabsContent>
                </Tabs>

                {/* Scan Metadata */}
                {currentJob.results.scanMetadata && (
                  <div className="mt-6 pt-4 border-t border-border/50">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-muted-foreground">
                      <div>
                        <span className="font-medium">Duration:</span> {
                          currentJob.results.scanMetadata.scanDuration ? 
                          Math.round(currentJob.results.scanMetadata.scanDuration / 1000) + 's' : 
                          'N/A'
                        }
                      </div>
                      <div>
                        <span className="font-medium">Iterations:</span> {currentJob.results.scanMetadata.iterations || 'N/A'}
                      </div>
                      <div>
                        <span className="font-medium">Messages:</span> {currentJob.results.scanMetadata.totalMessages || 'N/A'}
                      </div>
                      <div>
                        <span className="font-medium">Completed:</span> {
                          currentJob.results.scanMetadata.completedAt ? 
                          new Date(currentJob.results.scanMetadata.completedAt).toLocaleTimeString() : 
                          'N/A'
                        }
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Features */}
          {!currentJob && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-16">
              <div className="text-center">
                <div className="w-16 h-16 bg-primary/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Bot className="h-8 w-8 text-primary" />
                </div>
                {/* Said "GPT-5 driven autonomous crawling" long after the
                    analysis moved to Muse. Outcomes now, not plumbing. */}
                <h3 className="text-xl font-semibold mb-2">See it like an agent does</h3>
                <p className="text-muted-foreground">
                  Your form, screenshotted and marked up at every point it breaks down
                </p>
              </div>
              <div className="text-center">
                <div className="w-16 h-16 bg-accent/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Scan className="h-8 w-8 text-accent" />
                </div>
                <h3 className="text-xl font-semibold mb-2">A fix for every finding</h3>
                <p className="text-muted-foreground">
                  The attribute to add and the field to add it to, not "improve accessibility"
                </p>
              </div>
              <div className="text-center">
                <div className="w-16 h-16 bg-primary-glow/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Zap className="h-8 w-8 text-primary-glow" />
                </div>
                {/* "Live progress tracking with WebSocket updates" described
                    our transport to someone who does not have one. */}
                <h3 className="text-xl font-semibold mb-2">Scored out of 100</h3>
                <p className="text-muted-foreground">
                  One number to track, and the eight categories that produced it
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
