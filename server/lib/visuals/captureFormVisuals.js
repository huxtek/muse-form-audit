/**
 * Captures a per-form screenshot plus field geometry from the live page.
 *
 * Form extraction elsewhere runs on the serialized HTML through cheerio, which
 * has no layout engine and therefore no coordinates. The overlay needs real
 * pixels, so this runs while the puppeteer page is still open and pairs each
 * form with a cropped PNG and the bounding box of every control inside it.
 *
 * Coordinates are returned RELATIVE TO THE FORM CROP, so the client can scale
 * them by a single factor (rendered width / captured width) without knowing
 * anything about page scroll or viewport.
 *
 * Index alignment: both this and the cheerio extractor enumerate `form`
 * elements in document order from the same DOM, so `formIndex` lines up. A
 * `signature` is included so the consumer can sanity-check the pairing rather
 * than trusting the index blindly.
 */

import { cropPng } from './cropImage.js';

/** Controls worth outlining. */
const FIELD_SELECTOR = 'input, select, textarea, button';

/** Caps so one pathological page cannot exhaust memory. */
export const VISUAL_LIMITS = {
  maxForms: Number(process.env.VISUAL_MAX_FORMS || 15),
  maxFormHeight: Number(process.env.VISUAL_MAX_FORM_HEIGHT || 4000),
  maxFormWidth: Number(process.env.VISUAL_MAX_FORM_WIDTH || 2000),
  minFormSize: 8,
  /**
   * Breathing room captured around the form. A form's bounding box starts at
   * its first label, so without this the content sits flush against the frame
   * and a rounded corner clips it.
   */
  padding: Number(process.env.VISUAL_CAPTURE_PADDING || 16),
  /**
   * The whole-page map is a navigation aid, not evidence, so it is JPEG --
   * roughly a tenth the size of the equivalent PNG. Form crops stay lossless.
   */
  pageMapQuality: Number(process.env.VISUAL_PAGE_MAP_QUALITY || 70),
  maxPageMapHeight: Number(process.env.VISUAL_MAX_PAGE_MAP_HEIGHT || 8000),
  /**
   * How tall the viewport may grow to bring a whole page into one frame.
   * Every pixel costs memory in the capture, so a very long page is
   * photographed from the top down and marked truncated.
   */
  maxCaptureHeight: Number(process.env.VISUAL_MAX_CAPTURE_HEIGHT || 8000),
  /** Time for a responsive page to settle after the viewport grows. */
  reflowSettleMs: Number(process.env.VISUAL_REFLOW_SETTLE_MS || 600)
};

/**
 * Decides which box to crop for one form, and rebases its controls onto it.
 *
 * Split out of the browser callback so it can be tested: jsdom has no layout
 * engine, so exercising this through a real DOM is not an option. The browser
 * side only reads raw boxes; every judgement happens here.
 *
 * A form styled `display: contents` generates no box of its own, so its rect
 * is 0x0 however long we wait for the page to settle. Its children still lay
 * out normally, so their extent is the crop a reader actually wants. Direct
 * children are preferred over the controls alone because they carry the
 * labels and legends too; cropping to the inputs would cut the text that
 * explains them.
 *
 * This only ever replaces a measurement too small to use, so a form that
 * really is tiny is still reported as the page described it.
 */
export function resolveFormBox({ ownRect, childBoxes = [], controlBoxes = [] }, pageSize, minSize) {
  const union = (boxes) => {
    const usable = boxes.filter((b) => b && b.width >= 1 && b.height >= 1);

    if (!usable.length) {
      return null;
    }

    const x = Math.min(...usable.map((b) => b.x));
    const y = Math.min(...usable.map((b) => b.y));

    return {
      x,
      y,
      width: Math.max(...usable.map((b) => b.x + b.width)) - x,
      height: Math.max(...usable.map((b) => b.y + b.height)) - y
    };
  };

  const degenerate = !ownRect || ownRect.width < minSize || ownRect.height < minSize;
  const fromChildren = degenerate ? union(childBoxes) : null;
  const fromFields = degenerate && !fromChildren ? union(controlBoxes) : null;
  const inferred = fromChildren ?? fromFields;

  if (!inferred) {
    return { rect: ownRect, measuredFrom: 'form' };
  }

  // An inferred box can overhang the document when something inside overflows,
  // and a clip outside the page fails.
  const x = Math.max(0, inferred.x);
  const y = Math.max(0, inferred.y);
  const limitWidth = pageSize?.width ? Math.max(0, pageSize.width - x) : inferred.width;
  const limitHeight = pageSize?.height ? Math.max(0, pageSize.height - y) : inferred.height;

  return {
    rect: {
      x,
      y,
      width: Math.min(inferred.width, limitWidth),
      height: Math.min(inferred.height, limitHeight)
    },
    measuredFrom: fromChildren ? 'children' : 'fields'
  };
}

