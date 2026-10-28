import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachVisualsToForms,
  captureFormVisuals,
  formsLookRelated,
  readFormGeometry,
  resolvePadding,
  toVisualMetadata
} from '../../server/lib/visuals/captureFormVisuals.js';
import {
  deleteJobScreenshots,
  getScreenshot,
  putScreenshot,
  resetScreenshotStore,
  screenshotStoreStats
} from '../../server/lib/visuals/screenshotStore.js';
import { normalizeFormAnalysis, SEVERITIES } from '../../server/lib/analysis/formAnalysisSchema.js';
import { cropPng, readPngSize, stitchPngColumn } from '../../server/lib/visuals/cropImage.js';
import { PNG } from 'pngjs';

/** A real PNG of a given size, memoised because encoding is not free. */
const pngCache = new Map();

function solidPng(width, height, value = 255) {
  const key = `${width}x${height}x${value}`;

  if (!pngCache.has(key)) {
    const png = new PNG({ width, height });
    png.data.fill(value);
    pngCache.set(key, PNG.sync.write(png));
  }

  return pngCache.get(key);
}

/** A PNG whose every pixel encodes its own row, so crops can be located. */
function stripedPng(width, height) {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (width * y + x) << 2;
      png.data[i] = y % 256;
      png.data[i + 1] = x % 256;
      png.data[i + 2] = 0;
      png.data[i + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}

/** The pixel at a coordinate, as [r, g, b]. */
function pixelAt(buffer, x, y) {
  const png = PNG.sync.read(buffer);
  const i = (png.width * y + x) << 2;

  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

/**
 * The overlay draws boxes from these coordinates, so a wrong pairing puts a
 * highlight on the wrong control -- worse than showing nothing. These tests
 * pin the pairing rules, the metadata/bytes split, and the store's eviction.
 */

const silent = { log: () => {}, warn: () => {} };

describe('formsLookRelated', () => {
  it('accepts when the forms share a field identifier', () => {
    const extracted = { fields: [{ name: 'custname' }, { name: 'custtel' }] };
    const visual = { fields: [{ name: 'custname', id: '' }, { name: 'submit', id: '' }] };

    expect(formsLookRelated(extracted, visual)).toBe(true);
  });

  it('matches case-insensitively and on id as well as name', () => {
    expect(
      formsLookRelated({ fields: [{ id: 'Email' }] }, { fields: [{ name: '', id: 'email' }] })
    ).toBe(true);
  });

  it('rejects when nothing is shared, so no highlight is misplaced', () => {
    const extracted = { fields: [{ name: 'alpha' }, { name: 'beta' }] };
    const visual = { fields: [{ name: 'gamma', id: '' }] };

    expect(formsLookRelated(extracted, visual)).toBe(false);
  });

  it('accepts when either side has no identifiers at all', () => {
    // Nothing to compare: document order is the only signal, and the overlay
    // simply has no names to attribute findings to.
    expect(formsLookRelated({ fields: [] }, { fields: [{ name: 'x' }] })).toBe(true);
    expect(formsLookRelated({ fields: [{ name: 'x' }] }, { fields: [] })).toBe(true);
    expect(formsLookRelated(undefined, undefined)).toBe(true);
  });

  it('tolerates a selector difference in field count', () => {
    // The extractor takes button[type=submit] while the capture takes every
    // button, so counts legitimately differ by one on an untyped button.
    const extracted = { fields: Array.from({ length: 12 }, (_, i) => ({ name: `f${i}` })) };
    const visual = {
      fields: Array.from({ length: 13 }, (_, i) => ({ name: i === 12 ? 'btn' : `f${i}`, id: '' }))
    };

    expect(formsLookRelated(extracted, visual)).toBe(true);
  });
});

describe('toVisualMetadata', () => {
  it('removes the image bytes and flags that a screenshot exists', () => {
    const metadata = toVisualMetadata({
      formIndex: 0,
      width: 100,
      height: 50,
      fields: [],
      screenshot: Buffer.from('png-bytes'),
      contentType: 'image/png',
      byteLength: 9
    });

    expect(metadata.hasScreenshot).toBe(true);
    expect(metadata).not.toHaveProperty('screenshot');
    expect(metadata).not.toHaveProperty('byteLength');
  });

  it('reports hasScreenshot false when capture failed', () => {
    const metadata = toVisualMetadata({
      formIndex: 1,
      screenshot: null,
      unavailableReason: 'form is hidden or has no size'
    });

    expect(metadata.hasScreenshot).toBe(false);
    expect(metadata.unavailableReason).toBe('form is hidden or has no size');
  });

  it('returns null for a missing visual', () => {
    expect(toVisualMetadata(null)).toBeNull();
  });
});

describe('attachVisualsToForms', () => {
  const form = { formId: 'form-0', fields: [{ name: 'email' }] };
  const visual = {
    formIndex: 0,
    width: 600,
    height: 300,
    fields: [{ name: 'email', id: '', rect: { x: 1, y: 2, width: 3, height: 4 } }],
    signature: { fieldCount: 1 },
    screenshot: Buffer.from('png'),
    contentType: 'image/png',
    byteLength: 3
  };

  it('pairs by document order and stores the bytes separately', () => {
    const put = vi.fn();
    const [result] = attachVisualsToForms({
      forms: [form],
      visuals: [visual],
      jobId: 'job-1',
      putScreenshot: put,
      logger: silent
    });

    expect(result.visual.hasScreenshot).toBe(true);
    expect(result.visual.visualIndex).toBe(0);
    expect(result.visual).not.toHaveProperty('screenshot');
    expect(put).toHaveBeenCalledWith('job-1', 0, {
      buffer: visual.screenshot,
      contentType: 'image/png'
    });
  });

  it('offsets the index so a multi-page crawl keys stay unique', () => {
    const put = vi.fn();
    const [result] = attachVisualsToForms({
      forms: [form],
      visuals: [visual],
      jobId: 'job-1',
      putScreenshot: put,
      indexOffset: 7,
      logger: silent
    });

    expect(result.visual.visualIndex).toBe(7);
    expect(put).toHaveBeenCalledWith('job-1', 7, expect.anything());
  });

  it('drops the geometry when the pairing looks wrong', () => {
    const put = vi.fn();
    const [result] = attachVisualsToForms({
      forms: [{ fields: [{ name: 'totally-different' }] }],
      visuals: [visual],
      jobId: 'job-1',
      putScreenshot: put,
      logger: silent
    });

    expect(result).not.toHaveProperty('visual');
    expect(put).not.toHaveBeenCalled();
  });

  it('leaves a form untouched when no visual was captured for it', () => {
    const [result] = attachVisualsToForms({
      forms: [form],
      visuals: [],
      jobId: 'job-1',
      putScreenshot: vi.fn(),
      logger: silent
    });

    expect(result).toEqual(form);
  });
});

describe('readFormGeometry', () => {
  it('passes the selector and caps into the page context', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue([]) };

    await readFormGeometry(page, { maxForms: 3, minFormSize: 8 });

    const [, selector, maxForms, minSize] = page.evaluate.mock.calls[0];
    expect(selector).toContain('input');
    expect(selector).toContain('button');
    expect(maxForms).toBe(3);
    expect(minSize).toBe(8);
  });
});

