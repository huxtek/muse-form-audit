/**
 * Loads `.env` before anything else can read `process.env`.
 *
 * This exists because of module evaluation order, not tidiness. `server.js`
 * called `dotenv.config()` on line 9, above its other imports, which looks
 * early enough and is not: ESM hoists every `import` declaration and
 * evaluates those modules in full before any statement in the importing
 * module's body. So every imported module ran first, and any of them that
 * read `process.env` at module scope read an empty one.
 *
 * The result was a whole class of settings that silently did nothing
 * locally. All four rate limits fell back to their code defaults, so
 * SCAN_RATE_LIMIT_MAX_REQUESTS in `.env` had never once taken effect; the
 * same went for MODEL_VISION, MODEL_HTML_CHAR_LIMIT, MODEL_MAX_IMAGE_BYTES,
 * PROBE_FORM_BEHAVIOUR, SCREENSHOT_STORE_MAX_BYTES and SCAN_TIER in the
 * analyze route. It was invisible because Render passes real environment
 * variables, where none of this applies -- so the deployment honoured
 * settings the developer's machine ignored.
 *
 * Imported for its side effect, and it must stay the first import in any
 * entry point. A side-effect import is the one thing that reliably runs
 * before its siblings.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(here, '..', '..', '.env') });
