import { afterEach, describe, expect, it } from 'vitest';

import { cleanEnvValue, readEnvValue } from '../../server/lib/llm/envValue.js';

/**
 * These are the exact contaminations that broke the deployment. `MUSE_MODEL`
 * on Render carried whitespace around `muse-wonder-1.0`, so every scan
 * returned `404 The requested model was not found.` while the startup banner
 * printed `(muse-wonder-1.0)` and the scan completed on the heuristic
 * fallback with HTTP 200. Each form below was confirmed against the live API
 * to produce that 404.
 */
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('cleanEnvValue', () => {
  it('leaves a clean value alone', () => {
    expect(cleanEnvValue('muse-wonder-1.0')).toBe('muse-wonder-1.0');
  });

  it('strips the whitespace a paste leaves behind', () => {
    for (const raw of [
      'muse-wonder-1.0 ',
      ' muse-wonder-1.0',
      'muse-wonder-1.0\n',
      'muse-wonder-1.0\r',
      '\tmuse-wonder-1.0\r\n'
    ]) {
      expect(cleanEnvValue(raw)).toBe('muse-wonder-1.0');
    }
  });

  it('strips the quotes a .env file carries', () => {
    // dotenv removes these locally, which is why a quoted value works on a
    // laptop and fails on a host that stores it literally.
    expect(cleanEnvValue('"muse-wonder-1.0"')).toBe('muse-wonder-1.0');
    expect(cleanEnvValue("'muse-wonder-1.0'")).toBe('muse-wonder-1.0');
    expect(cleanEnvValue(' "muse-wonder-1.0" ')).toBe('muse-wonder-1.0');
  });

  it('only strips a matching pair', () => {
    // An apostrophe or a stray quote inside a value is content, not syntax.
    expect(cleanEnvValue('"muse-wonder-1.0')).toBe('"muse-wonder-1.0');
    expect(cleanEnvValue("it's-a-model")).toBe("it's-a-model");
    expect(cleanEnvValue('say-"hi"-now')).toBe('say-"hi"-now');
  });

  it('does not strip quotes from inside the value', () => {
    expect(cleanEnvValue('"a" and "b"')).toBe('a" and "b');
  });

  it('reports absent and blank values as undefined', () => {
    // So a caller falls back to its default rather than sending "" and
    // getting an error that describes the wrong problem.
    expect(cleanEnvValue(undefined)).toBeUndefined();
    expect(cleanEnvValue(null)).toBeUndefined();
    expect(cleanEnvValue('')).toBeUndefined();
    expect(cleanEnvValue('   ')).toBeUndefined();
    expect(cleanEnvValue('""')).toBeUndefined();
  });

  it('keeps a value that is only incidentally quote-like', () => {
    expect(cleanEnvValue('"')).toBe('"');
  });
});

describe('readEnvValue', () => {
  it('cleans what it reads from the environment', () => {
    process.env.TEST_MODEL = '  muse-wonder-1.0\n';

    expect(readEnvValue('TEST_MODEL')).toBe('muse-wonder-1.0');
  });

  it('falls back when the variable is absent', () => {
    delete process.env.TEST_MODEL;

    expect(readEnvValue('TEST_MODEL', 'default-model')).toBe('default-model');
  });

  it('falls back when the variable is set to whitespace', () => {
    process.env.TEST_MODEL = '   ';

    expect(readEnvValue('TEST_MODEL', 'default-model')).toBe('default-model');
  });
});