/** Turns one raw form measurement into the shape the capture step consumes. */
export function toFormGeometry(raw, pageSize, minSize) {
  // Already resolved, by an older page script or a caller passing geometry
  // straight in. Converting it again would discard the rect it arrived with.
  if (!raw?.ownRect && raw?.rect) {
    return { measuredFrom: 'form', ...raw };
  }

  const { rect, measuredFrom } = resolveFormBox(raw ?? {}, pageSize, minSize);
  const box = rect ?? { x: 0, y: 0, width: 0, height: 0 };

  return {
    formIndex: raw.formIndex,
    signature: raw.signature,
    visible: box.width >= minSize && box.height >= minSize,
    /** 'form', or which descendants stood in for an unusable form box. */
    measuredFrom,
    rect: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height)
    },
    fields: (raw.controls ?? []).map((control) => ({
      name: control.name ?? '',
      id: control.id ?? '',
      type: control.type ?? '',
      tagName: control.tagName ?? '',
      value: control.value ?? '',
      // Relative to the form crop.
      rect: {
        x: Math.round(control.box.x - box.x),
        y: Math.round(control.box.y - box.y),
        width: Math.round(control.box.width),
        height: Math.round(control.box.height)
      },
      // Only controls we can actually point at are collected.
      renderable: true
    }))
  };
}

/**
 * Reads form and field geometry from the page. Pure DOM work, no screenshots.
 * Exported for testing against a fake page object.
 */
export async function readFormGeometry(page, limits = VISUAL_LIMITS) {
  const result = await page.evaluate(
    (fieldSelector, maxForms, minSize) => {
      const forms = Array.from(document.querySelectorAll('form')).slice(0, maxForms);

      // Page extent, so padding around a form can be clamped to what actually
      // exists rather than asking for a clip outside the document.
      const pageSize = {
        width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
        height: Math.max(document.documentElement.scrollHeight, window.innerHeight)
      };

      // Page-absolute box for an element, or null when it generates none.
      // getBoundingClientRect is viewport-relative, hence the scroll offset.
      const boxOf = (el) => {
        const rect = el.getBoundingClientRect();

        return rect.width >= 1 && rect.height >= 1
          ? {
              x: rect.left + window.scrollX,
              y: rect.top + window.scrollY,
              width: rect.width,
              height: rect.height
            }
          : null;
      };

      // Raw boxes only. Every judgement about which box to crop happens in
      // node, where it can be tested without a layout engine.
      const measured = forms.map((form, formIndex) => {
        const formRect = form.getBoundingClientRect();

        return {
          formIndex,
          signature: {
            id: form.getAttribute('id') || '',
            name: form.getAttribute('name') || '',
            action: form.getAttribute('action') || '',
            fieldCount: form.querySelectorAll(fieldSelector).length
          },
          ownRect: {
            x: formRect.left + window.scrollX,
            y: formRect.top + window.scrollY,
            width: formRect.width,
            height: formRect.height
          },
          childBoxes: Array.from(form.children).map(boxOf).filter(Boolean),
          controls: Array.from(form.querySelectorAll(fieldSelector))
            .map((el) => ({
              name: el.getAttribute('name') || '',
              id: el.getAttribute('id') || '',
              type: (el.getAttribute('type') || el.tagName).toLowerCase(),
              tagName: el.tagName.toLowerCase(),
              value: el.getAttribute('value') || '',
              box: boxOf(el)
            }))
            // Keep only controls we can actually point at.
            .filter((control) => control.box)
        };
      });

      return { pageSize, forms: measured };
    },
    FIELD_SELECTOR,
    limits.maxForms,
    limits.minFormSize
  );

  // Tolerate an older/odd return shape rather than throwing on a page quirk.
  const isBare = Array.isArray(result);
  const rawForms = isBare ? result : Array.isArray(result?.forms) ? result.forms : [];
  const pageSize = (isBare ? null : result?.pageSize) ?? { width: 0, height: 0 };

  return {
    pageSize,
    forms: rawForms.map((raw) => toFormGeometry(raw, pageSize, limits.minFormSize))
  };
}

