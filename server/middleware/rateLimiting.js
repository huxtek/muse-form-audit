import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Rate limiting for HuxTek.
 *
 * The server is unauthenticated, so rate limits are the only thing standing
 * between a stranger and the operator's LLM API bill. They are enabled in every
 * environment, not just production.
 */

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Seconds to wait, which is what `retryAfter` has always claimed to be.
 *
 * It used to report `resetTime / 1000` -- the reset moment as a Unix
 * timestamp. A caller reading the field as a delay, which is the only thing
 * its name can mean, was told to wait 1793325535 seconds: fifty-six years.
 */
const retryAfterSeconds = (req) => {
  const resetTime = req.rateLimit?.resetTime;
  const waitMs = resetTime ? new Date(resetTime).getTime() - Date.now() : 0;

  return Math.max(1, Math.ceil(waitMs / 1000));
};

const baseConfig = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`Rate limit exceeded for ${req.ip} on ${req.method} ${req.path}`);

    const seconds = retryAfterSeconds(req);

    res.set('Retry-After', String(seconds));
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please wait ${seconds}s before retrying.`,
      retryAfter: seconds
    });
  }
};

/**
 * General API rate limiting, applied to every /api route.
 */
/**
 * Reads of a running job, which `jobReadLimiter` meters instead.
 *
 * This limiter is mounted on `/api`, so without the exemption a status poll
 * would be counted twice and the larger allowance below would have no
 * effect: the general budget would still run out first. Paths are
 * mount-relative here, which is why they have no `/api` prefix -- the log
 * line for the lockout read `GET /report/927a39b5-...`.
 */
const isJobRead = (req) =>
  ['/report/', '/screenshot/', '/page-map/'].some((prefix) => req.path.startsWith(prefix));

export const generalApiLimiter = rateLimit({
  ...baseConfig,
  windowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  max: toInt(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
  skip: (req) => req.path === '/health' || isJobRead(req)
});

/**
 * Scan rate limiting. Scans are the expensive path: each one spends LLM credits
 * and browser time, so this limit is deliberately tight.
 */
export const scanLimiter = rateLimit({
  ...baseConfig,
  windowMs: toInt(process.env.SCAN_RATE_LIMIT_WINDOW_MS, 5 * 60 * 1000),
  max: toInt(process.env.SCAN_RATE_LIMIT_MAX_REQUESTS, 5),
  // ipKeyGenerator normalises IPv6 into a /64 subnet key; using req.ip
  // directly would let an IPv6 client rotate addresses to bypass the limit.
  keyGenerator: (req) => `scan:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    console.log(`Scan rate limit exceeded for ${req.ip}`);

    const seconds = retryAfterSeconds(req);

    res.set('Retry-After', String(seconds));
    res.status(429).json({
      error: 'Scan Rate Limit Exceeded',
      message: `Too many scan requests. Please wait ${seconds}s before starting another scan.`,
      retryAfter: seconds
    });
  }
});

/**
 * Reads of a job already under way: status, screenshots, page maps.
 *
 * These need their own, much larger allowance because their cost is not the
 * client's choice. The UI polls a running scan every couple of seconds, so
 * the number of reads is set by how long the scan takes -- and a scan that
 * waits out a model outage can run for minutes. One measured 133-second
 * scan spent 66 of the general limiter's 100 requests on its own progress,
 * so a second slow scan locked the operator out of their own instance
 * mid-report.
 *
 * Still bounded: a read is cheap but not free, and an unmetered endpoint on
 * an unauthenticated server is how someone else's bandwidth bill grows.
 */
export const jobReadLimiter = rateLimit({
  ...baseConfig,
  windowMs: toInt(process.env.JOB_READ_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  max: toInt(process.env.JOB_READ_RATE_LIMIT_MAX_REQUESTS, 900)
});

/**
 * Public endpoint rate limiting (health checks and similar).
 */
export const publicLimiter = rateLimit({
  ...baseConfig,
  windowMs: toInt(process.env.PUBLIC_RATE_LIMIT_WINDOW_MS, 60 * 1000),
  max: toInt(process.env.PUBLIC_RATE_LIMIT_MAX_REQUESTS, 30)
});

/**
 * Surfaces the current rate limit state on the response for easier debugging.
 */
export function rateLimitInfo(req, res, next) {
  if (req.rateLimit) {
    res.set({
      'X-RateLimit-Limit': req.rateLimit.limit,
      'X-RateLimit-Remaining': req.rateLimit.remaining,
      'X-RateLimit-Reset': new Date(req.rateLimit.resetTime).toISOString()
    });
  }

  next();
}
