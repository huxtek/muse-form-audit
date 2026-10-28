import {
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
  type ModelProvider
} from '@/defines/modelProviders';

/**
 * The query-string contract for `/scan`.
 *
 * A scan used to live entirely in component state, so the address bar read
 * `/` whether you were looking at the form or at a finished report. People
 * reasonably assumed the report was a page of its own and pressed Back to
 * get to the form -- which left the site instead. The URL now says which of
 * the two you are looking at.
 *
 * Deliberately keyed on the scanned URL rather than a job id. A job id would
 * make a report re-loadable, but the ids live in an in-memory Map on the
 * server and die with the process, so the link would rot on the next deploy.
 * The request is the durable part, so the request is what the URL carries.
 *
 * The names match the form controls and the `/api/scan` body, so there is one
 * vocabulary across the markup, the query string and the API.
 */
export const SCAN_ROUTE = '/scan';

export const SCAN_PARAMS = {
  URL: 'url',
  FULL_CRAWL: 'fullCrawl',
  MODEL_PROVIDER: 'modelProvider'
} as const;

/**
 * Reserved value of the `url` param that means "show the bundled sample".
 *
 * `demo` cannot collide with a site someone wants to scan: it has no dot, so
 * it fails URL validation long before it could reach the crawler.
 */
export const SCAN_DEMO_TARGET = 'demo';

/** Everything `/scan` can be asked to show, read off the query string. */
export interface ScanParams {
  /**
   * The raw `url` param, trimmed. '' means the page is being asked for the
   * form rather than a report, which is what pressing Back lands on.
   *
   * Separate from `url` because the demo target is a target without being a
   * site: `url` has to stay empty for it, but `target` must stay truthy or
   * the page would read the sample as "no scan asked for" and bin it.
   */
  target: string;
  /** The site to scan, or '' when the page should just show the form. */
  url: string;
  /** True for `?url=demo`, the one target that runs without being asked. */
  isDemo: boolean;
  fullCrawl: boolean;
  modelProvider: ModelProvider;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

const MODEL_PROVIDER_VALUES = new Set<string>(Object.values(MODEL_PROVIDERS));

/**
 * Accepts the spellings a human might type into the address bar by hand, not
 * just the one we generate. An unrecognised value is false rather than an
 * error: a malformed option should not cost someone their scan.
 */
export const parseBooleanParam = (value: string | null): boolean =>
  value !== null && TRUTHY.has(value.trim().toLowerCase());

/**
 * Falls back to the default for anything unrecognised, so a typo or a stale
 * link cannot put the switch into a state the UI has no control for.
 */
export const parseModelProviderParam = (value: string | null): ModelProvider => {
  const candidate = value?.trim().toLowerCase() ?? '';

  return MODEL_PROVIDER_VALUES.has(candidate)
    ? (candidate as ModelProvider)
    : DEFAULT_MODEL_PROVIDER;
};

/**
 * Reads the whole contract in one go. Takes URLSearchParams rather than a
 * location so it stays testable without a router.
 */
export const parseScanParams = (search: URLSearchParams): ScanParams => {
  const rawUrl = search.get(SCAN_PARAMS.URL)?.trim() ?? '';
  const isDemo = rawUrl.toLowerCase() === SCAN_DEMO_TARGET;

  return {
    target: rawUrl,
    // The sample is not a site, so it must never reach the URL field: a
    // prefilled `demo` would fail validation the moment anyone pressed Scan.
    url: isDemo ? '' : rawUrl,
    isDemo,
    fullCrawl: parseBooleanParam(search.get(SCAN_PARAMS.FULL_CRAWL)),
    modelProvider: parseModelProviderParam(search.get(SCAN_PARAMS.MODEL_PROVIDER))
  };
};

/**
 * Builds the search string for a scan.
 *
 * Only non-default options are written, so the common case stays
 * `/scan?url=example.com` and stays readable when shared.
 */
export const buildScanSearch = (options: {
  url: string;
  fullCrawl?: boolean;
  modelProvider?: ModelProvider;
}): string => {
  const { url, fullCrawl = false, modelProvider = DEFAULT_MODEL_PROVIDER } = options;
  const search = new URLSearchParams();

  search.set(SCAN_PARAMS.URL, url);

  if (fullCrawl) {
    search.set(SCAN_PARAMS.FULL_CRAWL, '1');
  }

  if (modelProvider !== DEFAULT_MODEL_PROVIDER) {
    search.set(SCAN_PARAMS.MODEL_PROVIDER, modelProvider);
  }

  return search.toString();
};

/** The full path to push when a scan starts. */
export const buildScanPath = (options: {
  url: string;
  fullCrawl?: boolean;
  modelProvider?: ModelProvider;
}): string => `${SCAN_ROUTE}?${buildScanSearch(options)}`;

/** The path for the bundled sample, stable enough to put in a README. */
export const buildDemoPath = (): string =>
  `${SCAN_ROUTE}?${SCAN_PARAMS.URL}=${SCAN_DEMO_TARGET}`;
