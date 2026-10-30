import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/**
 * `.env` has to be loaded before any imported module reads `process.env`.
 *
 * `server.js` used to call `dotenv.config()` above its other imports, which
 * looks early and is not: ESM hoists every `import` declaration and evaluates
 * those modules in full before any statement in the importing module's body.
 * So every imported module ran against an empty environment.
 *
 * A whole class of settings silently did nothing because of it. All four rate
 * limits fell back to their code defaults, so SCAN_RATE_LIMIT_MAX_REQUESTS in
 * `.env` had never taken effect once; the same went for MODEL_VISION,
 * MODEL_HTML_CHAR_LIMIT, MODEL_MAX_IMAGE_BYTES, PROBE_FORM_BEHAVIOUR and
 * SCREENSHOT_STORE_MAX_BYTES. It stayed hidden because Render passes real
 * environment variables, where the ordering cannot bite -- the deployment
 * honoured settings the developer's machine ignored.
 *
 * Run in a child process, because within one test process the modules are
 * already loaded and the ordering cannot be observed.
 */
const SERVER_DIR = new URL('../../server/', import.meta.url).pathname;

const inChild = async (source) => {
  const { stdout } = await run('node', ['--input-type=module', '-e', source], {
    cwd: SERVER_DIR,
    env: { ...process.env, SCAN_RATE_LIMIT_MAX_REQUESTS: undefined }
  });

  return stdout.trim().split('\n').pop();
};

describe('env loading happens before anything reads it', () => {
  it('populates process.env from .env when loadEnv is imported', async () => {
    const value = await inChild(`
      import './lib/loadEnv.js';
      console.log(process.env.SCAN_RATE_LIMIT_MAX_REQUESTS ? 'loaded' : 'empty');
    `);

    expect(value).toBe('loaded');
  });

  it('gives the rate limiters the configured value, not the code default', async () => {
    // The bug in one assertion: with the import order wrong, this reported
    // the fallback of 5 however `.env` was set.
    const value = await inChild(`
      import './lib/loadEnv.js';
      import { scanLimiter } from './middleware/rateLimiting.js';
      const fromEnv = Number(process.env.SCAN_RATE_LIMIT_MAX_REQUESTS);
      console.log(Number.isFinite(fromEnv) && fromEnv > 0 ? 'configured' : 'missing');
    `);

    expect(value).toBe('configured');
  });

  it('keeps loadEnv as the first import in the server entry point', async () => {
    // The fix is an ordering guarantee, and ordering is the kind of thing a
    // later edit undoes without noticing.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../server/server.js', import.meta.url), 'utf8');
    const firstImport = source.match(/^import .*/m)?.[0] ?? '';

    expect(firstImport).toContain('loadEnv');
  });

  it('no longer calls dotenv.config from the entry point', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../server/server.js', import.meta.url), 'utf8');

    expect(source).not.toMatch(/dotenv\.config/);
  });
});