/**
 * Padding actually available on each side of a form, given where it sits in
 * the page. Asking for 16px on the left of a form at x=4 would produce a
 * negative clip, so each side is clamped independently and the applied values
 * are returned -- field coordinates must shift by exactly what was applied.
 */
export function resolvePadding(formRect, pageSize, requested) {
  const padLeft = Math.min(requested, Math.max(0, formRect.x));
  const padTop = Math.min(requested, Math.max(0, formRect.y));

  const rightRoom = pageSize?.width ? pageSize.width - (formRect.x + formRect.width) : requested;
  const bottomRoom = pageSize?.height ? pageSize.height - (formRect.y + formRect.height) : requested;

  return {
    padLeft,
    padTop,
    padRight: Math.min(requested, Math.max(0, rightRoom)),
    padBottom: Math.min(requested, Math.max(0, bottomRoom))
  };
}

/**
 * Grows the viewport until it covers the whole page, and returns a function
 * that puts it back.
 *
 * Everything else here depends on this. Chrome will not give us a correct
 * partial screenshot: asking for a `clip`, or for `fullPage`, routes the
 * capture through a path that drops separately composited layers, so a form
 * sitting on a panel over a coloured hero comes back as a flat wash with
 * ghost text on it. Only a plain, unclipped viewport screenshot paints
 * correctly.
 *
 * That leaves the problem of content below the fold. Scrolling to it is not
 * dependable -- plenty of pages do not scroll the document at all, and on
 * those `window.scrollTo` is silently a no-op, so the lower part of a tall
 * form is simply unreachable. Making the viewport as tall as the page needs
 * no scrolling and keeps every form in one frame.
 *
 * Geometry MUST be read after this call: a vertical resize reflows a
 * responsive page, and coordinates measured at the old height would describe
 * somewhere the form no longer is.
 */
export async function expandViewportToPage(page, { limits = VISUAL_LIMITS, logger = console } = {}) {
  const original = page.viewport?.() ?? null;

  if (!original) {
    return async () => {};
  }

  const pageHeight = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, window.innerHeight)
  );

  const target = Math.min(pageHeight, limits.maxCaptureHeight);

  if (target <= original.height) {
    return async () => {};
  }

  await page.setViewport({ ...original, height: target });
  // Let the reflow settle before anything measures or photographs it.
  await new Promise((resolve) => setTimeout(resolve, limits.reflowSettleMs));

  if (pageHeight > target) {
    logger.log?.(
      `   📐 [VISUALS] Page is ${pageHeight}px; capturing the top ${target}px`
    );
  }

  return async () => {
    try {
      await page.setViewport(original);
    } catch {
      // The page may already be closing; restoring is a courtesy, not a need.
    }
  };
}

/**
 * Captures geometry plus a cropped PNG per form.
 *
 * Returns one entry per form, always: a form that could not be photographed
 * still reports its fields and an explicit reason, so the client can show the
 * text findings rather than an empty frame.
 */
