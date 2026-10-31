import dns from 'dns';
import net from 'net';
import { URL } from 'url';

import { crawlerRequestHeaders } from '../lib/userAgent.js';

/**
 * SSRF guard for the scanner.
 *
 * The scanner fetches arbitrary user-supplied URLs, which makes it a classic
 * server-side request forgery sink. Everything that leaves this process with a
 * user-controlled destination must go through `assertSafeUrl` first, and
 * anything that follows redirects must go through `safeFetch`, which
 * re-validates every hop (an open redirect would otherwise bypass the guard).
 */

const toBool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getUrlGuardConfig = () => ({
  // Opt-in escape hatch for developers who deliberately want to scan localhost.
  allowPrivateTargets: toBool(process.env.ALLOW_PRIVATE_TARGETS, false),
  maxUrlLength: toInt(process.env.MAX_URL_LENGTH, 2048),
  maxRedirects: toInt(process.env.MAX_REDIRECTS, 3),
  maxResponseBytes: toInt(process.env.MAX_RESPONSE_BYTES, 5 * 1024 * 1024),
  requestTimeoutMs: toInt(process.env.REQUEST_TIMEOUT_MS, 15000),
  dnsTimeoutMs: toInt(process.env.DNS_TIMEOUT_MS, 5000)
});

const ALLOWED_PROTOCOLS = ['http:', 'https:'];

// Blocked regardless of ALLOW_PRIVATE_TARGETS: cloud instance metadata.
const METADATA_HOSTNAMES = [
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data'
];
const METADATA_ADDRESSES = ['169.254.169.254', 'fd00:ec2::254'];

// Ports that are never worth crawling and are common lateral-movement targets.
const BLOCKED_PORTS = new Set([
  22, 23, 25, 53, 110, 143, 445, 993, 995, 1433, 3306, 5432, 6379, 9200, 11211, 27017
]);

// IPv4 ranges that must never be reachable from a user-supplied URL.
const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // private
  '100.64.0.0/10', // carrier-grade NAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, includes 169.254.169.254
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // documentation
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation
  '203.0.113.0/24', // documentation
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved
  '255.255.255.255/32' // broadcast
];

// IPv6 prefixes that must never be reachable.
const BLOCKED_IPV6_CIDRS = [
  '::/128', // unspecified
  '::1/128', // loopback
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'ff00::/8' // multicast
];

export class UrlGuardError extends Error {
  constructor(message, code = 'URL_BLOCKED') {
    super(message);
    this.name = 'UrlGuardError';
    this.code = code;
  }
}

const ipv4ToInt = (ip) =>
  ip.split('.').reduce((acc, octet) => acc * 256 + Number.parseInt(octet, 10), 0);

const ipv4InCidr = (ip, cidr) => {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number.parseInt(bitsRaw, 10);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(range) & mask) >>> 0;
};

/**
 * Expand any IPv6 literal (including `::` compression and IPv4-mapped forms)
 * into its 16 raw bytes. Returns null when the address is not parseable.
 */
export const ipv6ToBytes = (address) => {
  let text = String(address).split('%')[0];
  let embeddedV4 = null;

  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = text.slice(lastColon + 1);
    if (tail.includes('.')) {
      if (!net.isIPv4(tail)) return null;
      embeddedV4 = tail.split('.').map((octet) => Number.parseInt(octet, 10));
      text = `${text.slice(0, lastColon + 1)}0:0`;
    }
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const group of groups) {
    const value = Number.parseInt(group || '0', 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  if (embeddedV4) {
    bytes[12] = embeddedV4[0];
    bytes[13] = embeddedV4[1];
    bytes[14] = embeddedV4[2];
    bytes[15] = embeddedV4[3];
  }

  return Buffer.from(bytes);
};

const ipv6InCidr = (bytes, cidr) => {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number.parseInt(bitsRaw, 10);
  const rangeBytes = ipv6ToBytes(range);
  if (!rangeBytes) return false;

  const fullBytes = Math.floor(bits / 8);
  const remainder = bits % 8;

  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== rangeBytes[i]) return false;
  }
  if (remainder === 0) return true;

  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[fullBytes] & mask) === (rangeBytes[fullBytes] & mask);
};

