// Reached by path because the API's dependencies live in server/node_modules
// and this test resolves from the repo root. The alternative was adding
// express to the root manifest for one test file.
import express from '../../server/node_modules/express/index.js';
import { afterEach, describe, expect, it } from 'vitest';

import { generalApiLimiter, jobReadLimiter } from '../../server/middleware/rateLimiting.js';

/**
 * The limiter locked the operator out of their own instance.
 *
 * A 133-second scan -- long because it waited out a slow model call -- cost
 * 66 status polls against a 100-request budget shared with everything else on
 * /api. The next scan ran out mid-report, and the 429 told the client to
 * retry after 1793325535 seconds: fifty-six years, because the field carried
 * the reset moment as a Unix timestamp rather than a delay.
 *
 * Driven over a real socket on an ephemeral port rather than through a test
 * client, because express-rate-limit reads `req.ip` and the response headers
 * are part of what is being asserted. No new dependency for that.
 */
const servers = [];

const serve = (configure) => {
  const app = express();

  configure(app);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
});

/** Calls `path` until it is refused, returning the refusal. */
const exhaust = async (base, path, limit = 400) => {
  for (let i = 0; i < limit; i += 1) {
    const response = await fetch(`${base}${path}`);

    if (response.status === 429) {
      return response;
    }
  }

  return null;
};

const generalApp = () =>
  serve((app) => {
    app.use('/api', generalApiLimiter);
    app.get('/api/scan', (req, res) => res.json({ ok: true }));
    app.get('/api/report/:jobId', (req, res) => res.json({ ok: true }));
    app.get('/health', (req, res) => res.json({ ok: true }));
  });

describe('retryAfter is a delay, not a timestamp', () => {
  it('reports a number of seconds small enough to be a wait', async () => {
    const base = await generalApp();
    const refusal = await exhaust(base, '/api/scan');

    expect(refusal, 'limiter never fired').not.toBeNull();

    const body = await refusal.json();

    expect(typeof body.retryAfter).toBe('number');
    expect(body.retryAfter).toBeGreaterThan(0);
    // The window is 15 minutes, so any correct delay is under an hour. The
    // bug reported 1.79e9.
    expect(body.retryAfter).toBeLessThanOrEqual(3600);
  });

  it('sets the standard Retry-After header to the same value', async () => {
    const base = await generalApp();
    const refusal = await exhaust(base, '/api/scan');
    const body = await refusal.json();

    expect(Number(refusal.headers.get('retry-after'))).toBe(body.retryAfter);
  });

  it('says how long to wait in the message a user sees', async () => {
    const base = await generalApp();
    const refusal = await exhaust(base, '/api/scan');
    const body = await refusal.json();

    expect(body.message).toMatch(/wait \d+s/);
  });
});

describe('status polling does not spend the general budget', () => {
  it('lets a job read through after the general limit is exhausted', async () => {
    // The lockout itself: polls and scans shared one budget, so watching a
    // slow scan used up the allowance for reading the report it produced.
    const base = await generalApp();

    expect(await exhaust(base, '/api/scan'), 'general limiter never fired').not.toBeNull();

    const poll = await fetch(`${base}/api/report/job-1`);

    expect(poll.status).toBe(200);
  });

  it('still exempts the health check', async () => {
    const base = await generalApp();

    await exhaust(base, '/api/scan');

    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe('job reads are metered, just generously', () => {
  it('allows many more reads than the general budget permits', async () => {
    // Bounded on purpose -- an unmetered endpoint on an unauthenticated
    // server is somebody else's bandwidth bill. The point is only that a
    // long scan's polling cannot reach the ceiling.
    const base = await serve((app) => {
      app.use('/api', jobReadLimiter);
      app.get('/api/report/:jobId', (req, res) => res.json({ ok: true }));
    });

    for (let i = 0; i < 200; i += 1) {
      expect((await fetch(`${base}/api/report/job-1`)).status).toBe(200);
    }
  });
});