export async function captureFormVisuals(
  page,
  { limits = VISUAL_LIMITS, logger = console, geometry: preRead } = {}
) {
  let geometry = preRead;

  if (!geometry) {
    try {
      geometry = await readFormGeometry(page, limits);
    } catch (error) {
      logger.warn?.(`⚠️  [VISUALS] Geometry read failed: ${error.message}`);

      return [];
    }
  }

  const visuals = [];

  // One unclipped screenshot for the whole page, cut up per form below. This
  // is the only capture Chrome paints correctly, and taking it once is also
  // cheaper than one request per form.
  let pageImage = null;

  if (geometry.forms.some((form) => form.visible)) {
    try {
      pageImage = await page.screenshot({ type: 'png' });
    } catch (error) {
      logger.warn?.(`⚠️  [VISUALS] Page capture failed: ${error.message}`);
    }
  }

  for (const form of geometry.forms) {
    const base = {
      formIndex: form.formIndex,
      signature: form.signature,
      fields: form.fields,
      // 'children' or 'fields' means the form's own box was unusable and its
      // contents were measured instead, so a slightly tight crop is expected.
      ...(form.measuredFrom && form.measuredFrom !== 'form'
        ? { measuredFrom: form.measuredFrom }
        : {}),
      width: form.rect.width,
      height: form.rect.height,
      // Where the form sits on the page, in page coordinates. This is what
      // makes the form clickable on the whole-page map.
      pageRect: form.rect
    };

    if (!form.visible) {
      // Say which of the two it was. "No size" on a form that holds controls
      // means a layout quirk, not a hidden form, and the distinction is the
      // difference between a bug report and a shrug.
      const reason = form.fields?.length
        ? 'the form element has no box of its own and no measurable contents'
        : 'form is hidden or has no size';

      visuals.push({ ...base, screenshot: null, unavailableReason: reason });
      continue;
    }

    const { padLeft, padTop, padRight, padBottom } = resolvePadding(
      form.rect,
      geometry.pageSize,
      limits.padding
    );

    const desiredWidth = form.rect.width + padLeft + padRight;
    const desiredHeight = form.rect.height + padTop + padBottom;

    // Clamp the crop: a very tall form would otherwise produce a huge PNG.
    const width = Math.min(desiredWidth, limits.maxFormWidth);
    const height = Math.min(desiredHeight, limits.maxFormHeight);
    const truncated = width < desiredWidth || height < desiredHeight;

    if (!pageImage) {
      visuals.push({ ...base, screenshot: null, unavailableReason: 'the page could not be captured' });
      continue;
    }

    try {
      const capture = cropPng(pageImage, {
        x: Math.max(0, form.rect.x - padLeft),
        y: Math.max(0, form.rect.y - padTop),
        width,
        height
      });

      const buffer = capture.buffer;

      visuals.push({
        ...base,
        // Field rects were measured from the form's own origin; the capture now
        // starts `pad` earlier, so every box shifts by the applied padding.
        fields: form.fields.map((field) => ({
          ...field,
          rect: {
            ...field.rect,
            x: field.rect.x + padLeft,
            y: field.rect.y + padTop
          }
        })),
        padding: { left: padLeft, top: padTop, right: padRight, bottom: padBottom },
        // The capture is what the client scales against. Report what the
        // image actually is: a region at the page edge comes back short, and
        // highlights scaled against a size the image does not have land in
        // the wrong place.
        width: capture.width,
        height: capture.height,
        truncated: truncated || capture.width < width || capture.height < height,
        screenshot: Buffer.from(buffer),
        contentType: 'image/png',
        byteLength: buffer.length
      });
    } catch (error) {
      logger.warn?.(
        `⚠️  [VISUALS] Screenshot failed for form ${form.formIndex}: ${error.message}`
      );
      visuals.push({ ...base, screenshot: null, unavailableReason: error.message });
    }
  }

  const captured = visuals.filter((v) => v.screenshot).length;
  logger.log?.(
    `📸 [VISUALS] Captured ${captured}/${visuals.length} form screenshots` +
      (captured ? ` (${Math.round(visuals.reduce((n, v) => n + (v.byteLength || 0), 0) / 1024)} kB)` : '')
  );

  return visuals;
}

/**
 * Captures a whole-page screenshot to act as a map: the user sees the page
 * they scanned, with each analysed form outlined and clickable.
 *
 * JPEG rather than PNG because a full page can be several megabytes losslessly
 * and this image is only ever used for orientation. Height is capped so one
 * very long page cannot dominate the store.
 */
