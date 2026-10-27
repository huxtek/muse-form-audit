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

  /** A page stub returning fixed geometry and a fake PNG. */
  const fakePage = ({ geometry, screenshot }) => ({
    evaluate: vi.fn().mockResolvedValue(geometry),
    screenshot: vi.fn(screenshot ?? (async () => Buffer.from('png-bytes')))
  });

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

  it('clips from the padded origin and captures the padded size', async () => {
    const page = fakePage({
      geometry: geometryFor({ x: 200, y: 300, width: 400, height: 200 }, [])
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        clip: { x: 184, y: 284, width: 432, height: 232 }
      })
    );
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
    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ clip: { x: 0, y: 0, width: 1280, height: 616 } })
    );
  });

  it('flags truncation and clamps the capture for an oversized form', async () => {
    const page = fakePage({
      geometry: geometryFor({ x: 0, y: 0, width: 500, height: 9000 }, [])
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    expect(visual.height).toBe(LIMITS.maxFormHeight);
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
      geometry: geometryFor({ x: 0, y: 0, width: 100, height: 100 }, []),
      screenshot: async () => Buffer.alloc(1234)
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    expect(visual.byteLength).toBe(1234);
    expect(visual.contentType).toBe('image/png');
    expect(Buffer.isBuffer(visual.screenshot)).toBe(true);
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
        throw new Error('clip outside document');
      }
    });

    const [visual] = await captureFormVisuals(page, { limits: LIMITS, logger: silent });

    // A failed capture must not lose the findings-to-control mapping.
    expect(visual.screenshot).toBeNull();
    expect(visual.unavailableReason).toBe('clip outside document');
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
    expect(page.screenshot).toHaveBeenCalledTimes(3);
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
});
