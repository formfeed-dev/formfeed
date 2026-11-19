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
    revision: 2,
    sha256: '54862d994be68ca0cb13c3f8e6de53b525c082ad947037f2ab8d8937cc2430ac',
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

  it('colours code’s tokens at 5:1 or more on the code’s background (plan 33, decision 4)', () => {
    const channel = (v: number) =>
      v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) =>
        channel(parseInt(hex.slice(i, i + 2), 16) / 255),
      );
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const background =
      /\.ff-markdown pre \{[^}]*background: (#[0-9a-f]{6});/.exec(
        documentTheme,
      )?.[1];
    expect(background).toBe('#f6f8fa');
    const colours = [
      ...documentTheme.matchAll(
        /^(.*\.hljs-[^{]*)\{[^}]*color: (#[0-9a-f]{6});/gm,
      ),
    ];
    // every group of decision 4, the text of an interpolation included
    expect(new Set(colours.map((c) => c[2])).size).toBe(10);
    for (const [, selectors, colour] of colours)
      expect(
        contrast(colour!, background!),
        `${selectors!.trim()} ${colour}`,
      ).toBeGreaterThanOrEqual(5);
  });

  it('`none` is the print reset alone', () => {
    expect(markdownThemeCss('none')).toBe('');
    expect(MARKDOWN_THEMES.map(markdownThemeCss)).toEqual([documentTheme, '']);
  });
});
