/**
 * PNG cropping and vertical stitching.
 *
 * Exists because Chrome will not give us a correct cropped screenshot. Asking
 * for a `clip`, or for `fullPage`, routes the capture through a path that
 * drops separately composited layers: on a page whose form sits on a panel
 * over a coloured hero, the panel disappears and the hero shows through, so
 * the crop comes back as a flat wash with ghost text on it. A plain
 * viewport screenshot paints correctly, so we take those and do the cropping
 * here instead.
 *
 * Pure buffer work, no page access, so it is testable without a browser.
 */
import { PNG } from 'pngjs';

/** Decoded dimensions, for callers that need them before cropping. */
export function readPngSize(buffer) {
  const png = PNG.sync.read(buffer);

  return { width: png.width, height: png.height };
}

/**
 * Cuts a rectangle out of a PNG. The rectangle is clamped to the source, so a
 * region that overhangs the image yields the overlapping part rather than
 * throwing -- a form at the very bottom of a page is a normal case, not an
 * error.
 */
export function cropPng(buffer, { x, y, width, height }) {
  const src = PNG.sync.read(buffer);

  const sx = clamp(Math.round(x), 0, src.width);
  const sy = clamp(Math.round(y), 0, src.height);
  const w = clamp(Math.round(width), 0, src.width - sx);
  const h = clamp(Math.round(height), 0, src.height - sy);

  if (w <= 0 || h <= 0) {
    throw new Error(
      `crop ${Math.round(width)}x${Math.round(height)} at ${Math.round(x)},${Math.round(y)} ` +
        `lies outside a ${src.width}x${src.height} capture`
    );
  }

  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, sx, sy, w, h, 0, 0);

  return { buffer: PNG.sync.write(out), width: w, height: h };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