/**
 * Returns a reason string when the address must be blocked, otherwise null.
 */
export const classifyAddress = (address, { allowPrivateTargets } = {}) => {
  if (METADATA_ADDRESSES.includes(address.toLowerCase())) {
    return 'cloud instance metadata address';
  }

  if (net.isIPv4(address)) {
    if (!allowPrivateTargets) {
      const match = BLOCKED_IPV4_CIDRS.find((cidr) => ipv4InCidr(address, cidr));
      if (match) return `address in reserved range ${match}`;
    }
    return null;
  }

  if (net.isIPv6(address)) {
    const bytes = ipv6ToBytes(address);
    if (!bytes) return 'unparseable IPv6 address';

    // IPv4-mapped addresses (::ffff:a.b.c.d) are really IPv4 destinations.
    const isV4Mapped =
      bytes.subarray(0, 10).every((byte) => byte === 0) &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff;
    if (isV4Mapped) {
      const mapped = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      return classifyAddress(mapped, { allowPrivateTargets });
    }

    if (!allowPrivateTargets) {
      const match = BLOCKED_IPV6_CIDRS.find((cidr) => ipv6InCidr(bytes, cidr));
      if (match) return `address in reserved range ${match}`;
    }
    return null;
  }

  return 'not a valid IP address';
};

const resolveHostname = (hostname, timeoutMs) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new UrlGuardError(`DNS resolution timed out for '${hostname}'`, 'DNS_TIMEOUT'));
    }, timeoutMs);

    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (settled) return;
      clearTimeout(timer);
      if (error) {
        reject(new UrlGuardError(`Could not resolve '${hostname}'`, 'DNS_FAILURE'));
      } else {
        resolve(addresses.map((entry) => entry.address));
      }
    });
  });

/**
 * Validate a single user-supplied URL. Throws UrlGuardError when the target is
 * not safe to fetch. Resolves to the normalised URL plus resolved addresses.
 */
export const assertSafeUrl = async (rawUrl, overrides = {}) => {
  const config = { ...getUrlGuardConfig(), ...overrides };

  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new UrlGuardError('A URL string is required', 'MISSING_URL');
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > config.maxUrlLength) {
    throw new UrlGuardError(
      `URL exceeds the maximum length of ${config.maxUrlLength} characters`,
      'URL_TOO_LONG'
    );
  }
  if (/\s/.test(trimmed)) {
    throw new UrlGuardError('URL contains unencoded whitespace', 'INVALID_URL');
  }

  /*
   * `aa.com` is how people name a website, and `new URL()` throws on it, so
   * the API refused the most ordinary input there is. A missing scheme is
   * completed to https here as well as in the browser, because this endpoint
   * is callable directly and the browser's convenience is not a rule.
   *
   * Only input with no scheme at all is completed. Anything already carrying
   * one is passed through untouched and judged by the protocol check below,
   * so `javascript:` and `file:` are refused rather than turned into
   * something fetchable. The two patterns exist because dots are legal in
   * scheme names -- `coap+tcp:` is real -- so one pattern read `aa.com:8443`
   * as the scheme `aa.com:`; a port starts with a digit, an opaque scheme
   * does not.
   */
  const hasScheme =
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) || /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed.replace(/^\/\//, '')}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new UrlGuardError('URL is not well formed', 'INVALID_URL');
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new UrlGuardError(
      `Scheme '${parsed.protocol}' is not allowed; use http or https`,
      'SCHEME_BLOCKED'
    );
  }

  if (parsed.username || parsed.password) {
    throw new UrlGuardError('URLs with embedded credentials are not allowed', 'URL_BLOCKED');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === '.' || hostname === '..') {
    throw new UrlGuardError('URL has no usable hostname', 'INVALID_URL');
  }

  if (parsed.port && BLOCKED_PORTS.has(Number.parseInt(parsed.port, 10))) {
    throw new UrlGuardError(`Port ${parsed.port} is blocked`, 'PORT_BLOCKED');
  }

  for (const blocked of METADATA_HOSTNAMES) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      throw new UrlGuardError(
        `Hostname '${hostname}' is a cloud metadata endpoint`,
        'URL_BLOCKED'
      );
    }
  }

  if (!config.allowPrivateTargets) {
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new UrlGuardError(
        `Hostname '${hostname}' resolves to the local machine`,
        'PRIVATE_TARGET_BLOCKED'
      );
    }
  }

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    addresses = await resolveHostname(hostname, config.dnsTimeoutMs);
    if (addresses.length === 0) {
      throw new UrlGuardError(`Could not resolve '${hostname}'`, 'DNS_FAILURE');
    }
  }

  for (const address of addresses) {
    const reason = classifyAddress(address, config);
    if (reason) {
      throw new UrlGuardError(
        `'${hostname}' resolves to ${address}: ${reason}`,
        'PRIVATE_TARGET_BLOCKED'
      );
    }
  }

  return { url: parsed.href, hostname, addresses };
};

