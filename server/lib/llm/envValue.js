/**
 * Reads a configuration value the way a human pastes one.
 *
 * Environment variables arrive from dashboards and clipboards, and both add
 * things that are invisible afterwards. A trailing newline from a paste, or
 * the quotes that `.env` files carry and dotenv strips but a hosting
 * dashboard does not, make a value that looks identical in every log line
 * and is a different string to the API being called.
 *
 * This cost a deployment. `MUSE_MODEL` on Render had whitespace around
 * `muse-wonder-1.0`, so every scan came back `404 The requested model was
 * not found.` -- an error that blames the model id, printed in a startup
 * banner as `(muse-wonder-1.0)` with the whitespace invisible, with the
 * scan itself completing on the heuristic fallback and returning HTTP 200.
 * Verified against the live API: a clean id returns 200, while a trailing
 * space, a leading space, a newline, a carriage return, double quotes and
 * single quotes each return exactly that 404.
 *
 * Being strict about the input is not worth anything here. Nobody means to
 * configure a model called "muse-wonder-1.0\n".
 */
export const cleanEnvValue = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const trimmed = String(value).trim();

  // Strip one matching pair of surrounding quotes. Only a matching pair: an
  // apostrophe inside a value is not a quote to remove.
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
      ? trimmed.slice(1, -1).trim()
      : trimmed;

  // An empty result is reported as absent, so callers fall back to their
  // default instead of sending "" and getting a puzzling error.
  return unquoted === '' ? undefined : unquoted;
};

/** Reads and cleans one environment variable. */
export const readEnvValue = (name, fallback = undefined) =>
  cleanEnvValue(process.env[name]) ?? fallback;
