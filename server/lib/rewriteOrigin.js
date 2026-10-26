/**
 * Re-point a fixture URL at the submitted site while keeping its own path.
 * The fixture spans several page paths, so flattening them all to the
 * submitted URL would throw away the only thing that makes the sample look
 * like a real multi-page crawl. Only the origin is replaced.
 */
export function rewriteOrigin(fixtureUrl, submittedUrl) {
  try {
    const { origin } = new URL(submittedUrl);
    const fixture = new URL(fixtureUrl);

    return new URL(`${fixture.pathname}${fixture.search}${fixture.hash}`, origin).toString();
  } catch {
    return fixtureUrl;
  }
}
