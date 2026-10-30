import { describe, expect, it } from 'vitest';

import {
  expandViewportToPage,
  VISUAL_LIMITS
} from '../../server/lib/visuals/captureFormVisuals.js';

/**
 * Growing the viewport can make the page taller, which cost openai.com a
 * screenshot.
 *
 * Chrome only paints a plain unclipped viewport screenshot correctly, so the
 * viewport is grown to cover the page and photographed in one frame. That
 * measured the height once, resized, and shot. Measured on the live site:
 *
 *   at 1280x720          page 5980px, lowest field at y=5948  (inside)
 *   grown once to 5980   page 6256px, lowest field at y=6224  (outside)
 *   pass 2 regrew to 6256, pass 3 stable
 *
 * The locale search box ended up below the bottom of its own photograph, and
 * the report said "No screenshot for this form" with the reason "crop 239x52
 * at 1025,6177 lies outside a 1280x5980 capture".
 */

/**
 * A page whose height grows each time the viewport reaches it, the way lazy
 * sections render once they fall inside a very tall viewport. `heights` is
 * the sequence the page reports on successive measurements.
 */
const stubPage = (heights, { width = 1280, startHeight = 720 } = {}) => {
  const remaining = [...heights];
  let viewport = { width, height: startHeight };
  const applied = [];
  let measurements = 0;

  return {
    applied,
    get measurements() {
      return measurements;
    },
    viewport: () => viewport,
    setViewport: async (next) => {
      viewport = { ...next };
      applied.push(next.height);
    },
    evaluate: async () => {
      measurements += 1;

      return remaining.length > 1 ? remaining.shift() : remaining[0];
    }
  };
};

// No waiting around in tests; the settle is covered by the live runs.
const limits = { ...VISUAL_LIMITS, reflowSettleMs: 0 };

describe('growing the viewport to cover the page', () => {
  it('regrows when the first resize makes the page taller', async () => {
    // openai.com's measured sequence: 5980, then 6256 once grown, then stable.
    const page = stubPage([5980, 6256, 6256]);

    await expandViewportToPage(page, { limits, logger: { log: () => {} } });

    expect(page.applied).toEqual([5980, 6256]);
    expect(page.viewport().height).toBe(6256);
  });

  it('leaves the lowest form inside the frame it is photographed in', async () => {
    // The property that actually failed: the capture must end at or below
    // the page's full height, or a crop down there lies outside the image.
    const page = stubPage([5980, 6256, 6256]);

    await expandViewportToPage(page, { limits, logger: { log: () => {} } });

    expect(page.viewport().height).toBeGreaterThanOrEqual(6224);
  });

  it('stops as soon as the height settles', async () => {
    const page = stubPage([4000, 4000]);

    await expandViewportToPage(page, { limits, logger: { log: () => {} } });

    expect(page.applied).toEqual([4000]);
  });

  it('gives up at the capture cap rather than growing without end', async () => {
    // A page that grows every time it is measured must not loop forever.
    const page = stubPage([9000, 12000, 20000, 30000, 40000, 50000]);

    await expandViewportToPage(page, { limits, logger: { log: () => {} } });

    expect(page.viewport().height).toBe(limits.maxCaptureHeight);
    expect(page.applied.length).toBeLessThanOrEqual(VISUAL_LIMITS.maxGrowthPasses);
  });

  it('never exceeds the configured pass budget', async () => {
    const page = stubPage([2000, 3000, 4000, 5000, 6000, 7000, 7500]);

    await expandViewportToPage(page, { limits: { ...limits, maxGrowthPasses: 2 }, logger: { log: () => {} } });

    expect(page.applied.length).toBe(2);
  });

  it('does nothing when the page already fits', async () => {
    const page = stubPage([500], { startHeight: 720 });

    const restore = await expandViewportToPage(page, { limits, logger: { log: () => {} } });

    expect(page.applied).toEqual([]);
    await restore();
  });

  it('puts the original viewport back', async () => {
    const page = stubPage([5980, 6256, 6256]);

    const restore = await expandViewportToPage(page, { limits, logger: { log: () => {} } });
    await restore();

    expect(page.viewport()).toEqual({ width: 1280, height: 720 });
  });
});

describe('partial limit overrides', () => {
  it('still grows when the caller omits the pass budget', async () => {
    /*
     * Callers pass partial limits. With the budget left undefined the loop
     * bound was NaN, so the viewport was never grown at all and every form
     * below the fold lost its screenshot -- a worse version of the bug this
     * change exists to fix.
     */
    const page = stubPage([4393, 4393]);

    await expandViewportToPage(page, {
      limits: { maxCaptureHeight: 8000, reflowSettleMs: 0 },
      logger: { log: () => {} }
    });

    expect(page.applied).toEqual([4393]);
  });
});
