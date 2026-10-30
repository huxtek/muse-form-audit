/**
 * Turns what someone typed into a URL worth scanning, or says why not.
 *
 * People type `aa.com`. Both validation layers called `new URL()` on that,
 * which throws, so a perfectly ordinary way of naming a website was rejected
 * with "that does not look like a website URL".
 *
 * Adding a scheme is the whole job, and the care is in not adding one where
 * it would change the meaning of the input. `new URL('javascript:alert(1)')`
 * parses happily, so a naive "does it parse?" check accepts it -- which is
 * what the client check did. Anything already carrying a scheme is therefore
 * matched against http and https and rejected otherwise, rather than being
 * prefixed into something else.
 *
 * This is a convenience, not a security boundary. The server's URL guard
 * still decides what may be fetched: private ranges, cloud metadata,
 * redirects and credentials are its business, and `https://localhost:3001`
 * is refused there however it got spelled.
 */

/** Schemes worth scanning. Everything else is a mistake or a trick. */
const SUPPORTED_SCHEMES = ['http:', 'https:'];

/**
 * Matches a leading scheme, so input that already has one is never prefixed.
 *
 * Deliberately broader than http and https: the point is to notice that a
 * scheme is present, so `javascript:`, `data:` and `file:` are reported as
 * unsupported rather than silently turned into `https://javascript:...`.
 *
 * Two patterns, because a scheme and a port look alike. Dots are legal in
 * scheme names -- `coap+tcp:` is a real one -- so a single pattern read
 * `aa.com:8443` as the scheme `aa.com:` and refused a perfectly good
 * address. What separates them is what follows the colon: a port is digits,
 * an opaque scheme is not.
 */
const HAS_HIERARCHICAL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const HAS_OPAQUE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/;

const schemeOf = (input: string): string | null => {
  if (!HAS_HIERARCHICAL_SCHEME.test(input) && !HAS_OPAQUE_SCHEME.test(input)) {
    return null;
  }

  return input.slice(0, input.indexOf(':') + 1).toLowerCase();
};

export interface NormalizedTarget {
  /** The URL to scan. Absent when the input could not be used. */
  url?: string;
  /** Why the input was refused, phrased for the person who typed it. */
  error?: string;
}

/**
 * A hostname has to look like one before it is worth a DNS lookup.
 *
 * A bare word with no dot -- `aa`, `localhost`, a typo -- is almost never a
 * site someone meant to scan, and failing here gives a clearer answer than
 * letting the request travel and come back as a resolution failure. An IP
 * address is allowed through to the guard, which is the thing entitled to
 * refuse it.
 */
const looksLikeHostname = (hostname: string): boolean => {
  if (hostname.length === 0) {
    return false;
  }

  // Bracketed IPv6, or a bare IPv4.
  if (hostname.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return true;
  }

  // Something.something, with a plausible final label.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(
    hostname
  );
};

/**
 * Normalises a typed target.
 *
 * Returns `{ url }` with an absolute http(s) URL, or `{ error }` with a
 * sentence explaining the refusal.
 */
export const normalizeTargetUrl = (input: string): NormalizedTarget => {
  const trimmed = (input ?? '').trim();

  if (!trimmed) {
    return { error: 'Enter a website URL to scan.' };
  }

  if (/\s/.test(trimmed)) {
    return { error: 'That contains a space. Check the URL and try again.' };
  }

  // A scheme already present is honoured or refused, never rewritten.
  const scheme = schemeOf(trimmed);

  if (scheme && !SUPPORTED_SCHEMES.includes(scheme)) {
    return {
      error: `Only http and https addresses can be scanned, not ${scheme.replace(':', '')}.`
    };
  }

  // `//example.com` means "same scheme as the current page", which has no
  // meaning for a server-side fetch. https is the reasonable reading.
  const candidate = scheme ? trimmed : `https://${trimmed.replace(/^\/\//, '')}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: 'That does not look like a website URL. Try https://example.com' };
  }

  if (!SUPPORTED_SCHEMES.includes(parsed.protocol)) {
    return {
      error: `Only http and https addresses can be scanned, not ${parsed.protocol.replace(':', '')}.`
    };
  }

  if (parsed.username || parsed.password) {
    return { error: 'Remove the username and password from the URL before scanning.' };
  }

  if (!looksLikeHostname(parsed.hostname)) {
    return {
      error: `"${parsed.hostname || trimmed}" is not a website address. Try something like aa.com`
    };
  }

  return { url: parsed.href };
};
