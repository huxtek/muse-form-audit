import { describe, expect, it } from 'vitest';

import {
  describeLoadFailure,
  detectBotWall,
  looksLikeChallengePage,
  pageAccessError
} from '../../server/lib/botWall.js';

/**
 * Telling "we were not allowed to look" apart from "this page has no forms".
 *
 * The HTTP status used to be logged and otherwise ignored, so a refusal was
 * serialised, found to contain no `<form>`, and reported as a completed scan
 * with zero forms. aa.com is the measured case: Akamai answers 403 with an
 * Access Denied body, and the scan said "Scan completed - no forms found",
 * which reads as a clean result about the page rather than a fact about us.
 */

/** The response aa.com actually returned, trimmed. */
const AA_COM = {
  status: 403,
  url: 'https://www.aa.com/',
  headers: {
    'set-cookie': [
      'aka_state_code=TX; path=/; secure',
      'akavpau_www_aahomepage=1793391391~id=5819f8ea; Path=/; HttpOnly; Secure'
    ],
    'server-timing': 'cdn-cache; desc=HIT'
  },
  html:
    '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>' +
    'You don\'t have permission to access "http://www.aa.com/" on this server.<p>' +
    'Reference #18.b651c317.1793391178.4d4a2e7c</p>' +
    '<p>https://errors.edgesuite.net/18.b651c317.1793391178.4d4a2e7c</p></body></html>'
};

describe('identifying the gatekeeper', () => {
  it('recognises the Akamai block aa.com actually returned', async () => {
    const wall = detectBotWall(AA_COM);

    expect(wall?.vendor).toBe('Akamai');
  });

  it('recognises Cloudflare from its headers', async () => {
    expect(detectBotWall({ headers: { 'cf-ray': 'abc123' }, html: '' })?.vendor).toBe(
      'Cloudflare'
    );
  });

  it('recognises DataDome from its cookie', async () => {
    expect(
      detectBotWall({ headers: { 'set-cookie': ['datadome=xyz; Path=/'] }, html: '' })?.vendor
    ).toBe('DataDome');
  });

  it('finds nothing on an ordinary page', async () => {
    expect(
      detectBotWall({
        headers: { 'content-type': 'text/html' },
        html: '<html><body><form><input name="a"></form></body></html>'
      })
    ).toBeNull();
  });

  it('does not treat a page about bots as a bot wall', async () => {
    // Generic words were deliberately left out of the signatures: a page
    // discussing captchas and robots is exactly the sort of page this tool
    // is pointed at.
    expect(
      detectBotWall({
        headers: {},
        html:
          '<html><body><h1>Captcha and robot detection</h1>' +
          '<p>Are you a human? Access denied pages explained.</p>' +
          '<form><input name="q"></form></body></html>'
      })
    ).toBeNull();
  });
});

describe('challenge pages served with HTTP 200', () => {
  it('spots a tiny vendor page with no fields', async () => {
    const challenge = looksLikeChallengePage({
      headers: { 'cf-ray': 'abc' },
      html: '<html><body>Just a moment...</body></html>'
    });

    expect(challenge?.vendor).toBe('Cloudflare');
  });

  it('leaves a real page alone even when a vendor is in front of it', async () => {
    // Cloudflare fronts a large share of the web. Its presence is not a block.
    const html =
      '<html><body>' +
      '<form action="/login"><input name="email"><input type="password" name="pw"></form>' +
      'x'.repeat(8000) +
      '</body></html>';

    expect(looksLikeChallengePage({ headers: { 'cf-ray': 'abc' }, html })).toBeNull();
  });
});

describe('what the user is told', () => {
  it('names the vendor and says it is the site, not them', async () => {
    const described = describeLoadFailure(AA_COM);

    expect(described.kind).toBe('bot-protected');
    expect(described.vendor).toBe('Akamai');
    expect(described.message).toContain('www.aa.com');
    expect(described.message).toContain('Akamai');
    expect(described.message).toMatch(/bot detection/i);
    // The point of the whole change: this is not a finding about the forms.
    expect(described.message).toMatch(/not a problem with the page's forms/i);
  });

  it('distinguishes a plain 403 from a bot wall', async () => {
    const described = describeLoadFailure({
      status: 403,
      url: 'https://example.com/private',
      headers: {},
      html: '<html><body>Forbidden</body></html>'
    });

    expect(described.kind).toBe('forbidden');
    expect(described.message).not.toMatch(/bot detection/i);
  });

  it('describes 401, 404, 429 and 5xx each in their own terms', async () => {
    const kindOf = (status) =>
      describeLoadFailure({ status, url: 'https://example.com/', headers: {}, html: '' }).kind;

    expect(kindOf(401)).toBe('unauthorized');
    expect(kindOf(404)).toBe('not-found');
    expect(kindOf(429)).toBe('rate-limited');
    expect(kindOf(503)).toBe('server-error');
  });

  it('survives a URL it cannot parse', async () => {
    const described = describeLoadFailure({ status: 403, url: 'not-a-url', headers: {}, html: '' });

    expect(described.message).toContain('this site');
  });
});

describe('the error the scan throws', () => {
  it('carries the detail the interface needs', async () => {
    const error = pageAccessError(AA_COM);

    expect(error).toBeInstanceOf(Error);
    expect(error.pageAccess.kind).toBe('bot-protected');
    expect(error.pageAccess.status).toBe(403);
    expect(error.message).toBe(error.pageAccess.message);
  });
});