describe('screenshotStore', () => {
  beforeEach(() => {
    resetScreenshotStore();
  });

  it('stores and retrieves bytes by job and form index', () => {
    putScreenshot('job-1', 0, { buffer: Buffer.from('abc') });

    const entry = getScreenshot('job-1', 0);
    expect(entry.buffer.toString()).toBe('abc');
    expect(entry.contentType).toBe('image/png');
    expect(getScreenshot('job-1', 1)).toBeNull();
    expect(getScreenshot('other', 0)).toBeNull();
  });

  it('ignores an empty buffer', () => {
    putScreenshot('job-1', 0, { buffer: Buffer.alloc(0) });

    expect(getScreenshot('job-1', 0)).toBeNull();
    expect(screenshotStoreStats().entries).toBe(0);
  });

  it('replaces an entry without double counting its bytes', () => {
    putScreenshot('job-1', 0, { buffer: Buffer.alloc(100) });
    putScreenshot('job-1', 0, { buffer: Buffer.alloc(10) });

    expect(screenshotStoreStats()).toMatchObject({ entries: 1, bytes: 10 });
  });

  it('removes every screenshot for one job and leaves others alone', () => {
    putScreenshot('job-1', 0, { buffer: Buffer.alloc(5) });
    putScreenshot('job-1', 1, { buffer: Buffer.alloc(5) });
    putScreenshot('job-2', 0, { buffer: Buffer.alloc(5) });

    deleteJobScreenshots('job-1');

    expect(getScreenshot('job-1', 0)).toBeNull();
    expect(getScreenshot('job-2', 0)).not.toBeNull();
    expect(screenshotStoreStats()).toMatchObject({ entries: 1, bytes: 5 });
  });
});

