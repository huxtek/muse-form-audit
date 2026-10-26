/**
 * The shapes the scanner backend returns, in one place.
 *
 * Derived from the two payloads the server actually produces, which are
 * committed verbatim as fixtures in `server/mock-data/single-page-response.json`
 * (per-form analysis of one page) and `server/mock-data/full-crawl-response.json`
 * (site crawl). Members are optional because the two modes populate different
 * subsets of the same envelope and the agent omits rather than nulls: the
 * crawl puts `aiSummary`/`scanMode`/`targetUrl` at the top of `results`, while
 * the single-page run nests them under `results.summary` and names the target
 * `url`. See `src/lib/scan-results.ts` for the normalizer that reconciles them.
 *
 * These are descriptive, not prescriptive. Nothing validates a response against
 * them at runtime, so they document observed payloads rather than guarantee them.
 */

/** A single input, select or textarea inside a form, as extracted by the agent. */
export interface FormField {
  id?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  value?: string;
  ariaLabel?: string;
  label?: string;
  options?: string[];
}

/** Coarse flags about a form, used to pick an icon and a form type label. */
export interface FormCharacteristics {
  hasCaptcha?: boolean;
  hasFileUpload?: boolean;
  hasMultiStep?: boolean;
  hasValidation?: boolean;
  isLoginForm?: boolean;
  isContactForm?: boolean;
  isSearchForm?: boolean;
}

/** One scored dimension of the accessibility breakdown. */
export interface AccessibilityCategory {
  score?: number;
  maxScore?: number;
  issues?: string[];
}

/** The eight dimensions the scanner scores a form across. */
export interface AccessibilityCategories {
  structural?: AccessibilityCategory;
  identification?: AccessibilityCategory;
  labeling?: AccessibilityCategory;
  inputHints?: AccessibilityCategory;
  dataTypes?: AccessibilityCategory;
  validation?: AccessibilityCategory;
  submission?: AccessibilityCategory;
  accessibility?: AccessibilityCategory;
}

/** Boolean capability flags an AI agent needs in order to drive the form. */
export interface AIAccessibility {
  hasLabels?: boolean;
  hasAriaLabels?: boolean;
  hasNameAttributes?: boolean;
  hasValidation?: boolean;
  hasCaptcha?: boolean;
  hasFileUpload?: boolean;
  hasProperStructure?: boolean;
  hasAutocomplete?: boolean;
  hasDataTypes?: boolean;
}

/**
 * A per-field entry of `accessibility.fieldAnalysis`.
 *
 * The scanner currently always emits an empty array here (`server/tools.js`
 * sets `fieldAnalysis: []`, `server/agent.js` passes it through), so the only
 * members documented are the two that `server/agent.js` scores on when the
 * array is non-empty. Widen this if the scanner starts populating it.
 */
export interface FieldAnalysis {
  name?: string;
  type?: string;
  hasName?: boolean;
  hasLabel?: boolean;
  hasAriaLabel?: boolean;
}

/** The accessibility report attached to each analyzed form. */
export interface FormAccessibility {
  score?: number;
  maxScore?: number;
  issues?: string[];
  recommendations?: string[];
  categories?: AccessibilityCategories;
  aiAccessibility?: AIAccessibility;
  fieldAnalysis?: FieldAnalysis[];
}

/** Bookkeeping the scanner records alongside a form's analysis. */
export interface FormMetadata {
  fieldCount?: number;
  hasRequiredFields?: boolean;
  hasLabels?: boolean;
  hasValidation?: boolean;
  hasCaptcha?: boolean;
  hasFileUpload?: boolean;
  analysisTimestamp?: string;
  comprehensiveAnalysis?: boolean;
}

/**
 * One analyzed form.
 *
 * The first block is what both scan modes return. The second block holds the
 * alternative score field names the dashboard still reads for backward
 * compatibility with older result payloads.
 */
export interface AnalyzedForm {
  formId?: string;
  url?: string;
  pageTitle?: string;
  characteristics?: FormCharacteristics;
  fields?: FormField[];
  accessibility?: FormAccessibility;
  metadata?: FormMetadata;
  analyzedAt?: string;
  globalFormIndex?: number;

  id?: string;
  accessibilityScore?: number;
  overallScore?: number;
  aiCompatibilityScore?: number;
  criticalBlockers?: number;
}

/** Scan-wide counts. `aiSummary`/`scanMode` appear here in single-page mode only. */
export interface ScanSummary {
  totalPages?: number;
  totalForms?: number;
  totalFormsFound?: number;
  discoveredUrls?: number;
  visitedUrls?: number;
  coveragePercentage?: number;
  formsAnalyzed?: number;
  aiSummary?: string;
  scanMode?: string;
}

/** One crawled page, in the older page-oriented result shape. */
export interface ScanPage {
  url?: string;
  pageTitle?: string;
  forms?: AnalyzedForm[];
}

/** Crawl statistics attached to a full-crawl result. */
export interface CrawlInfo {
  pagesDiscovered?: number;
  pagesScanned?: number;
  formsFound?: number;
}

/** Timing and agent-loop bookkeeping for a completed scan. */
export interface ScanMetadata {
  scanDuration?: number;
  iterations?: number;
  totalMessages?: number;
  completedAt?: string;
  jobId?: string;
  targetUrl?: string;
}

/** Per-scan metadata emitted by the single-page (per-form) mode. */
export interface PerFormScanMetadata {
  targetUrl?: string;
  analysisTime?: number;
  perFormMode?: boolean;
  formsFound?: number;
  formsAnalyzed?: number;
  stoppedDueToLimit?: boolean;
}

/**
 * The aggregate shape the dashboard reads when a result carries a
 * pre-computed comprehensive analysis.
 *
 * Note: no code path in this backend populates `results.analysis`, so this
 * describes a payload the UI tolerates rather than one it currently receives.
 */
export interface ComprehensiveAnalysis {
  totalForms?: number;
  accessibilityScore?: number;
  issues?: string[];
  recommendations?: string[];
  forms?: AnalyzedForm[];
  detailedAnalysis?: {
    avgAICompatibilityScore?: number;
    totalCriticalBlockers?: number;
    totalPartialBlockers?: number;
    performanceMetrics?: {
      avgDiscoveryRate?: number;
      avgIdentificationRate?: number;
      avgDataEntryRate?: number;
      avgSubmissionRate?: number;
      formsFullyCompatible?: number;
      formsPartiallyCompatible?: number;
      formsNotCompatible?: number;
    };
  };
}

/** The `results` object of a scan job, across both scan modes. */
export interface ScanResults {
  forms?: AnalyzedForm[];
  summary?: ScanSummary;
  aiSummary?: string;
  scanMode?: string;
  targetUrl?: string;
  url?: string;
  timestamp?: string;
  jobId?: string;
  crawlInfo?: CrawlInfo;
  metadata?: PerFormScanMetadata;
  scanMetadata?: ScanMetadata;
  detailedAnalysis?: unknown;
  analysis?: ComprehensiveAnalysis;
  pages?: ScanPage[];
}
