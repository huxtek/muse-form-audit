import { rewriteOrigin } from './rewriteOrigin.js';

/**
 * The structured rewrite in `buildMockResponse()` only reaches fields that are
 * known to hold a URL. The bundled fixtures also name their own site inside
 * prose: the single-page `aiSummary` sentence quotes the scanned URL, and the
 * crawl fixture's hidden page-title fields end in `| <fixture host>`. Those
 * strings used to contradict the Target URL shown directly above them, so the
 * same origin re-basing is extended to string values anywhere in the response.
 *
 * Nothing here hardcodes a fixture domain. The host to replace is derived from
 * the fixture itself, so swapping `server/mock-data/*.json` keeps working.
 */

/** Candidate fields, best first, that record the origin a fixture was captured from. */
const ORIGIN_FIELDS = [
  (fixture) => fixture?.url,
  (fixture) => fixture?.results?.targetUrl,
  (fixture) => fixture?.results?.url,
  (fixture) => fixture?.results?.metadata?.targetUrl,
  (fixture) => fixture?.results?.summary?.targetUrl,
  (fixture) => fixture?.results?.forms?.[0]?.url
];

/**
 * The hostname the fixture was captured from, or `null` if it carries no
 * parseable URL. `url` is tried first because it is the only one of these
 * fields that both bundled fixtures define, and it is the top-level record of
 * what was scanned; the rest are fallbacks for a differently shaped fixture.
 */
export function getFixtureHostname(fixture) {
  let hostname = null;

  for (const read of ORIGIN_FIELDS) {
    if (hostname) continue;

    const candidate = read(fixture);

    if (typeof candidate === 'string') {
      try {
        hostname = new URL(candidate).hostname || null;
      } catch {
        hostname = null;
      }
    }
  }

  return hostname;
}

/** Make a derived hostname safe to drop into a RegExp (dots, dashes, anything). */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Boundaries shared by both alternatives below.
 *
 * `HOST_START` rejects a preceding word character, dot or dash, so the fixture
 * host is never clipped out of a longer name (`cdn-acme-roofing.example`,
 * `notacme-roofing.example`).
 *
 * `HOST_END` rejects a trailing word character or dash, and rejects a dot that
 * is itself followed by an alphanumeric. That distinguishes a longer hostname
 * (`acme-roofing.example.org` — not a match) from a host at the end of a
 * sentence (`... | acme-roofing.example.` — a match, period left in place).
 */
const HOST_START = '(?<![\\w.-])';
const HOST_END = '(?![\\w-])(?!\\.[A-Za-z0-9])';

/** Characters a URL in prose may contain. Trailing sentence punctuation is excluded. */
const URL_TAIL = '[^\\s"\'<>)\\]]*[^\\s"\'<>)\\].,;:!?]';

/**
 * One pattern, two ordered alternatives, so every position in the string is
 * matched at most once and a replacement is never rescanned:
 *
 *   1. a full `http(s)://<fixture host>` URL with optional port and path;
 *   2. a bare `<fixture host>` mention.
 *
 * Alternation is ordered, so a host inside a URL is always consumed by (1);
 * (2) can never see it. `String.replace` does not rescan what it inserted.
 * Together that rules out a double rewrite even when the submitted hostname
 * itself contains the fixture hostname.
 */
function buildHostPattern(fixtureHostname) {
  const host = escapeRegExp(fixtureHostname);

  return new RegExp(
    `https?://${host}(?::\\d+)?${HOST_END}(?:${URL_TAIL})?` +
      `|${HOST_START}${host}${HOST_END}`,
    'gi'
  );
}

/**
 * Re-point every mention of `fixtureHostname` in `text` at `submittedUrl`.
 * Full URLs keep their path, search and hash (via `rewriteOrigin`); bare
 * hostnames become the submitted hostname. A string that mentions the fixture
 * host nowhere is returned exactly as given.
 */
export function rewriteProseHost(text, fixtureHostname, submittedUrl) {
  let result = text;

  if (typeof text === 'string' && fixtureHostname) {
    let submittedHostname = null;

    try {
      submittedHostname = new URL(submittedUrl).hostname;
    } catch {
      submittedHostname = null;
    }

    if (submittedHostname) {
      result = text.replace(buildHostPattern(fixtureHostname), (match) =>
        match.includes('://') ? rewriteOrigin(match, submittedUrl) : submittedHostname
      );
    }
  }

  return result;
}

/**
 * Apply `rewriteProseHost` to every string VALUE reachable from `value`.
 * Object keys are never touched. Already-rewritten structured fields no longer
 * contain the fixture host, so this is a no-op for them — which is why it can
 * run after the structured rewrite without undoing or duplicating it.
 */
export function rewriteProseHostDeep(value, fixtureHostname, submittedUrl) {
  let result = value;

  if (typeof value === 'string') {
    result = rewriteProseHost(value, fixtureHostname, submittedUrl);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      value[index] = rewriteProseHostDeep(entry, fixtureHostname, submittedUrl);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      value[key] = rewriteProseHostDeep(value[key], fixtureHostname, submittedUrl);
    }
  }

  return result;
}
