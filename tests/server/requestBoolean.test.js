import { describe, expect, it } from 'vitest';

import { toRequestBoolean } from '../../server/server.js';

/**
 * /api/scan accepts JSON from the app and form-encoded from a native submit,
 * so the scan form can declare an action that genuinely works.
 *
 * Form bodies carry strings, and the dangerous case is "false": taken as-is
 * it is truthy, so a scan asked to stay on one page would crawl the whole
 * site, and a scan asked for mock data would hit someone's real website.
 */
describe('toRequestBoolean', () => {
  it('passes real booleans through, as the JSON path sends them', () => {
    expect(toRequestBoolean(true)).toBe(true);
    expect(toRequestBoolean(false)).toBe(false);
  });

  it('reads a checked checkbox, which sends "on"', () => {
    expect(toRequestBoolean('on')).toBe(true);
  });

  it('reads "false" as false rather than as a non-empty string', () => {
    // The whole reason this function exists.
    expect(toRequestBoolean('false')).toBe(false);
    expect(toRequestBoolean('FALSE')).toBe(false);
    expect(toRequestBoolean(' false ')).toBe(false);
  });

  it('accepts the other spellings a form or client may send', () => {
    expect(toRequestBoolean('true')).toBe(true);
    expect(toRequestBoolean('TRUE')).toBe(true);
    expect(toRequestBoolean('1')).toBe(true);
    expect(toRequestBoolean('yes')).toBe(true);
  });

  it('treats an absent or empty value as false', () => {
    // An unchecked checkbox sends nothing at all.
    expect(toRequestBoolean(undefined)).toBe(false);
    expect(toRequestBoolean(null)).toBe(false);
    expect(toRequestBoolean('')).toBe(false);
  });

  it('does not treat arbitrary text as true', () => {
    expect(toRequestBoolean('maybe')).toBe(false);
    expect(toRequestBoolean('0')).toBe(false);
    expect(toRequestBoolean('off')).toBe(false);
  });
});