describe('fieldIssues normalisation', () => {
  it('keeps well-formed entries and defaults an unknown severity', () => {
    const result = normalizeFormAnalysis({
      fieldIssues: [
        { field: 'custname', severity: 'high', issue: 'No id attribute' },
        { field: 'custtel', severity: 'catastrophic', issue: 'No pattern' }
      ]
    });

    expect(result.fieldIssues[0]).toEqual({
      field: 'custname',
      severity: 'high',
      issue: 'No id attribute'
    });
    // An unrecognised severity must not leak into the UI's colour mapping.
    expect(result.fieldIssues[1].severity).toBe('medium');
    expect(SEVERITIES).toContain(result.fieldIssues[1].severity);
  });

  it('drops entries with no field or no message, since they cannot be placed', () => {
    const result = normalizeFormAnalysis({
      fieldIssues: [
        { severity: 'high', issue: 'Unattributed' },
        { field: 'custname' },
        { field: '   ', issue: 'blank field' },
        'not an object',
        null
      ]
    });

    expect(result.fieldIssues).toEqual([]);
  });

  it('accepts alternative key names models sometimes use', () => {
    const result = normalizeFormAnalysis({
      fieldIssues: [{ name: 'email', message: 'Missing label' }]
    });

    expect(result.fieldIssues).toEqual([
      { field: 'email', severity: 'medium', issue: 'Missing label' }
    ]);
  });

  it('lowercases nothing and preserves the exact field token', () => {
    // The overlay matches case-insensitively, but the token is shown to the
    // user, so it must survive verbatim.
    const result = normalizeFormAnalysis({
      fieldIssues: [{ field: 'customerName', issue: 'x' }]
    });

    expect(result.fieldIssues[0].field).toBe('customerName');
  });

  it('defaults to an empty list when absent', () => {
    expect(normalizeFormAnalysis({}).fieldIssues).toEqual([]);
    expect(normalizeFormAnalysis({ fieldIssues: 'nope' }).fieldIssues).toEqual([]);
  });
});

describe('resolvePadding', () => {
  const PAGE = { width: 1280, height: 2000 };

  it('applies the full padding when the form has room on every side', () => {
    const padding = resolvePadding({ x: 100, y: 200, width: 400, height: 300 }, PAGE, 16);

    expect(padding).toEqual({ padLeft: 16, padTop: 16, padRight: 16, padBottom: 16 });
  });

  it('clamps to the space that actually exists, per side', () => {
    // A full-width form has almost no horizontal room, so asking for 16 each
    // side would request a clip wider than the page.
    const padding = resolvePadding({ x: 8, y: 0, width: 1264, height: 600 }, PAGE, 16);

    expect(padding).toEqual({ padLeft: 8, padTop: 0, padRight: 8, padBottom: 16 });
  });

  it('never returns negative padding for a form at the origin', () => {
    const padding = resolvePadding({ x: 0, y: 0, width: 100, height: 100 }, PAGE, 16);

    expect(padding.padLeft).toBe(0);
    expect(padding.padTop).toBe(0);
  });

  it('never returns negative padding for a form overflowing the page', () => {
    const padding = resolvePadding({ x: 1200, y: 1900, width: 400, height: 400 }, PAGE, 16);

    expect(padding.padRight).toBe(0);
    expect(padding.padBottom).toBe(0);
  });

  it('falls back to the requested padding when the page size is unknown', () => {
    const padding = resolvePadding({ x: 100, y: 100, width: 10, height: 10 }, { width: 0, height: 0 }, 16);

    expect(padding).toEqual({ padLeft: 16, padTop: 16, padRight: 16, padBottom: 16 });
  });
});

