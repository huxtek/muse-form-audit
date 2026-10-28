import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Bot, Scan, Download, ExternalLink, AlertTriangle, CheckCircle, ChevronRight, Clock, Loader2, Zap, Globe, FileText, FlaskConical, Sparkles, Eye } from "lucide-react";
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
import type { IssueSeverity } from "@/lib/scan-types";
import { PerformanceDashboard } from "@/components/PerformanceDashboard";
import FormAnalysisDisplay from "@/components/FormAnalysisDisplay";
import FormVisualPanel from "@/components/FormVisualPanel";
import PageMapView from "@/components/PageMapView";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

interface ScanJob {
  id: string;
  url: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'completed_with_errors';
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
  const [perFormProgress, setPerFormProgress] = useState<PerFormProgress>({
    formsFound: 0,
    formsAnalyzed: 0
  });
  const { toast } = useToast();
  const { isDevMode } = useDevMode();

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
              
              toast({
                title: "Forms Discovered",
                description: `Found ${update.formsCount} forms on the page. Starting individual analysis...`,
              });
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

  const validateUrl = (url: string): boolean => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

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
        pollJobStatus(started.jobId);
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
  const pollJobStatus = async (jobId: string) => {
    try {
      const job = await formAPI.getReport(jobId);
      setJobState(job);

      if (job.status === 'running' || job.status === 'queued') {
        setTimeout(() => pollJobStatus(jobId), 2000);
      }
    } catch (error) {
      console.error('Polling error:', error);
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

    if (!validateUrl(url)) {
      setUrlError('That does not look like a website URL. Try https://example.com');
      toast({
        title: "Invalid URL",
        description: "Please enter a valid website URL (e.g., https://example.com)",
        variant: "destructive",
      });
      return;
    }

    setUrlError(null);

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
    navigate(buildScanPath({ url, fullCrawl, modelProvider }));

    // Set alongside the navigation so the results, whenever they land, are
    // bound to the address that asked for them.
    setJobTarget(url);

    try {
      const scanResults = await formAPI.startScan({
        url,
        fullCrawl, // Pass the crawling mode to the backend
        devMode, // Header toggle, or forced on by the sample report
        modelProvider // Which model should run the analysis
      });
      
      // Check if this is immediate results (our current backend) or job-based response
      if (scanResults.success && scanResults.scanType) {
        // Immediate results - create a completed job structure
        setJobState({
          id: createImmediateScanId(),
          url,
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
          url,
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
        pollJobStatus(scanResults.jobId);
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

    const counts = forms.reduce(
      (acc, form) => {
        for (const issue of form.accessibility?.fieldIssues ?? []) {
          acc[issue.severity] = (acc[issue.severity] ?? 0) + 1;
        }

        return acc;
      },
      { high: 0, medium: 0, low: 0 } as Record<IssueSeverity, number>
    );

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
          {SEVERITY_ORDER.every((severity) => counts[severity] === 0) ? (
            <Badge variant="outline" className="text-xs">
              <CheckCircle className="h-3 w-3 mr-1" />
              No field-level issues
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

    // With a page map the map itself is the picker: the user sees the page
    // they scanned and clicks the form they want.
    if (hasPageMap) {
      // The map only shows the selected form's page, so when a crawl spans
      // several pages the map alone cannot reach every form. The numeric
      // picker is what makes the rest reachable.
      const pageCount = new Set(
        forms.map((form) => form.visual?.pageMap?.pageIndex).filter((value) => value !== undefined)
      ).size;

      return (
        <div className="space-y-5">
          {pageCount > 1 && renderFormPicker(forms, index)}

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

  const renderFormPicker = (forms: ScanResults['forms'], index: number) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground mr-1">
        Form {index + 1} of {forms.length}
      </span>

      {forms.map((form, formIndex) => (
        <button
          key={`pick-${form.formId || 'form'}-${formIndex}`}
          type="button"
          aria-current={formIndex === index}
          onClick={() => handleSelectForm(formIndex)}
          className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
            formIndex === index
              ? 'bg-sky-600 border-sky-600 text-white'
              : 'bg-muted/40 border-border/50 text-muted-foreground hover:bg-muted/70'
          }`}
        >
          {formIndex + 1}
        </button>
      ))}
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
        const filename = `muse-form-audit-${timestamp}-${currentJob.id.substring(0, 8)}.pdf`;
        
        pdfGenerator.download(filename);
        
        toast({
          title: "PDF Report Downloaded",
          description: "Your Muse Form Audit report has been saved as a PDF",
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

          {/* Sticks below the header for as long as fabricated results are on
              screen. The cards carry their own banners, but those scroll away
              and the findings underneath look exactly like a real audit once
              they do. */}
          {isSampleRun && (
            <div
              role="status"
              className="sticky top-16 z-40 -mx-4 mb-6 flex items-center justify-center gap-2 border-y border-amber-500/40 bg-amber-950/80 px-4 py-2 text-sm text-amber-200 backdrop-blur"
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
                      <label htmlFor="muse-form-audit-url-input" className="sr-only">
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
                        id="muse-form-audit-url-input"
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
                        id="muse-form-audit-scan-button"
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

          {/* Scan Progress */}
          {currentJob && (
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
                    <h4 className="font-semibold text-red-600 mb-2">Error Occurred</h4>
                    <p className="text-red-500 text-sm">{currentJob.error}</p>
                    {!currentJob.devMode && (
                      <p className="text-muted-foreground text-xs mt-3">
                        No API keys yet? Switch the header toggle to Dev Mode to walk the
                        entire flow on sample data &mdash; no keys required.
                      </p>
                    )}
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-2 justify-center">
                  {(currentJob.status === 'completed' || currentJob.status === 'completed_with_errors') && currentJob.results && (
                    <Button onClick={downloadReport} variant="outline">
                      <Download className="h-4 w-4 mr-2" />
                      Download PDF Report
                    </Button>
                  )}
                  <Button onClick={resetScan} variant="outline">
                    <ExternalLink className="h-4 w-4 mr-2" />
                    New Scan
                  </Button>
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

                  <TabsContent value={RESULT_TABS.DETAILS} className="mt-4 space-y-6">
                    <PerformanceDashboard results={currentJob.results} />

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
