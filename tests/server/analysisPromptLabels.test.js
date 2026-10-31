import { describe, expect, it } from 'vitest';

import { buildAnalysisPrompt } from '../../server/lib/analysis/modelFormAnalyzer.js';

/**
 * A label can be real, associated, and still unusable.
 *
 * openai.com wraps its ChatGPT textarea in a `<label>` holding the whole
 * suggestion carousel: 60 child elements, 1,784 characters. The extractor
 * cuts that to 120 for display, which would hide the problem from the
 * analyser entirely -- so the prompt says it explicitly instead.
 *
 * The summariser that does the cutting was tested; the thing that carries it
 * to the model was not, which is the half that makes it a finding. The model
 * then wrote "the wrapping <label> contains dozens of rotating example
 * queries, producing a 1728-character accessible name that hides the real
 * 'Message ChatGPT' purpose" -- a finding that is impossible without this.
 */
const field = (overrides = {}) => ({
  name: '',
  id: 'prompt-textarea',
  type: 'textarea',
  ...overrides
});

const promptFor = (fields) =>
  buildAnalysisPrompt({
    formHtml: '<form><textarea></textarea></form>',
    formId: 'chat-form',
    url: 'https://openai.com/',
    fields
  });

describe('telling the analyser about a label too long to be a name', () => {
  it('says so, with the real length', async () => {
    const prompt = promptFor([field({ labelTruncated: true, labelLength: 1728 })]);

    expect(prompt).toMatch(/too long to serve as a name/i);
    expect(prompt).toContain('1728 characters long');
  });

  it('names the control it is about', async () => {
    const prompt = promptFor([
      field({ id: 'prompt-textarea', labelTruncated: true, labelLength: 1728 })
    ]);

    expect(prompt).toContain('prompt-textarea');
  });

  it('explains why the name is useless, not just that it is long', async () => {
    const prompt = promptFor([field({ labelTruncated: true, labelLength: 1728 })]);

    expect(prompt).toMatch(/wraps unrelated page content/i);
  });

  it('lists every affected control', async () => {
    const prompt = promptFor([
      field({ id: 'one', labelTruncated: true, labelLength: 900 }),
      field({ id: 'two', labelTruncated: true, labelLength: 1200 }),
      field({ id: 'three' })
    ]);

    expect(prompt).toContain('one: accessible name is 900 characters long');
    expect(prompt).toContain('two: accessible name is 1200 characters long');
    expect(prompt).not.toMatch(/three: accessible name/);
  });

  it('prefers the control name over its id, as the field list does', async () => {
    const prompt = promptFor([
      field({ name: 'message', id: 'prompt-textarea', labelTruncated: true, labelLength: 1728 })
    ]);

    expect(prompt).toContain('message: accessible name is 1728 characters long');
  });

  it('says nothing at all when every label is a sensible length', async () => {
    // The note must not appear on ordinary forms, where it would be noise
    // the model has to reason about.
    const prompt = promptFor([field({ name: 'email' }), field({ name: 'password' })]);

    expect(prompt).not.toMatch(/too long to serve as a name/i);
    expect(prompt).not.toMatch(/accessible name is/);
  });
});
