/**
 * A field's label, kept to a length a label can plausibly be.
 *
 * openai.com's ChatGPT prompt box wraps its textarea in a `<label>` that also
 * contains the whole suggestion carousel: 60 child elements and 1,784
 * characters of text, from "Message ChatGPT" through "Quiz me on vocabulary"
 * to "Explain paradiddles for me". The browser associates it -- the
 * textarea's `labels` collection has it, so that string genuinely is the
 * control's accessible name.
 *
 * Which makes this not an extraction bug. The extractor was reporting the
 * truth, and the truth is unusable: the report rendered 1,728 characters as
 * the field's heading (`FormAnalysisDisplay` shows `field.label` as the
 * title), and the string took up 8% of the result payload.
 *
 * So the text is cut to a readable length and the real length is kept
 * alongside it. Nothing is hidden: a name that long is itself the finding,
 * and the analyser is told about it so it can say so.
 */

/**
 * Long enough for any label a person would write, short enough to read as a
 * heading. "Please enter the email address associated with your account" is
 * 58 characters, so this leaves plenty of room.
 */
export const MAX_LABEL_CHARS = Number(process.env.MAX_LABEL_CHARS || 120);

/**
 * Collapses whitespace and cuts over-long text.
 *
 * Returns the text to show, the true character count, and whether it was
 * cut. The count is of the collapsed text, because that is what a reader
 * would see -- markup indentation is not part of the name.
 */
export const summariseFieldLabel = (raw) => {
  const collapsed = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  if (collapsed.length <= MAX_LABEL_CHARS) {
    return { text: collapsed, length: collapsed.length, truncated: false };
  }

  return {
    // Cut at a word boundary where there is one nearby, so the heading does
    // not end mid-word.
    text: `${collapsed.slice(0, MAX_LABEL_CHARS).replace(/\s+\S*$/, '')}...`,
    length: collapsed.length,
    truncated: true
  };
};
