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
