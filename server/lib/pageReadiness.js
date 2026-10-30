/**
 * When is a page ready, and is what we got worth reading?
 *
 * The crawler navigated with `waitUntil: 'networkidle0'`, which demands zero
 * in-flight connections for 500ms. Commercial sites never go that quiet:
 * analytics beacons, websockets, long-polls and keepalives all keep a
 * connection open indefinitely. So `page.goto` threw a timeout, the catch in
 * `goToPage` returned empty HTML, and the scan reported "Scan completed - no
 * forms found" -- a clean-looking result for a page we never read.
 *
 * Measured on united.com: `networkidle0` never arrived, while the DOM at the
 * moment of the 30s timeout was already complete at 2,480,727 characters
 * with two forms and eleven fields. Every other condition reached the same
 * page -- `domcontentloaded` in 3.4s, `load` in 5.8s, `networkidle2` in
 * 11.6s. The page was never the problem; the wait was. It was not specific
 * to big sites either: a 48KB personal site that finishes loading in 422ms
 * also never reaches `networkidle0`.
 *
 * So readiness is now decided in two steps: navigate to a condition that
 * actually fires, then wait a bounded time for fields to appear, which is
 * what this scanner is here to look at.
 */

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * The navigation condition.
 *
 * `domcontentloaded` fires when the HTML is parsed, which is the earliest
 * point worth looking at and, unlike network idle, always arrives. Late
 * client-rendered content is covered by the field wait below rather than by
 * a stricter navigation condition, because a stricter condition fails
 * outright instead of waiting.
 */
export const NAVIGATION_WAIT_UNTIL = process.env.NAVIGATION_WAIT_UNTIL || 'domcontentloaded';

/** Generous, because this now has to fire rather than being given up on. */
export const NAVIGATION_TIMEOUT_MS = toInt(process.env.NAVIGATION_TIMEOUT_MS, 45000);

/**
 * How long to keep waiting for a field after the HTML is parsed.
 *
 * Spent only on pages that have no fields yet, so a server-rendered form
 * costs nothing. A page with genuinely no fields pays this in full, which is
 * the price of not missing a client-rendered one.
 */
export const FIELD_WAIT_MS = toInt(process.env.FIELD_WAIT_MS, 8000);

/** A last pause for hydration to attach to markup that has just appeared. */
export const CONTENT_SETTLE_MS = toInt(process.env.CONTENT_SETTLE_MS, 2000);

/** Fields are the point of the scan, so their arrival is the ready signal. */
export const FIELD_SELECTOR = 'form, input:not([type="hidden"]), select, textarea';

/**
 * Floors for calling a DOM worth reading. Applied only after a navigation
 * timeout, where the question is "did anything load at all?" -- an empty
 * Chrome document is 3 or 4 elements, a real page is hundreds.
 */
export const MIN_USABLE_ELEMENTS = 50;
export const MIN_USABLE_TEXT = 200;

/**
 * Runs in the browser, so it must stay self-contained: `page.evaluate`
 * serialises the function source and nothing from this module's scope
 * travels with it.
 */
export const measureReadiness = () => {
  const fields = document.querySelectorAll(
    'form, input:not([type="hidden"]), select, textarea'
  ).length;

  return {
    hasBody: Boolean(document.body),
    elements: document.querySelectorAll('*').length,
    fields,
    textLength: (document.body ? document.body.innerText : '').length,
    title: document.title || ''
  };
};

/**
 * Whether a timed-out navigation left something worth scanning.
 *
 * Any one signal is enough. The alternative -- discarding every timed-out
 * page -- is what produced the united.com result, where a complete 2.4MB
 * document with two forms was thrown away because the network stayed busy.
 */
export const isUsableDom = (readiness) => {
  if (!readiness || !readiness.hasBody) {
    return false;
  }

  return (
    readiness.fields > 0 ||
    readiness.elements >= MIN_USABLE_ELEMENTS ||
    readiness.textLength >= MIN_USABLE_TEXT
  );
};

const hostnameOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'this site';
  }
};

/**
 * The error for "there was no page to read".
 *
 * Carries `pageAccess` in the same shape as the bot-wall path, so the
 * interface already knows how to show it: a heading chosen by `kind` and the
 * message as written here. The wording says plainly that nothing was read,
 * because the failure this replaces claimed the page had no forms.
 */
export const pageUnreadableError = ({ url = '', kind = 'unreadable', reason = '', waitedMs = null } = {}) => {
  const site = hostnameOf(url);
  const message =
    kind === 'nav-timeout'
      ? `${site} did not finish loading within ${Math.round((waitedMs ?? NAVIGATION_TIMEOUT_MS) / 1000)}s, ` +
        `and nothing usable had rendered, so there was no page to scan. This is not a finding ` +
        `about the page's forms -- we never saw them. Try again, or scan a specific page rather ` +
        `than the site's home page.`
      : `${site} could not be read${reason ? ` (${reason})` : ''}, so there was no page to scan. ` +
        `This is not a finding about the page's forms -- we never saw them.`;

  const error = new Error(message);

  error.pageAccess = { kind, status: null, message, ...(reason ? { reason } : {}) };

  return error;
};