export async function capturePageMap(page, { limits = VISUAL_LIMITS, pageSize, logger = console } = {}) {
  const height = pageSize?.height ?? 0;
  const viewportHeight = page.viewport?.()?.height ?? height;
  // The map shows whatever the grown viewport could reach.
  const captured = Math.min(height || viewportHeight, viewportHeight);
  const capped = height > captured;

  try {
    // Unclipped, like the form crops, and for the same reason: a clipped or
    // fullPage capture loses separately composited layers and the map comes
    // back washed out. The viewport has been grown to cover the page, so a
    // plain screenshot already is the page -- and taller pages are cut off by
    // that cap rather than by a clip here.
    const buffer = await page.screenshot({
      type: 'jpeg',
      quality: limits.pageMapQuality
    });

    logger.log?.(
      `🗺  [VISUALS] Page map captured ${pageSize?.width ?? '?'}x${captured || '?'}` +
        ` (${Math.round(buffer.length / 1024)} kB jpeg)`
    );

    return {
      screenshot: Buffer.from(buffer),
      contentType: 'image/jpeg',
      byteLength: buffer.length,
      width: pageSize?.width ?? 0,
      height: captured,
      truncated: capped
    };
  } catch (error) {
    logger.warn?.(`⚠️  [VISUALS] Page map capture failed: ${error.message}`);

    return null;
  }
}

/**
 * Strips the image bytes off a visual, leaving the JSON-safe geometry that
 * ships inside the scan results. The bytes go to the screenshot store.
 */
export function toVisualMetadata(visual) {
  if (!visual) {
    return null;
  }

  const { screenshot, contentType, byteLength, ...rest } = visual;

  return { ...rest, hasScreenshot: Boolean(screenshot) };
}

/**
 * Pairs extracted forms with their captured visuals by document order, moving
 * the image bytes into the screenshot store as it goes.
 *
 * Index alignment is sound because both enumerate `form` elements in document
 * order from the same DOM. It is still verified, but by NAME OVERLAP rather
 * than field count: the two selectors legitimately differ (the extractor takes
 * `button[type="submit"]`, the capture takes every `button`, so an untyped
 * submit button counts once on one side only). A misplaced highlight is worse
 * than none, so geometry is dropped when the names look unrelated.
 */
/** Identifying tokens for a control, lowercased. */
const identifiers = (field) =>
  [field?.name, field?.id].filter((value) => typeof value === 'string' && value.trim()).map((v) => v.toLowerCase());

/**
 * True when the captured geometry plausibly belongs to the extracted form.
 *
 * Accepts when at least one identifier is shared. When neither side has any
 * identifier at all there is nothing to compare, so it accepts on document
 * order alone -- the overlay then simply has no names to attribute issues to.
 */
export function formsLookRelated(extractedForm, visual) {
  const extracted = new Set((extractedForm?.fields ?? []).flatMap(identifiers));
  const captured = new Set((visual?.fields ?? []).flatMap(identifiers));

  if (extracted.size === 0 || captured.size === 0) {
    return true;
  }

  for (const token of captured) {
    if (extracted.has(token)) {
      return true;
    }
  }

  return false;
}

export function attachVisualsToForms({
  forms = [],
  visuals = [],
  jobId,
  putScreenshot,
  // Screenshots are keyed per job, so a crawl spanning several pages offsets
  // local form indexes into a global sequence to keep keys unique.
  indexOffset = 0,
  // Whole-page map for the page these forms came from, stored once and
  // referenced by every form on it.
  pageMap = null,
  pageIndex = 0,
  putPageMap,
  logger = console
}) {
  if (pageMap?.screenshot && jobId && putPageMap) {
    putPageMap(jobId, pageIndex, {
      buffer: pageMap.screenshot,
      contentType: pageMap.contentType
    });
  }

  const pageMapRef = pageMap?.screenshot
    ? {
        pageIndex,
        width: pageMap.width,
        height: pageMap.height,
        truncated: Boolean(pageMap.truncated)
      }
    : null;

  return forms.map((form, index) => {
    const visual = visuals[index];
    const visualIndex = indexOffset + index;

    if (!visual) {
      return form;
    }

    if (!formsLookRelated(form, visual)) {
      logger.warn?.(
        `⚠️  [VISUALS] Form ${index} geometry does not match the extracted form - skipping overlay`
      );

      return form;
    }

    if (visual.screenshot && jobId && putScreenshot) {
      putScreenshot(jobId, visualIndex, {
        buffer: visual.screenshot,
        contentType: visual.contentType
      });
    }

    return {
      ...form,
      visual: {
        ...toVisualMetadata(visual),
        visualIndex,
        ...(pageMapRef ? { pageMap: pageMapRef } : {})
      }
    };
  });
}
