import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MARKDOWN_THEMES, MARKDOWN_THEME_REVISIONS } from '../settings';
import { documentTheme } from './document';
import { markdownThemeCss } from './index';

/**
 * A theme's revision is in every Markdown render's deduplication key and `engine_version`, so a
 * changed stylesheet must come with a new revision, or a render would be answered with a file in
 * yesterday's look. Changing the CSS fails this spec until both lines below change together.
 */
const PINNED: Record<string, { revision: number; sha256: string }> = {
  document: {
    revision: 1,
    sha256: '2934d5bca8df9b142330fcb2448a478d132a58407cf316bb0c2221338fb18710',
  },
};

describe('themes', () => {
  it('bump their revision with their stylesheet', () => {
    expect(MARKDOWN_THEME_REVISIONS.document).toBe(
      PINNED['document']!.revision,
    );
    expect(createHash('sha256').update(documentTheme).digest('hex')).toBe(
      PINNED['document']!.sha256,
    );
  });

  it('style only the wrapper the converter writes', () => {
    for (const rule of documentTheme.split('}').filter((r) => r.trim())) {
      const selectors = rule.slice(0, rule.indexOf('{')).split(',');
      for (const selector of selectors)
        expect(selector.trim(), rule).toMatch(/^\.ff-markdown\b/);
    }
  });

  it('size headings by the level written, never by the tag', () => {
    for (const level of [1, 2, 3, 4, 5, 6])
      expect(documentTheme).toContain(
        `.ff-markdown .ff-h${level} { font-size:`,
      );
    expect(documentTheme).not.toMatch(/\.ff-markdown h\d \{[^}]*font-size/);
  });

  it('wrap what could be wider than the page', () => {
    expect(documentTheme).toMatch(
      /\.ff-markdown pre \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/,
    );
    for (const element of ['code', 'a', 'th, .ff-markdown td'])
      expect(documentTheme).toMatch(
        new RegExp(
          `\\.ff-markdown ${element} \\{[^}]*overflow-wrap: anywhere;`,
        ),
      );
  });

  it('`none` is the print reset alone', () => {
    expect(markdownThemeCss('none')).toBe('');
    expect(MARKDOWN_THEMES.map(markdownThemeCss)).toEqual([documentTheme, '']);
  });
});
