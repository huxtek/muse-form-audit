import { describe, expect, it } from 'vitest';

import {
  isUsableDom,
  NAVIGATION_WAIT_UNTIL,
  pageUnreadableError
} from '../../server/lib/pageReadiness.js';

/**
 * united.com reported zero forms for a page carrying two.
 *
 * The crawler waited for `networkidle0`, which demands zero in-flight
 * connections for 500ms. united.com never goes that quiet, so navigation
 * threw a timeout, the catch returned empty HTML, and the scan reported
 * "Scan completed - no forms found".
 *
 * The measurements that pinned it down, all against the real site:
 *
 *   networkidle0      timed out at 30s and again at 45s
 *   domcontentloaded  http 200 in 3,414ms   2 forms, 11 fields
 *   load              http 200 in 5,824ms   2 forms, 11 fields
 *   networkidle2      http 200 in 11,634ms  2 forms, 11 fields
 *
 * And at the moment of the networkidle0 timeout the DOM was already
 * complete: 2,480,727 characters, title loaded, two forms, eleven fields.
 * The page was fine. The wait was not.
 */

/** The DOM united.com actually had when the old wait gave up on it. */
const UNITED_AT_TIMEOUT = {
  hasBody: true,
  elements: 3284,
  fields: 11,
  textLength: 1507,
  title: 'United Airlines - Airline Tickets, Travel Deals and Flights'
};

describe('the navigation condition', () => {
  it('is not network idle', async () => {
    /*
     * The regression that matters. Any condition that can fail to arrive on
     * a page with a live connection -- analytics, a websocket, a long-poll
     * -- puts this back where it was. Measured: even a 48KB personal site
     * that finishes loading in 422ms never reaches networkidle0.
     */
    expect(NAVIGATION_WAIT_UNTIL).not.toBe('networkidle0');
  });
});

describe('deciding whether a timed-out page is worth reading', () => {
  it('keeps the page united.com had rendered when the wait expired', async () => {
    expect(isUsableDom(UNITED_AT_TIMEOUT)).toBe(true);
  });

  it('keeps a page that has fields but little else', async () => {
    // A bare login form is a legitimate target and must not be discarded
    // for being small.
    expect(
      isUsableDom({ hasBody: true, elements: 24, fields: 2, textLength: 40, title: 'Sign in' })
    ).toBe(true);
  });

  it('keeps a long page that happens to have no fields', async () => {
    // hamidghoraishi.com: 48KB of readable page, no forms, and it also
    // never reaches network idle. "No forms" is the right answer here, but
    // it has to be reached by reading the page.
    expect(
      isUsableDom({ hasBody: true, elements: 40, fields: 0, textLength: 4200, title: 'Hamid' })
    ).toBe(true);
  });

  it('rejects an empty document', async () => {
    // What a navigation that got nowhere leaves behind: html, head, body.
    expect(
      isUsableDom({ hasBody: true, elements: 4, fields: 0, textLength: 0, title: '' })
    ).toBe(false);
  });

  it('rejects a document with no body at all', async () => {
    expect(
      isUsableDom({ hasBody: false, elements: 2, fields: 0, textLength: 0, title: '' })
    ).toBe(false);
  });

  it('rejects a missing measurement rather than assuming the page is fine', async () => {
    // `page.evaluate` can fail outright if the context is being torn down.
    expect(isUsableDom(null)).toBe(false);
  });
});

describe('what the user is told when there was no page', () => {
  it('says the scan saw nothing, not that the page has no forms', async () => {
    const error = pageUnreadableError({
      url: 'https://www.united.com/',
      kind: 'nav-timeout',
      waitedMs: 45000
    });

    expect(error.message).toContain('www.united.com');
    expect(error.message).toContain('45s');
    expect(error.message).toMatch(/never saw them/);
    expect(error.message).not.toMatch(/no forms found/);
  });

  it('carries the kind the interface uses to pick a heading', async () => {
    const error = pageUnreadableError({ url: 'https://example.com/', kind: 'nav-timeout' });

    expect(error.pageAccess).toMatchObject({ kind: 'nav-timeout', status: null });
  });

  it('includes the underlying reason when there is one', async () => {
    const error = pageUnreadableError({
      url: 'https://example.com/',
      reason: 'net::ERR_CONNECTION_RESET'
    });

    expect(error.pageAccess.kind).toBe('unreadable');
    expect(error.message).toContain('net::ERR_CONNECTION_RESET');
  });

  it('still names a site when the URL is unparseable', async () => {
    expect(pageUnreadableError({ url: 'not a url' }).message).toContain('this site');
  });
});