describe('captureFormVisuals', () => {
  const LIMITS = {
    maxForms: 15,
    maxFormHeight: 4000,
    maxFormWidth: 2000,
    minFormSize: 8,
    padding: 16
  };

  /**
   * A page stub returning fixed geometry and a REAL png.
   *
   * It has to be a real image now: the capture takes unclipped viewport
   * screenshots and crops them here, so it decodes whatever the page hands
   * back. The old stub returned the bytes of the string "png-bytes", which is
   * part of why a capture that painted nothing went unnoticed.
   */
  const fakePage = ({ geometry, screenshot, viewport = { width: 1280, height: 720 } }) => {
    let reads = 0;

    return {
      evaluate: vi.fn(async (_fn, x = 0, y = 0) => {
        reads += 1;

        // The first call reads geometry; later ones are captureRegion
        // scrolling the region into view and reading the position back.
        return reads === 1
          ? geometry
          : { scrollX: Math.max(0, x), scrollY: Math.max(0, y), ...viewport };
      }),
      screenshot: vi.fn(screenshot ?? (async () => solidPng(viewport.width, viewport.height)))
    };
  };

  const geometryFor = (formRect, fields, pageSize = { width: 1280, height: 2000 }) => ({
    pageSize,
    forms: [
      {
        formIndex: 0,
        signature: { id: '', name: '', action: '/post', fieldCount: fields.length },
        visible: true,
        rect: formRect,
        fields
      }
    ]
  });

  it('shifts every field rect by the padding that was applied', async () => {
    const page = fakePage({
      geometry: geometryFor({ x: 200, y: 300, width: 400, height: 200 }, [
        { name: 'custname', id: '', rect: { x: 10, y: 0, width: 100, height: 20 }, renderable: true }
      ])
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    // Rects are measured from the form's origin, but the capture now starts
    // 16px earlier on both axes, so they must move with it.
    expect(visual.fields[0].rect).toEqual({ x: 26, y: 16, width: 100, height: 20 });
    expect(visual.padding).toEqual({ left: 16, top: 16, right: 16, bottom: 16 });
  });

  it('crops from the padded origin at the padded size', async () => {
    const page = fakePage({
      geometry: geometryFor({ x: 200, y: 300, width: 400, height: 200 }, [])
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    // Unclipped, then cut down here. Asking Chrome for a clip drops the
    // layer painting the form's background and returns a flat wash.
    expect(page.screenshot).toHaveBeenCalledWith({ type: 'png' });
    expect(visual.width).toBe(432);
    expect(visual.height).toBe(232);
  });

  it('shifts rects by the clamped padding when the form hugs the page edge', async () => {
    // A full-width form at x=8 has only 8px of room each side, so the shift
    // must be 8, not the requested 16. Getting this wrong offsets every box.
    const page = fakePage({
      geometry: geometryFor({ x: 8, y: 0, width: 1264, height: 600 }, [
        { name: 'custname', id: '', rect: { x: 109, y: 0, width: 185, height: 21 }, renderable: true }
      ])
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    expect(visual.padding).toEqual({ left: 8, top: 0, right: 8, bottom: 16 });
    expect(visual.fields[0].rect).toEqual({ x: 117, y: 0, width: 185, height: 21 });
    expect(visual.width).toBe(1280);
    expect(visual.height).toBe(616);
  });

  it('flags truncation and clamps the capture for an oversized form', async () => {
    const page = fakePage({
      geometry: geometryFor({ x: 0, y: 0, width: 500, height: 9000 }, []),
      viewport: { width: 1280, height: 2000 }
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    // The capture can only be as tall as the image it came from, so report
    // what the image actually holds: scaling highlights against a height the
    // image lacks misplaces every box.
    expect(visual.height).toBe(2000);
    expect(visual.truncated).toBe(true);
  });

  it('does not flag truncation for a form inside the limits', async () => {
    const page = fakePage({
      geometry: geometryFor({ x: 100, y: 100, width: 400, height: 300 }, [])
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    expect(visual.truncated).toBe(false);
  });

  it('reports the byte length and content type of the capture', async () => {
    const page = fakePage({
      geometry: geometryFor({ x: 0, y: 0, width: 100, height: 100 }, [])
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    expect(visual.contentType).toBe('image/png');
    expect(Buffer.isBuffer(visual.screenshot)).toBe(true);
    // The byte count must describe the cropped image that is actually stored,
    // not the full viewport shot it was cut from.
    expect(visual.byteLength).toBe(visual.screenshot.length);
  });

  it('skips a hidden form without attempting a screenshot', async () => {
    const page = fakePage({
      geometry: {
        pageSize: { width: 1280, height: 2000 },
        forms: [
          {
            formIndex: 0,
            signature: { fieldCount: 0 },
            visible: false,
            rect: { x: 0, y: 0, width: 0, height: 0 },
            fields: []
          }
        ]
      }
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    expect(page.screenshot).not.toHaveBeenCalled();
    expect(visual.screenshot).toBeNull();
    expect(visual.unavailableReason).toMatch(/hidden|no size/i);
  });

  it('keeps the field geometry when the screenshot itself fails', async () => {
    const page = fakePage({
      geometry: geometryFor({ x: 0, y: 0, width: 100, height: 100 }, [
        { name: 'custname', id: '', rect: { x: 1, y: 2, width: 3, height: 4 }, renderable: true }
      ]),
      screenshot: async () => {
        throw new Error('capture failed');
      }
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    // A failed capture must not lose the findings-to-control mapping.
    expect(visual.screenshot).toBeNull();
    expect(visual.unavailableReason).toMatch(/could not be captured/);
    expect(visual.fields).toHaveLength(1);
  });

  it('returns nothing rather than throwing when the geometry read fails', async () => {
    const page = {
      evaluate: vi.fn().mockRejectedValue(new Error('execution context destroyed')),
      screenshot: vi.fn()
    };

    await expect(captureFormVisuals(page, { limits: LIMITS, logger: silent })).resolves.toEqual([]);
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it('tolerates a page that returns a bare array of forms', async () => {
    // Defensive path: no pageSize means padding falls back to the request.
    const page = fakePage({
      geometry: [
        {
          formIndex: 0,
          signature: { fieldCount: 0 },
          visible: true,
          rect: { x: 50, y: 50, width: 100, height: 100 },
          fields: []
        }
      ]
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    expect(visual.width).toBe(132);
  });

  it('captures every form on the page', async () => {
    const page = fakePage({
      geometry: {
        pageSize: { width: 1280, height: 2000 },
        forms: [0, 1, 2].map((formIndex) => ({
          formIndex,
          signature: { fieldCount: 0 },
          visible: true,
          rect: { x: 100, y: 100 + formIndex * 300, width: 200, height: 100 },
          fields: []
        }))
      }
    });

    const visuals = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    expect(visuals).toHaveLength(3);
    expect(visuals.map((v) => v.formIndex)).toEqual([0, 1, 2]);
    // One page capture serves every form: it is the same image, cut three
    // ways, which is both correct and cheaper than three requests.
    expect(page.screenshot).toHaveBeenCalledOnce();
    expect(visuals.every((v) => v.screenshot)).toBe(true);
  });
});

describe('sample form visual', () => {
  it('keeps every sample rect inside the bundled image', async () => {
    const {
      SAMPLE_FORM_FIELDS,
      SAMPLE_FORM_HEIGHT,
      SAMPLE_FORM_IMAGE,
      SAMPLE_FORM_WIDTH,
      SAMPLE_FIELD_ISSUES,
      sampleFormVisual
    } = await import('../../server/lib/visuals/sampleFormVisual.js');

    // The PNG header carries the real dimensions; if the image is regenerated
    // at a different size without updating the rects, the Dev Mode overlay
    // would silently point at the wrong places.
    expect(SAMPLE_FORM_IMAGE.readUInt32BE(16)).toBe(SAMPLE_FORM_WIDTH);
    expect(SAMPLE_FORM_IMAGE.readUInt32BE(20)).toBe(SAMPLE_FORM_HEIGHT);

    for (const field of SAMPLE_FORM_FIELDS) {
      expect(field.rect.x).toBeGreaterThanOrEqual(0);
      expect(field.rect.y).toBeGreaterThanOrEqual(0);
      expect(field.rect.x + field.rect.width).toBeLessThanOrEqual(SAMPLE_FORM_WIDTH);
      expect(field.rect.y + field.rect.height).toBeLessThanOrEqual(SAMPLE_FORM_HEIGHT);
    }

    // Every sample finding must map to a sample box, or the mock overlay shows
    // an "unplaceable" footnote that looks like a bug.
    const names = new Set(SAMPLE_FORM_FIELDS.map((field) => field.name));
    for (const issue of SAMPLE_FIELD_ISSUES) {
      expect(names).toContain(issue.field);
    }

    expect(sampleFormVisual(3)).toMatchObject({ visualIndex: 3, hasScreenshot: true, isSample: true });
  });

  it('alternates a tall and a short wide shape, both matching their image', async () => {
    const {
      SAMPLE_WIDE_FIELDS,
      SAMPLE_WIDE_HEIGHT,
      SAMPLE_WIDE_IMAGE,
      SAMPLE_WIDE_WIDTH,
      sampleFormImage,
      sampleFormVisual
    } = await import('../../server/lib/visuals/sampleFormVisual.js');

    // A short wide capture is what exposed the clipped tooltip and the weak
    // enlarged view, so Dev Mode has to be able to reproduce it.
    expect(sampleFormVisual(0).sampleShape).toBe('tall');
    expect(sampleFormVisual(1).sampleShape).toBe('wide');
    expect(sampleFormVisual(1)).toMatchObject({
      width: SAMPLE_WIDE_WIDTH,
      height: SAMPLE_WIDE_HEIGHT
    });
    // Wide really is wide: the aspect ratio is what matters for the layout.
    expect(SAMPLE_WIDE_WIDTH / SAMPLE_WIDE_HEIGHT).toBeGreaterThan(5);

    expect(SAMPLE_WIDE_IMAGE.readUInt32BE(16)).toBe(SAMPLE_WIDE_WIDTH);
    expect(SAMPLE_WIDE_IMAGE.readUInt32BE(20)).toBe(SAMPLE_WIDE_HEIGHT);

    for (const field of SAMPLE_WIDE_FIELDS) {
      expect(field.rect.x + field.rect.width).toBeLessThanOrEqual(SAMPLE_WIDE_WIDTH);
      expect(field.rect.y + field.rect.height).toBeLessThanOrEqual(SAMPLE_WIDE_HEIGHT);
    }

    expect(sampleFormImage(0).buffer).not.toBe(sampleFormImage(1).buffer);
  });

  it('leaves some wide-sample findings unplaceable on purpose', async () => {
    const { SAMPLE_FIELD_ISSUES, SAMPLE_WIDE_FIELDS } = await import(
      '../../server/lib/visuals/sampleFormVisual.js'
    );

    const wideNames = new Set(SAMPLE_WIDE_FIELDS.map((field) => field.name));
    const unplaceable = SAMPLE_FIELD_ISSUES.filter((issue) => !wideNames.has(issue.field));

    // The wide sample carries fewer controls than the findings name, so the
    // "not on image" path is exercised in Dev Mode rather than only on real
    // scans where a capture happens to miss a control.
    expect(unplaceable.length).toBeGreaterThan(0);
  });

  it('ships whole-form findings that name no control', async () => {
    const { SAMPLE_FIELD_ISSUES, SAMPLE_FORM_FINDINGS } = await import(
      '../../server/lib/visuals/sampleFormVisual.js'
    );

    expect(SAMPLE_FORM_FINDINGS.length).toBeGreaterThan(0);

    for (const finding of SAMPLE_FORM_FINDINGS) {
      // A whole-form finding with a field would draw a box, which is exactly
      // what this bucket exists to avoid.
      expect(finding).not.toHaveProperty('field');
      expect(finding.issue.trim()).not.toBe('');
      expect(SEVERITIES).toContain(finding.severity);
      // Keeping it out of the per-field list is what makes Dev Mode
      // representative: the two buckets must not overlap.
      expect(SAMPLE_FIELD_ISSUES.some((issue) => issue.issue === finding.issue)).toBe(false);
    }
  });
});

describe('resolveFormBox', () => {
  const PAGE = { width: 1280, height: 4000 };
  const MIN = 8;

  const box = (x, y, width, height) => ({ x, y, width, height });

  it('keeps the form\'s own box when it is usable', async () => {
    const { resolveFormBox } = await import('../../server/lib/visuals/captureFormVisuals.js');

    const result = resolveFormBox(
      {
        ownRect: box(100, 200, 500, 400),
        // Deliberately larger: a real measurement must not be overridden.
        childBoxes: [box(0, 0, 1200, 3000)]
      },
      PAGE,
      MIN
    );

    expect(result.measuredFrom).toBe('form');
    expect(result.rect).toEqual(box(100, 200, 500, 400));
  });

  it('falls back to the children when the form has no box of its own', async () => {
    const { resolveFormBox } = await import('../../server/lib/visuals/captureFormVisuals.js');

    // display: contents gives a 0x0 rect however long the page settles for.
    const result = resolveFormBox(
      {
        ownRect: box(0, 0, 0, 0),
        childBoxes: [box(100, 200, 300, 50), box(100, 260, 428, 313)],
        controlBoxes: [box(150, 210, 200, 30)]
      },
      PAGE,
      MIN
    );

    expect(result.measuredFrom).toBe('children');
    expect(result.rect).toEqual(box(100, 200, 428, 373));
  });

  it('prefers children over controls, so labels are not cropped away', async () => {
    const { resolveFormBox } = await import('../../server/lib/visuals/captureFormVisuals.js');

    // The child wrapper starts at x=100 (the label); the input alone starts at
    // x=250. Cropping to the input would cut the text that explains it.
    const result = resolveFormBox(
      {
        ownRect: box(0, 0, 0, 0),
        childBoxes: [box(100, 200, 400, 40)],
        controlBoxes: [box(250, 205, 200, 30)]
      },
      PAGE,
      MIN
    );

    expect(result.rect.x).toBe(100);
    expect(result.measuredFrom).toBe('children');
  });

  it('uses the controls when there are no measurable children', async () => {
    const { resolveFormBox } = await import('../../server/lib/visuals/captureFormVisuals.js');

    const result = resolveFormBox(
      {
        ownRect: box(0, 0, 0, 0),
        childBoxes: [],
        controlBoxes: [box(40, 60, 100, 20), box(40, 100, 160, 20)]
      },
      PAGE,
      MIN
    );

    expect(result.measuredFrom).toBe('fields');
    expect(result.rect).toEqual(box(40, 60, 160, 60));
  });

  it('reports the form box when there is nothing to infer from', async () => {
    const { resolveFormBox } = await import('../../server/lib/visuals/captureFormVisuals.js');

    // Genuinely empty and hidden: the caller must still mark it unavailable
    // rather than invent a crop.
    const result = resolveFormBox(
      { ownRect: box(10, 10, 0, 0), childBoxes: [], controlBoxes: [] },
      PAGE,
      MIN
    );

    expect(result.measuredFrom).toBe('form');
    expect(result.rect).toEqual(box(10, 10, 0, 0));
  });

  it('ignores zero-size children when taking the union', async () => {
    const { resolveFormBox } = await import('../../server/lib/visuals/captureFormVisuals.js');

    const result = resolveFormBox(
      {
        ownRect: box(0, 0, 0, 0),
        childBoxes: [box(0, 0, 0, 0), box(200, 300, 100, 100), null]
      },
      PAGE,
      MIN
    );

    // A collapsed child at the origin would otherwise drag the crop to 0,0.
    expect(result.rect).toEqual(box(200, 300, 100, 100));
  });

  it('clamps an inferred box to the page, since a clip outside it fails', async () => {
    const { resolveFormBox } = await import('../../server/lib/visuals/captureFormVisuals.js');

    const result = resolveFormBox(
      { ownRect: box(0, 0, 0, 0), childBoxes: [box(-50, 100, 2000, 500)] },
      PAGE,
      MIN
    );

    expect(result.rect.x).toBe(0);
    expect(result.rect.width).toBe(PAGE.width);
  });
});

describe('toFormGeometry', () => {
  const PAGE = { width: 1280, height: 4000 };

  it('rebases control coordinates onto the inferred crop', async () => {
    const { toFormGeometry } = await import('../../server/lib/visuals/captureFormVisuals.js');

    const result = toFormGeometry(
      {
        formIndex: 0,
        signature: { id: '', name: '', action: '', fieldCount: 1 },
        ownRect: { x: 0, y: 0, width: 0, height: 0 },
        childBoxes: [{ x: 100, y: 200, width: 400, height: 300 }],
        controls: [
          { name: 'email', id: '', type: 'email', tagName: 'input', value: '', box: { x: 150, y: 250, width: 200, height: 30 } }
        ]
      },
      PAGE,
      8
    );

    expect(result.visible).toBe(true);
    expect(result.measuredFrom).toBe('children');
    // The overlay scales these against the crop, so they must be relative to
    // the inferred origin, not the page.
    expect(result.fields[0].rect).toEqual({ x: 50, y: 50, width: 200, height: 30 });
  });

  it('marks a form unmeasurable rather than inventing a crop', async () => {
    const { toFormGeometry } = await import('../../server/lib/visuals/captureFormVisuals.js');

    const result = toFormGeometry(
      {
        formIndex: 0,
        signature: { id: '', name: '', action: '', fieldCount: 0 },
        ownRect: { x: 0, y: 0, width: 0, height: 0 },
        childBoxes: [],
        controls: []
      },
      PAGE,
      8
    );

    expect(result.visible).toBe(false);
    expect(result.fields).toEqual([]);
  });

  it('passes an already-resolved entry through untouched', async () => {
    const { toFormGeometry } = await import('../../server/lib/visuals/captureFormVisuals.js');

    const resolved = {
      formIndex: 2,
      rect: { x: 1, y: 2, width: 300, height: 400 },
      fields: [{ name: 'a', rect: { x: 0, y: 0, width: 10, height: 10 }, renderable: true }],
      visible: true
    };

    expect(toFormGeometry(resolved, PAGE, 8)).toMatchObject(resolved);
  });
});

describe('cropPng', () => {
  it('cuts the requested rectangle out of the source', () => {
    const result = cropPng(stripedPng(200, 150), { x: 10, y: 20, width: 50, height: 40 });

    expect(result.width).toBe(50);
    expect(result.height).toBe(40);
    expect(readPngSize(result.buffer)).toEqual({ width: 50, height: 40 });
  });

  it('takes the pixels from the right offset, not the origin', () => {
    // The striped source encodes its row in red and column in green, so a
    // crop that silently started at 0,0 would be caught here.
    const result = cropPng(stripedPng(200, 150), { x: 30, y: 40, width: 10, height: 10 });

    expect(pixelAt(result.buffer, 0, 0)).toEqual([40, 30, 0]);
    expect(pixelAt(result.buffer, 5, 5)).toEqual([45, 35, 0]);
  });

  it('clamps a rectangle that overhangs the source', () => {
    // A form at the very bottom of a page is normal, not an error.
    const result = cropPng(stripedPng(100, 100), { x: 80, y: 90, width: 50, height: 50 });

    expect(result.width).toBe(20);
    expect(result.height).toBe(10);
  });

  it('rounds fractional coordinates rather than producing a broken image', () => {
    const result = cropPng(stripedPng(100, 100), { x: 10.4, y: 20.6, width: 30.5, height: 10.2 });

    expect(readPngSize(result.buffer)).toEqual({ width: 31, height: 10 });
  });

  it('throws when the rectangle lies entirely outside the source', () => {
    expect(() => cropPng(stripedPng(50, 50), { x: 60, y: 60, width: 10, height: 10 })).toThrow(
      /outside a 50x50 capture/
    );
  });
});


describe('expandViewportToPage', () => {
  const silentLog = { log: () => {}, warn: () => {} };

  /** A page that records viewport changes and reports a fixed page height. */
  const resizablePage = ({ viewport, pageHeight }) => {
    let current = viewport;

    return {
      calls: [],
      viewport: () => current,
      setViewport: vi.fn(async (next) => {
        current = next;
      }),
      evaluate: vi.fn(async () => pageHeight)
    };
  };

  it('grows the viewport to cover a page taller than it', async () => {
    const { expandViewportToPage } = await import(
      '../../server/lib/visuals/captureFormVisuals.js'
    );
    const page = resizablePage({ viewport: { width: 1280, height: 720 }, pageHeight: 4393 });

    await expandViewportToPage(page, {
      limits: { maxCaptureHeight: 8000, reflowSettleMs: 0 },
      logger: silentLog
    });

    // The viewport has to BE the page: Chrome only paints an unclipped
    // screenshot correctly, and many pages will not scroll on request.
    expect(page.setViewport).toHaveBeenCalledWith({ width: 1280, height: 4393 });
  });

  it('caps the growth so one enormous page cannot exhaust memory', async () => {
    const { expandViewportToPage } = await import(
      '../../server/lib/visuals/captureFormVisuals.js'
    );
    const page = resizablePage({ viewport: { width: 1280, height: 720 }, pageHeight: 50000 });

    await expandViewportToPage(page, {
      limits: { maxCaptureHeight: 8000, reflowSettleMs: 0 },
      logger: silentLog
    });

    expect(page.setViewport).toHaveBeenCalledWith({ width: 1280, height: 8000 });
  });

  it('leaves a page that already fits alone', async () => {
    const { expandViewportToPage } = await import(
      '../../server/lib/visuals/captureFormVisuals.js'
    );
    const page = resizablePage({ viewport: { width: 1280, height: 720 }, pageHeight: 500 });

    await expandViewportToPage(page, {
      limits: { maxCaptureHeight: 8000, reflowSettleMs: 0 },
      logger: silentLog
    });

    expect(page.setViewport).not.toHaveBeenCalled();
  });

  it('restores the original viewport when asked', async () => {
    const { expandViewportToPage } = await import(
      '../../server/lib/visuals/captureFormVisuals.js'
    );
    const page = resizablePage({ viewport: { width: 1280, height: 720 }, pageHeight: 3000 });

    const restore = await expandViewportToPage(page, {
      limits: { maxCaptureHeight: 8000, reflowSettleMs: 0 },
      logger: silentLog
    });
    await restore();

    expect(page.setViewport).toHaveBeenLastCalledWith({ width: 1280, height: 720 });
  });

  it('survives a restore on a page that is already gone', async () => {
    const { expandViewportToPage } = await import(
      '../../server/lib/visuals/captureFormVisuals.js'
    );
    const page = resizablePage({ viewport: { width: 1280, height: 720 }, pageHeight: 3000 });
    const restore = await expandViewportToPage(page, {
      limits: { maxCaptureHeight: 8000, reflowSettleMs: 0 },
      logger: silentLog
    });

    page.setViewport.mockRejectedValueOnce(new Error('Target closed'));

    // Restoring is tidiness, not a requirement: it must not fail the scan.
    await expect(restore()).resolves.toBeUndefined();
  });

  it('does nothing on a page that cannot report a viewport', async () => {
    const { expandViewportToPage } = await import(
      '../../server/lib/visuals/captureFormVisuals.js'
    );
    const page = { evaluate: vi.fn(), setViewport: vi.fn() };

    const restore = await expandViewportToPage(page, { logger: silentLog });
    await restore();

    expect(page.setViewport).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
