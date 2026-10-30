/**
 * Why a page could not be read, said plainly.
 *
 * `goToPage` used to take the HTTP status, log it, and carry on. So a page
 * that refused the request was serialised, found to contain no `<form>`, and
 * reported as a completed scan with zero forms -- identical to a page that
 * genuinely has no forms. aa.com is the measured case: Akamai answers 403
 * with an "Access Denied" page, and the scan said "Scan completed - no forms
 * found", which reads as a clean result.
 *
 * Telling the two apart matters more than it sounds. "This page has no forms"
 * is a finding about the page. "We were not allowed to look" is a fact about
 * us. Presenting the second as the first is the most misleading thing this
 * tool could do.
 */

/**
 * Markers that identify a bot wall rather than an ordinary error page.
 *
 * Deliberately vendor-specific. Generic words like "captcha" or "robot"
 * appear in plenty of legitimate pages -- including, inconveniently, pages
 * about form accessibility -- so matching those would misreport a readable
 * page as blocked.
 */
export const BOT_WALL_SIGNATURES = [
  {
    vendor: 'Akamai',
    cookies: ['ak_bmsc', 'akavpau_', 'aka_state_code', '_abck', 'bm_sz'],
    headers: ['x-akamai-transformed'],
    bodies: ['errors.edgesuite.net', 'akamai reference', 'reference #']
  },
  {
    vendor: 'Cloudflare',
    cookies: ['__cf_bm', 'cf_clearance'],
    headers: ['cf-ray', 'cf-mitigated'],
    bodies: ['attention required', 'just a moment', 'cf-browser-verification', 'cdn-cgi/challenge']
  },
  {
    vendor: 'PerimeterX / HUMAN',
    cookies: ['_px', '_pxhd', '_pxvid'],
    headers: ['x-px'],
    bodies: ['access to this page has been denied', 'px-captcha']
  },
  {
    vendor: 'DataDome',
    cookies: ['datadome'],
    headers: ['x-datadome', 'x-dd-b'],
    bodies: ['datadome', 'geo.captcha-delivery.com']
  },
  {
    vendor: 'Imperva / Incapsula',
    cookies: ['incap_ses', 'visid_incap', 'nlbi_'],
    headers: ['x-iinfo', 'x-cdn'],
    bodies: ['incident id', '_incapsula_resource']
  },
  {
    vendor: 'AWS WAF',
    cookies: ['aws-waf-token'],
    headers: ['x-amzn-waf-action'],
    bodies: ['awswaf', 'challenge.js']
  }
];

const lower = (value) => String(value ?? '').toLowerCase();

/**
 * Identifies the gatekeeper, if there is one.
 *
 * Headers and cookies are the reliable signal; the body is a fallback for
 * vendors that answer from the edge with no distinguishing headers.
 */
export function detectBotWall({ headers = {}, html = '' } = {}) {
  const headerKeys = Object.keys(headers).map(lower);
  const setCookie = []
    .concat(headers['set-cookie'] ?? headers['Set-Cookie'] ?? [])
    .map(lower)
    .join(' ');
  const body = lower(html).slice(0, 20_000);

  for (const signature of BOT_WALL_SIGNATURES) {
    const byHeader = signature.headers.some((name) => headerKeys.includes(name));
    const byCookie = signature.cookies.some((name) => setCookie.includes(lower(name)));
    const byBody = signature.bodies.some((marker) => body.includes(lower(marker)));

    if (byHeader || byCookie || byBody) {
      return {
        vendor: signature.vendor,
        evidence: byHeader ? 'response headers' : byCookie ? 'cookies' : 'page body'
      };
    }
  }

  return null;
}

/**
 * True when a 200 response is really a challenge page in disguise.
 *
 * Some vendors answer challenges with 200. Requires a vendor marker *and* an
 * absence of fields, so a readable page that happens to mention a vendor is
 * not thrown away.
 */
export function looksLikeChallengePage({ headers = {}, html = '' } = {}) {
  const wall = detectBotWall({ headers, html });

  if (!wall) {
    return null;
  }

  const hasFields = /<(input|textarea|select)[\s>]/i.test(html);
  const tiny = html.length < 4000;

  return !hasFields && tiny ? wall : null;
}

/**
 * A sentence a user can act on, plus a machine-readable kind.
 *
 * `kind` exists so the interface can choose the right follow-up advice. The
 * failure panel used to offer "no API keys yet? try Dev Mode" for every
 * failure, which is irrelevant when the truth is that the site refused us.
 */
export function describeLoadFailure({ status, headers = {}, html = '', url = '' } = {}) {
  const wall = detectBotWall({ headers, html });
  const site = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return 'this site';
    }
  })();

  if (wall && (status === 403 || status === 401 || status === 429 || status >= 500)) {
    return {
      kind: 'bot-protected',
      vendor: wall.vendor,
      status,
      message:
        `${site} is protected by bot detection (${wall.vendor}) and refused the request ` +
        `with HTTP ${status}, so there was no page to scan. This is a restriction on ` +
        `${site}'s side, not a problem with the page's forms. Try a page that does not ` +
        `sit behind the protection, or a different site.`
    };
  }

  if (status === 403) {
    return {
      kind: 'forbidden',
      status,
      message:
        `${site} refused the request with HTTP 403, so there was no page to scan. ` +
        `The page may require sign-in, or may be blocking automated browsers.`
    };
  }

  if (status === 401) {
    return {
      kind: 'unauthorized',
      status,
      message: `${site} requires sign-in (HTTP 401), so the page could not be scanned.`
    };
  }

  if (status === 404) {
    return {
      kind: 'not-found',
      status,
      message: `That page does not exist on ${site} (HTTP 404). Check the URL.`
    };
  }

  if (status === 429) {
    return {
      kind: 'rate-limited',
      status,
      message:
        `${site} is rate limiting us (HTTP 429). Wait a few minutes and try again, ` +
        `or scan a different site.`
    };
  }

  if (status >= 500) {
    return {
      kind: 'server-error',
      status,
      message: `${site} returned a server error (HTTP ${status}), so there was nothing to scan.`
    };
  }

  return {
    kind: 'load-failed',
    status,
    message: `${site} returned HTTP ${status}, so the page could not be scanned.`
  };
}

/**
 * Builds the error to throw, carrying the detail the UI needs.
 *
 * An Error rather than a returned value because every caller of `goToPage`
 * already treats a throw as "this scan cannot continue", which is exactly
 * what an unreadable page means.
 */
export function pageAccessError(details) {
  const described = describeLoadFailure(details);
  const error = new Error(described.message);

  error.pageAccess = described;

  return error;
}
