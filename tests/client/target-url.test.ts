import { describe, expect, it } from 'vitest';

import { normalizeTargetUrl } from '@/lib/target-url';

/**
 * People type `aa.com`.
 *
 * Both validation layers called `new URL()` on the raw input, which throws
 * for a bare hostname, so the most ordinary way of naming a website was
 * rejected with "that does not look like a website URL".
 */
const urlFor = (input: string) => normalizeTargetUrl(input).url;
const errorFor = (input: string) => normalizeTargetUrl(input).error;

describe('a bare hostname', () => {
  it('gains https', async () => {
    expect(urlFor('aa.com')).toBe('https://aa.com/');
  });

  it('works with a subdomain', async () => {
    expect(urlFor('www.aa.com')).toBe('https://www.aa.com/');
  });

  it('keeps the path, query and port', async () => {
    expect(urlFor('aa.com/booking/find-flights?from=AUS')).toBe(
      'https://aa.com/booking/find-flights?from=AUS'
    );
    expect(urlFor('aa.com:8443/admin')).toBe('https://aa.com:8443/admin');
  });

  it('tolerates surrounding whitespace and odd casing', async () => {
    expect(urlFor('  AA.COM  ')).toBe('https://aa.com/');
  });

  it('reads a protocol-relative address as https', async () => {
    expect(urlFor('//aa.com')).toBe('https://aa.com/');
  });
});

describe('an address that already has a scheme', () => {
  it('is left as it was', async () => {
    expect(urlFor('https://aa.com/x')).toBe('https://aa.com/x');
  });

  it('keeps http rather than silently upgrading it', async () => {
    // Changing the scheme changes what is being tested, and a report should
    // describe the page that was actually fetched.
    expect(urlFor('http://aa.com/')).toBe('http://aa.com/');
  });
});

describe('schemes that are not websites', () => {
  it('refuses javascript, which naive validation accepts', async () => {
    // `new URL('javascript:alert(1)')` parses, so a "does it parse?" check
    // waves it through -- which is exactly what the client check did.
    expect(urlFor('javascript:alert(1)')).toBeUndefined();
    expect(errorFor('javascript:alert(1)')).toMatch(/only http and https/i);
  });

  it('refuses data, file and mailto by name', async () => {
    for (const input of ['data:text/html,<b>x', 'file:///etc/passwd', 'mailto:a@b.com']) {
      expect(urlFor(input), input).toBeUndefined();
      expect(errorFor(input), input).toMatch(/only http and https/i);
    }
  });

  it('never turns a rejected scheme into an https address', async () => {
    // The failure mode worth guarding: prefixing blindly would produce
    // `https://javascript:alert(1)`, which parses and resolves to a host.
    expect(urlFor('javascript:alert(1)')).toBeUndefined();
  });
});

describe('input that is not an address', () => {
  it('refuses a bare word with no dot', async () => {
    expect(urlFor('aa')).toBeUndefined();
    expect(errorFor('aa')).toMatch(/not a website address/i);
  });

  it('refuses an empty field', async () => {
    expect(errorFor('')).toMatch(/enter a website url/i);
    expect(errorFor('   ')).toMatch(/enter a website url/i);
  });

  it('refuses something with a space in it', async () => {
    expect(errorFor('a a.com')).toMatch(/contains a space/i);
  });

  it('refuses embedded credentials', async () => {
    expect(urlFor('https://user:pw@aa.com')).toBeUndefined();
    expect(errorFor('https://user:pw@aa.com')).toMatch(/username and password/i);
  });
});

describe('addresses the server guard is entitled to refuse', () => {
  it('accepts them here and leaves the decision to the guard', async () => {
    // This helper is a convenience, not a security boundary. Normalising
    // `localhost:3001` must not be mistaken for permitting it: the URL guard
    // refuses private ranges and cloud metadata however they are spelled,
    // and duplicating that judgement in the browser would mean two rules
    // that can disagree.
    expect(urlFor('127.0.0.1')).toBe('https://127.0.0.1/');
    expect(urlFor('169.254.169.254')).toBe('https://169.254.169.254/');
  });

  it('still refuses a single-label host like localhost', async () => {
    // Not for safety -- the guard does that -- but because it is far more
    // often a typo than an intention.
    expect(urlFor('localhost')).toBeUndefined();
  });
});
