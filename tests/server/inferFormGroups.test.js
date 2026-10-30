// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  INFERENCE_LIMITS,
  INFERRED_FORM_ATTRIBUTE,
  inferFormGroups
} from '../../server/lib/visuals/inferFormGroups.js';

/**
 * Grouping fields the page never put in a `<form>`.
 *
 * Measured need: instagram.com/accounts/emailsignup/ renders a signup with
 * three visible fields and no form element anywhere, so the extractor's
 * `$('form')` query reported zero forms for a signup page.
 *
 * Driven against jsdom rather than a real browser so it runs in CI, with the
 * page's `evaluate` stood in for. jsdom reports every element as zero-sized,
 * so `getBoundingClientRect` is stubbed -- otherwise the visibility filter
 * would reject every field and the tests would pass for the wrong reason.
 */
const SIZED = { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0 };

const sizeEverything = () => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return this.getAttribute('data-invisible') === '1'
      ? { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 }
      : SIZED;
  };
};

/** A stand-in for puppeteer's page, running the function against jsdom. */
const fakePage = () => ({
  evaluate: async (fn, ...args) => fn(...args)
});

const run = (html, limits = INFERENCE_LIMITS) => {
  document.body.innerHTML = html;

  return inferFormGroups(fakePage(), { limits, logger: { log: () => {}, warn: () => {} } });
};

const formCount = () => document.querySelectorAll('form').length;
const inferredForms = () => [...document.querySelectorAll(`form[${INFERRED_FORM_ATTRIBUTE}]`)];
const fieldsPerForm = () =>
  [...document.querySelectorAll('form')].map(
    (f) => f.querySelectorAll('input, textarea, select').length
  );

beforeEach(() => {
  sizeEverything();
});

describe('pages that already declare their forms', () => {
  it('leaves a real form completely alone', async () => {
    const result = await run(`
      <form action="/post" method="post">
        <label>Name <input name="custname"></label>
        <label>Email <input type="email" name="custemail"></label>
      </form>
    `);

    expect(result.groups).toHaveLength(0);
    expect(formCount()).toBe(1);
    expect(inferredForms()).toHaveLength(0);
  });

  it('never nests a form inside a form', async () => {
    // Invalid HTML, and it would confuse the extractor into double-counting.
    await run(`
      <form>
        <div><input name="inside"></div>
      </form>
    `);

    expect(document.querySelectorAll('form form')).toHaveLength(0);
  });
});

describe('fields with no form around them', () => {
  it('groups fields that share a container', async () => {
    const result = await run(`
      <div id="signup">
        <label>Name <input name="fullName"></label>
        <label>Email <input name="email"></label>
        <label>Password <input type="password" name="password"></label>
      </div>
    `);

    expect(result.orphansFound).toBe(3);
    expect(inferredForms()).toHaveLength(1);
    expect(fieldsPerForm()).toEqual([3]);
  });

  it('separates two unrelated groups rather than merging them', async () => {
    // The shape of a real signup page: a form's fields in one subtree and a
    // site search in the header. One form of four would be nonsense.
    const result = await run(`
      <header><div><input type="search" name="q"></div></header>
      <main>
        <div class="card">
          <input name="email">
          <input type="password" name="password">
        </div>
      </main>
    `);

    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    expect(fieldsPerForm().sort()).toEqual([1, 2]);
  });

  it('finds a group even when the shared container is far above the fields', async () => {
    // The bug this module shipped with: a depth cap of 8 meant Instagram's
    // deeply nested signup produced five single-field forms instead of one
    // group, because the fields sit further below their container than that.
    const deep = (depth, content) =>
      Array.from({ length: depth }, () => '<div>').join('') +
      content +
      Array.from({ length: depth }, () => '</div>').join('');

    await run(`
      <div id="root">
        ${deep(12, '<input name="first">')}
        ${deep(12, '<input name="second">')}
      </div>
    `);

    expect(inferredForms()).toHaveLength(1);
    expect(fieldsPerForm()).toEqual([2]);
  });

  it('keeps a lone field as a form of its own', async () => {
    // A single search box is still something an agent is asked to fill in.
    await run('<div><input type="search" name="q"></div>');

    expect(inferredForms()).toHaveLength(1);
    expect(fieldsPerForm()).toEqual([1]);
  });

  it('ignores hidden and zero-sized fields', async () => {
    const result = await run(`
      <div>
        <input type="hidden" name="csrf">
        <input name="decorative" data-invisible="1">
      </div>
    `);

    expect(result.orphansFound).toBe(0);
    expect(formCount()).toBe(0);
  });

  it('ignores fields already inside a declared form', async () => {
    const result = await run(`
      <form><input name="inside"></form>
      <div><input name="outside"></div>
    `);

    expect(result.orphansFound).toBe(1);
    expect(inferredForms()).toHaveLength(1);
    expect(formCount()).toBe(2);
  });
});

describe('guards against pathological pages', () => {
  it('refuses a container too broad to be one form', async () => {
    // Page furniture holding many unrelated inputs is not a form, and
    // wrapping it would produce one meaningless 30-field report.
    const inputs = Array.from({ length: 12 }, (_, i) => `<input name="f${i}">`).join('');

    await run(`<div id="everything">${inputs}</div>`, {
      ...INFERENCE_LIMITS,
      maxFieldsPerGroup: 5
    });

    // Rejected as a group, so each field falls back to being its own.
    expect(fieldsPerForm().every((n) => n <= 5)).toBe(true);
  });

  it('stops at the group limit', async () => {
    const scattered = Array.from(
      { length: 10 },
      (_, i) => `<section><div><input name="s${i}"></div></section>`
    ).join('');

    await run(scattered, { ...INFERENCE_LIMITS, maxGroups: 3 });

    expect(inferredForms().length).toBeLessThanOrEqual(3);
  });

  it('does nothing at all on a page with no fields', async () => {
    const result = await run('<main><p>Just prose about forms.</p></main>');

    expect(result.orphansFound).toBe(0);
    expect(result.groups).toHaveLength(0);
    expect(formCount()).toBe(0);
  });
});

