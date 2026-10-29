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

const baseConfig = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`Rate limit exceeded for ${req.ip} on ${req.method} ${req.path}`);

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please slow down your requests.',
      retryAfter: Math.ceil((req.rateLimit?.resetTime ?? Date.now()) / 1000)
    });
  }
};

/**
 * General API rate limiting, applied to every /api route.
 */
export const generalApiLimiter = rateLimit({
  ...baseConfig,
  windowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  max: toInt(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
  skip: (req) => req.path === '/health'
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

    res.status(429).json({
      error: 'Scan Rate Limit Exceeded',
      message: 'Too many scan requests. Please wait before starting another scan.',
      retryAfter: Math.ceil((req.rateLimit?.resetTime ?? Date.now()) / 1000)
    });
  }
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
