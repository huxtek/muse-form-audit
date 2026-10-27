/**
 * In-memory store for per-form screenshots.
 *
 * Screenshots are tens to hundreds of kilobytes each. Inlining them as base64
 * in the scan results would make every poll of /api/report carry the whole
 * payload again, so the bytes live here and the results carry only geometry
 * plus a flag. The client fetches images from /api/screenshot/:jobId/:index.
 *
 * Demo-grade on purpose: process memory, lost on restart, no persistence. A
 * byte budget with oldest-first eviction keeps a long session from growing
 * without bound, since scan jobs themselves are never evicted today.
 */

const MAX_TOTAL_BYTES = Number(process.env.SCREENSHOT_STORE_MAX_BYTES || 150 * 1024 * 1024);

/** key -> { buffer, contentType, byteLength, storedAt } */
const store = new Map();
let totalBytes = 0;

const keyFor = (jobId, formIndex) => `${jobId}:${formIndex}`;

/** Drops oldest entries until the store is back inside its budget. */
function evictToFit() {
  for (const [key, entry] of store) {
    if (totalBytes <= MAX_TOTAL_BYTES) {
      break;
    }

    store.delete(key);
    totalBytes -= entry.byteLength;
  }
}

export function putScreenshot(jobId, formIndex, { buffer, contentType = 'image/png' }) {
  if (!buffer?.length) {
    return;
  }

  const key = keyFor(jobId, formIndex);
  const existing = store.get(key);
  if (existing) {
    totalBytes -= existing.byteLength;
  }

  store.set(key, {
    buffer,
    contentType,
    byteLength: buffer.length,
    storedAt: Date.now()
  });
  totalBytes += buffer.length;

  evictToFit();
}

export function getScreenshot(jobId, formIndex) {
  return store.get(keyFor(jobId, formIndex)) ?? null;
}

export function deleteJobScreenshots(jobId) {
  const prefix = `${jobId}:`;

  for (const [key, entry] of store) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      totalBytes -= entry.byteLength;
    }
  }
}

/** For /health and tests. */
export function screenshotStoreStats() {
  return {
    entries: store.size,
    bytes: totalBytes,
    maxBytes: MAX_TOTAL_BYTES
  };
}

/** Test helper. */
export function resetScreenshotStore() {
  store.clear();
  totalBytes = 0;
}