/**
 * Fetch a user-supplied URL with the guard applied at every redirect hop, a
 * hard request timeout, and a cap on how many bytes we are willing to read.
 */
export const safeFetch = async (rawUrl, options = {}) => {
  const config = { ...getUrlGuardConfig(), ...options.guard };
  const { method = 'GET', headers = {} } = options;

  let target = (await assertSafeUrl(rawUrl, config)).url;
  let hops = 0;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    let response;
    try {
      response = await fetch(target, {
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (hops >= config.maxRedirects) {
        throw new UrlGuardError(
          `Too many redirects (limit ${config.maxRedirects})`,
          'TOO_MANY_REDIRECTS'
        );
      }
      hops += 1;
      // Re-validate the redirect target: an open redirect is otherwise a
      // trivial bypass of the checks performed on the original URL.
      target = (await assertSafeUrl(new URL(location, target).href, config)).url;
      continue;
    }

    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > config.maxResponseBytes) {
      throw new UrlGuardError(
        `Response larger than the ${config.maxResponseBytes} byte limit`,
        'RESPONSE_TOO_LARGE'
      );
    }

    return { response, finalUrl: target, redirects: hops };
  }
};

/**
 * Express middleware: validates `req.body.url` and, unless disabled, performs a
 * redirect-following pre-flight so the crawler only ever sees a vetted target.
 */
export const validateURLMiddleware = async (req, res, next) => {
  const { url } = req.body ?? {};

  try {
    const config = getUrlGuardConfig();
    const validated = await assertSafeUrl(url, config);
    let finalUrl = validated.url;

    if (toBool(process.env.SKIP_URL_PREFLIGHT, false) !== true) {
      try {
        /*
         * Identify as the crawler that follows.
         *
         * This request's final URL becomes the scan target, so a server that
         * answers it differently from the browser decides what gets scanned.
         * Sending nothing meant google.com/travel/flights answered with a 302
         * to its "unsupported browser" page, which was then scanned and
         * reported as having no forms.
         *
         * Every hop is still validated exactly as before; only the headers
         * on the request changed.
         */
        const preflight = await safeFetch(finalUrl, {
          method: 'GET',
          headers: crawlerRequestHeaders()
        });
        finalUrl = preflight.finalUrl;
        if (preflight.response.body) {
          await preflight.response.body.cancel().catch(() => {});
        }
      } catch (preflightError) {
        // A blocked redirect target is a security decision and must fail hard.
        // Plain network failures are not: the crawler reports those itself.
        if (preflightError instanceof UrlGuardError) throw preflightError;
      }
    }

    req.validatedURL = finalUrl;
    req.resolvedAddresses = validated.addresses;
    next();
  } catch (error) {
    if (error instanceof UrlGuardError) {
      res.status(400).json({
        error: 'Invalid URL',
        message: error.message,
        code: error.code
      });
      return;
    }

    console.error('URL guard failure:', error.message);
    res.status(500).json({
      error: 'Validation error',
      message: 'An error occurred while validating the URL',
      code: 'VALIDATION_ERROR'
    });
  }
};
