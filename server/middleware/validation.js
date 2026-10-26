/**
 * Request payload validation.
 *
 * URL validation lives in `urlGuard.js` because it is a security control rather
 * than ordinary input shaping; it is re-exported here so route modules have a
 * single import site.
 */

export {
  UrlGuardError,
  assertSafeUrl,
  safeFetch,
  validateURLMiddleware,
  getUrlGuardConfig
} from './urlGuard.js';

export function sanitizeString(input, maxLength = 1000) {
  if (typeof input !== 'string') return '';

  return input
    .trim()
    .slice(0, maxLength)
    .replace(/[<>"'&]/g, '')
    .replace(/\s+/g, ' ');
}

export function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    return { isValid: true, sanitized: {}, errors: [] };
  }

  const sanitized = {};
  const errors = [];

  const booleanOptions = ['fullCrawl', 'devMode'];
  for (const option of booleanOptions) {
    if (option in options) {
      if (typeof options[option] === 'boolean') {
        sanitized[option] = options[option];
      } else {
        errors.push(`${option} must be a boolean`);
      }
    }
  }

  if ('timeout' in options) {
    const timeout = Number.parseInt(options.timeout, 10);
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300000) {
      errors.push('timeout must be between 1000 and 300000 milliseconds');
    } else {
      sanitized.timeout = timeout;
    }
  }

  return {
    isValid: errors.length === 0,
    sanitized,
    errors
  };
}
