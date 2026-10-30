import { describe, expect, it } from 'vitest';

import { MAX_LABEL_CHARS, summariseFieldLabel } from '../../server/lib/analysis/fieldLabel.js';

/**
 * openai.com's ChatGPT prompt box is wrapped in a `<label>` that also holds
 * the suggestion carousel: 60 child elements, 1,784 characters. The browser
 * associates it, so that really is the textarea's accessible name -- the
 * extractor was telling the truth, and the truth rendered as a
 * 1,728-character field heading in the report.
 */

/** The opening of the name openai.com actually gives that control. */
const OPENAI_LABEL =
  'Message ChatGPT Quiz me on vocabulary Plan a surf trip to Costa Rica in August ' +
  'India stock market today Explain why popcorn pops Teach me Mahjong for beginners ' +
  'Find hiking boots for wide feet Explain this code What can I do in Berlin when it rains?';

describe('labels short enough to be labels', () => {
  it('leaves an ordinary label exactly as it is', async () => {
    const summary = summariseFieldLabel('Email address');

    expect(summary).toEqual({ text: 'Email address', length: 13, truncated: false });
  });

  it('collapses the whitespace markup indentation introduces', async () => {
    // Cheerio's text() keeps the newlines and padding from the source.
    expect(summariseFieldLabel('\n  Email\n  address\n ').text).toBe('Email address');
  });

  it('treats a missing label as empty rather than failing', async () => {
    expect(summariseFieldLabel(undefined)).toEqual({ text: '', length: 0, truncated: false });
    expect(summariseFieldLabel(null).text).toBe('');
  });

  it('keeps a label sitting right on the limit', async () => {
    const exact = 'x'.repeat(MAX_LABEL_CHARS);

    expect(summariseFieldLabel(exact).truncated).toBe(false);
    expect(summariseFieldLabel(exact).text).toHaveLength(MAX_LABEL_CHARS);
  });
});

describe('a label too long to be a name', () => {
  it('cuts it to something a heading can show', async () => {
    const summary = summariseFieldLabel(OPENAI_LABEL);

    expect(summary.truncated).toBe(true);
    expect(summary.text.length).toBeLessThanOrEqual(MAX_LABEL_CHARS + 3);
    expect(summary.text.startsWith('Message ChatGPT')).toBe(true);
    expect(summary.text.endsWith('...')).toBe(true);
  });

  it('records the real length rather than hiding it', async () => {
    // The length is the finding. Cutting the text without keeping the count
    // would turn a reportable problem into a tidy-looking label.
    expect(summariseFieldLabel(OPENAI_LABEL).length).toBe(OPENAI_LABEL.length);
  });

  it('does not end mid-word', async () => {
    const summary = summariseFieldLabel(OPENAI_LABEL);
    const lastWord = summary.text.replace(/\.\.\.$/, '').split(' ').at(-1);

    expect(OPENAI_LABEL.split(' ')).toContain(lastWord);
  });

  it('still cuts text that has no spaces to break on', async () => {
    const summary = summariseFieldLabel('x'.repeat(500));

    expect(summary.truncated).toBe(true);
    expect(summary.text.length).toBeLessThanOrEqual(MAX_LABEL_CHARS + 3);
  });
});
