/**
 * One identity for everything this scanner sends.
 *
 * It used to be a literal in `tools.js`, and the URL guard's pre-flight sent
 * nothing at all. Two clients asking for the same page with different
 * identities get different pages, and the pre-flight's answer is the one that
 * decides what gets scanned.
 *
 * Measured on https://www.google.com/travel/flights:
 *
 *   node fetch, no User-Agent   302 -> /travel/flights/unsupported?ucpp=...
 *   node fetch, browser UA      200, no redirect
 *   node fetch, curl UA         200, no redirect
 *
 * So the pre-flight was redirected to Google's "unsupported browser" page,
 * the middleware adopted that as the validated target, and the crawler
 * dutifully scanned it. It has no form, so the report said "no forms found"
 * about Google Flights -- a statement about a page nobody asked for.
 *
 * This is not about getting past anything. Both halves of one tool should
 * make the same request, and a header we simply forgot to send is why they
 * did not.
 */

/**
 * Overridable, because a site that refuses this one is worth being able to
 * retry without a code change.
 */
export const CRAWLER_USER_AGENT =
  process.env.CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Headers for a plain HTTP request that should be answered the way the
 * browser would be answered.
 *
 * `Accept` is included for the same reason as the User-Agent: a server
 * choosing between HTML and something else should make the choice it would
 * make for the browser that follows.
 */
export const crawlerRequestHeaders = () => ({
  'User-Agent': CRAWLER_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
});