describe('failing safely', () => {
  it('returns an empty result when the page cannot be evaluated', async () => {
    // A scan must never fail because inference failed.
    const broken = {
      evaluate: async () => {
        throw new Error('Execution context was destroyed');
      }
    };

    const result = await inferFormGroups(broken, {
      logger: { log: () => {}, warn: () => {} }
    });

    expect(result).toEqual({ groups: [], orphansFound: 0 });
  });
});

/**
 * Never create a nested form.
 *
 * Measured on en.wikipedia.org/wiki/Form_(HTML): the appearance panel holds
 * radio groups that already sit inside a form, plus a few fields that do
 * not. The nearest ancestor shared by those loose fields contained that
 * form, so wrapping it put a form inside a form.
 *
 * Nested forms are illegal HTML, so the parser collapses one. The live DOM
 * reported 7 forms where `cheerio` parsed 6 from the same markup, the
 * geometry pairing broke by index, and three forms lost their overlays --
 * including `vector-sticky-search-form`, a hidden form of exactly the kind
 * the report now labels.
 *
 * Walking further up cannot help: every ancestor above also contains the
 * form. The candidate has to be rejected and the fields grouped tightly.
 */
const nestedForms = () => document.querySelectorAll('form form').length;

describe('containers that already hold a form', () => {
  it('does not wrap a container holding a form', async () => {
    await run(`
      <div id="panel">
        <form id="declared">
          <input type="radio" name="theme" value="light">
          <input type="radio" name="theme" value="dark">
        </form>
        <input name="loose-a">
        <input name="loose-b">
      </div>
    `);

    expect(nestedForms()).toBe(0);
    expect(document.getElementById('declared').closest('form').id).toBe('declared');
  });

  it('still reports the loose fields rather than dropping them', async () => {
    // Rejecting the container must not lose the fields it held: they are
    // what inference exists to find.
    await run(`
      <div id="panel">
        <form id="declared"><input name="inside"></form>
        <input name="loose-a">
        <input name="loose-b">
      </div>
    `);

    const grouped = inferredForms().flatMap((form) => [
      ...form.querySelectorAll('input')
    ].map((i) => i.getAttribute('name')));

    expect(grouped).toContain('loose-a');
    expect(grouped).toContain('loose-b');
  });

  it('leaves the DOM form count equal to what a parser would read', async () => {
    /*
     * The property that actually broke. The geometry pass counts forms in
     * the live DOM and the extractor counts them in the serialised HTML; a
     * nested form makes those two numbers differ, and everything downstream
     * pairs them by index.
     */
    await run(`
      <div id="panel">
        <form id="declared"><input name="inside"></form>
        <input name="loose-a">
        <input name="loose-b">
      </div>
    `);

    const liveCount = document.querySelectorAll('form').length;
    const reparsed = new DOMParser()
      .parseFromString(`<body>${document.body.innerHTML}</body>`, 'text/html')
      .querySelectorAll('form').length;

    expect(liveCount).toBe(reparsed);
  });

  it('wraps a container that holds no form, as before', async () => {
    // The Instagram shape must keep working: loose fields sharing a
    // container with no form in it are still one group.
    const result = await run(`
      <div id="signup">
        <input name="fullname">
        <input name="username">
        <input type="password" name="pass">
      </div>
    `);

    expect(result.groups).toHaveLength(1);
    expect(nestedForms()).toBe(0);
    expect(fieldsPerForm()).toEqual([3]);
  });

  it('does not use a solitary field parent that holds a form', async () => {
    // The fallback path has the same trap: a parent with one field can still
    // contain an empty form.
    await run(`
      <div id="outer">
        <div id="holder">
          <form id="empty"></form>
          <input name="only">
        </div>
        <input name="other">
      </div>
    `);

    expect(nestedForms()).toBe(0);
  });
});

describe('a field chosen on its own', () => {
  it('is wrapped rather than counted as empty and dropped', async () => {
    /*
     * The field count was taken from descendants, and a field has none, so a
     * root that was the field itself scored zero and hit the "nothing here"
     * guard. The field was found, chosen, and then silently discarded.
     *
     * Reached whenever a field's only shared ancestor is rejected, which the
     * form-nesting guard now does routinely.
     */
    await run(`
      <div id="panel">
        <form id="declared"><input name="inside"></form>
        <input name="alone">
        <input name="also-alone">
      </div>
    `);

    const wrapped = inferredForms().map((form) =>
      [...form.querySelectorAll('input')].map((i) => i.getAttribute('name')).join(',')
    );

    expect(wrapped).toEqual(['alone', 'also-alone']);
  });

  it('counts the field itself against the group limit', async () => {
    // A limit of zero should reject it, which only works if it counts as one.
    const result = await run(
      `<div id="panel"><form id="d"><input name="in"></form><input name="a"><input name="b"></div>`,
      { ...INFERENCE_LIMITS, maxFieldsPerGroup: 0 }
    );

    expect(result.groups).toHaveLength(0);
  });
});
