/**
 * `@formfeed/engine/markdown` (plan 29): what `settings.markdown` asks for, its limits, the one
 * wording of its refusals and the versions a Markdown render records. No parser is imported here and
 * nothing of Node, so the gateway Worker reads the same names as the render-worker, the CLI and the
 * engine's converter (`convert.ts`).
 */

/**
 * The look of a Markdown document: `document` (the default) is a stylesheet written for the wrapper
 * the converter writes, and takes the brand kit's fonts and colour; `none` is the print reset only,
 * for a caller's own `css`.
 */
export const MARKDOWN_THEMES = ['document', 'none'] as const;
export type MarkdownTheme = (typeof MARKDOWN_THEMES)[number];

/**
 * Raw HTML in the text (plan 29, decision 3). `safe`, the default of a Markdown source, shows it as
 * text and keeps only a few formatting tags without attributes; `allow` writes it as it stands, for
 * Markdown the caller wrote.
 */
export const MARKDOWN_HTML_MODES = ['safe', 'allow'] as const;
export type MarkdownHtmlMode = (typeof MARKDOWN_HTML_MODES)[number];

/** `settings.markdown` as a request writes it. */
export interface MarkdownSettings {
  theme?: MarkdownTheme;
  html?: MarkdownHtmlMode;
  /** A single line break is a `<br>`, as in a chat; off by default, as in GitHub Flavored Markdown. */
  breaks?: boolean;
  /**
   * A fence that names a language highlight.js knows is coloured (plan 33); on by default. The
   * classes are written in either theme, and `document` gives them its colours.
   */
  highlight?: boolean;
  /**
   * `$…$`, ``$`…`$``, `$$…$$` on lines of their own and ` ```math ` fences are typeset by KaTeX
   * (plan 33, decision 5). Off by default, because a `$` in a business document is usually money.
   */
  math?: boolean;
  /**
   * A ` ```mermaid ` fence is drawn by Mermaid in the page before it is printed (plan 33, decision
   * 8). Off by default: nothing runs in a Markdown document unless asked for, and Mermaid is a large
   * script that runs on the caller's text.
   */
  diagrams?: boolean;
  /** A stylesheet that comes after the theme. */
  css?: string;
}

/** `settings.markdown` with every default filled in. */
export interface ResolvedMarkdown {
  theme: MarkdownTheme;
  html: MarkdownHtmlMode;
  breaks: boolean;
  highlight: boolean;
  math: boolean;
  diagrams: boolean;
  css: string;
}

export const MARKDOWN_LIMITS = {
  /**
   * The text of a Markdown source, in UTF-8 bytes. Step 1 measured 735 pages of prose for 1 MB in
   * 5.5 s on production's CPU, where 2 MB took 26 s and 5 MB lay past what Chromium prints.
   */
  textBytes: 1024 * 1024,
  /** `settings.markdown.css`, in UTF-8 bytes. */
  cssBytes: 256 * 1024,
  /**
   * The code a document highlights, in UTF-8 bytes and in the order of the document (plan 33,
   * decision 3): what comes after prints plain. The linear grammars still cost up to 5.7 ms per kB on
   * input made to be slow.
   */
  highlightBytes: 256 * 1024,
  /** A block larger than this, in UTF-8 bytes, prints plain. */
  highlightBlockBytes: 100 * 1024,
  /**
   * A block with a line longer than this, in characters, prints plain: the `markdown` and `yaml`
   * grammars are quadratic within a line (14.5 s for one line of 100 kB in step 1).
   */
  highlightLineLength: 1000,
  /** A formula's TeX, in UTF-8 bytes (plan 33, decision 7). */
  formulaBytes: 4 * 1024,
  /**
   * The formulas a document holds: 1,000 took 7 s to render as PDF/UA-1 in step 1, and 2,000 did
   * not always finish. Counted as they are read, so the refusal comes before any is typeset.
   */
  formulas: 1000,
  /**
   * The TeX of a document's formulas together, in UTF-8 bytes (step 3): KaTeX's text mode grows
   * faster than its input, so 1 MB of formulas of 4 kB that are `\text{…}` took 3.1 s of a laptop's
   * CPU, and this cap holds such a document to about a second.
   */
  mathBytes: 256 * 1024,
  /**
   * The diagrams a document holds (plan 33, decision 8): drawing 50 took 2 s in step 1. Counted as
   * they are read, so the refusal comes before Mermaid runs.
   */
  diagrams: 50,
  /** A diagram's source, in UTF-8 bytes. */
  diagramBytes: 50 * 1024,
} as const;

const SETTING_KEYS = [
  'theme',
  'html',
  'breaks',
  'highlight',
  'math',
  'diagrams',
  'css',
] as const;

const megabytes = (bytes: number) => `${bytes / 1024 / 1024} MB`;
const kilobytes = (bytes: number) => `${bytes / 1024} kB`;

/**
 * Every refusal of a Markdown request, worded once. The gateway answers each as 400
 * `invalid_request` with the field it names.
 */
export const MARKDOWN_REFUSALS = {
  notObject: 'settings.markdown must be an object',
  unknownKey: (key: string) =>
    `settings.markdown.${key} is not a setting: the settings are ${SETTING_KEYS.join(', ')}`,
  theme: `settings.markdown.theme must be one of ${MARKDOWN_THEMES.join(', ')}`,
  html: `settings.markdown.html must be one of ${MARKDOWN_HTML_MODES.join(', ')}`,
  breaks: 'settings.markdown.breaks must be true or false',
  highlight: 'settings.markdown.highlight must be true or false',
  math: 'settings.markdown.math must be true or false',
  diagrams: 'settings.markdown.diagrams must be true or false',
  css: 'settings.markdown.css must be a stylesheet as text',
  cssTooLarge: `settings.markdown.css is larger than ${kilobytes(MARKDOWN_LIMITS.cssBytes)}`,
  textTooLarge: `markdown is larger than ${megabytes(MARKDOWN_LIMITS.textBytes)}`,
  otherSource: 'settings.markdown applies to a markdown source only',
} as const;

/** A refusal and the field it is about, as `settings.markdown.<key>` or `settings.markdown`. */
export interface MarkdownProblem {
  field: string;
  message: string;
}

const encoder = new TextEncoder();

/** UTF-8 bytes of a text, counted without encoding it where its length alone settles the question. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** Whether a text is within a byte limit; a string is at most three bytes per UTF-16 unit. */
function withinBytes(text: string, limit: number): boolean {
  if (text.length * 3 <= limit) return true;
  return text.length <= limit && utf8Bytes(text) <= limit;
}

/** Whether the text of a Markdown source is within `MARKDOWN_LIMITS.textBytes`. */
export function markdownTextWithinLimit(text: string): boolean {
  return withinBytes(text, MARKDOWN_LIMITS.textBytes);
}

/**
 * What is wrong with a `settings.markdown` block, or `null` when the API takes it. The block is
 * strict (plan 29, decision 6): an unknown key or a value that does not exist is refused, never
 * ignored, so a typo does not quietly print a document in another look.
 */
export function markdownSettingsProblem(
  value: unknown,
): MarkdownProblem | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    return { field: 'settings.markdown', message: MARKDOWN_REFUSALS.notObject };
  const block = value as Record<string, unknown>;
  for (const key of Object.keys(block))
    if (!(SETTING_KEYS as readonly string[]).includes(key))
      return {
        field: `settings.markdown.${key}`,
        message: MARKDOWN_REFUSALS.unknownKey(key),
      };
  const at = (key: (typeof SETTING_KEYS)[number], message: string) => ({
    field: `settings.markdown.${key}`,
    message,
  });
  if (
    block['theme'] !== undefined &&
    !(MARKDOWN_THEMES as readonly unknown[]).includes(block['theme'])
  )
    return at('theme', MARKDOWN_REFUSALS.theme);
  if (
    block['html'] !== undefined &&
    !(MARKDOWN_HTML_MODES as readonly unknown[]).includes(block['html'])
  )
    return at('html', MARKDOWN_REFUSALS.html);
  if (block['breaks'] !== undefined && typeof block['breaks'] !== 'boolean')
    return at('breaks', MARKDOWN_REFUSALS.breaks);
  if (
    block['highlight'] !== undefined &&
    typeof block['highlight'] !== 'boolean'
  )
    return at('highlight', MARKDOWN_REFUSALS.highlight);
  if (block['math'] !== undefined && typeof block['math'] !== 'boolean')
    return at('math', MARKDOWN_REFUSALS.math);
  if (block['diagrams'] !== undefined && typeof block['diagrams'] !== 'boolean')
    return at('diagrams', MARKDOWN_REFUSALS.diagrams);
  if (block['css'] !== undefined) {
    if (typeof block['css'] !== 'string')
      return at('css', MARKDOWN_REFUSALS.css);
    if (!withinBytes(block['css'], MARKDOWN_LIMITS.cssBytes))
      return at('css', MARKDOWN_REFUSALS.cssTooLarge);
  }
  return null;
}

/** Whether a `settings.markdown` value is one the API takes. */
export function isMarkdownSettings(
  value: unknown,
): value is MarkdownSettings | null | undefined {
  return markdownSettingsProblem(value) === null;
}

/**
 * `settings.markdown` as a render reads it: the defaults where the block says nothing, and the
 * defaults again for a value the API would have refused, since a render never fails on its look.
 */
export function resolveMarkdown(value: unknown): ResolvedMarkdown {
  const block =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const theme = block['theme'];
  const html = block['html'];
  return {
    theme: (MARKDOWN_THEMES as readonly unknown[]).includes(theme)
      ? (theme as MarkdownTheme)
      : 'document',
    html: (MARKDOWN_HTML_MODES as readonly unknown[]).includes(html)
      ? (html as MarkdownHtmlMode)
      : 'safe',
    breaks: block['breaks'] === true,
    highlight: block['highlight'] !== false,
    math: block['math'] === true,
    diagrams: block['diagrams'] === true,
    css: typeof block['css'] === 'string' ? block['css'] : '',
  };
}

// --- versions ----------------------------------------------------------------------------------

/**
 * What converts the text: the parser, its release (`convert.spec.ts` holds it to the installed
 * package) and the revision of our own rules on top of it (front matter, page breaks, heading levels
 * and ids, cells, task lists, raw HTML, the highlighted fence). A change to the rules that changes a
 * document bumps `rules`.
 */
export const MARKDOWN_CONVERTER = {
  parser: 'markdown-it',
  version: '15.0.3',
  rules: 2,
} as const;

/**
 * What colours code (plan 33, decision 2), and its release; `rich/code.spec.ts` holds it to the
 * installed package. A new release may colour a document differently, so it changes the version a
 * render records.
 */
export const MARKDOWN_HIGHLIGHTER = {
  library: 'highlight.js',
  version: '11.12.0',
} as const;

/**
 * What typesets formulas (plan 33, decision 7), and its release; `rich/math.spec.ts` holds it to the
 * installed package. A document with `math` names it, because a new release may set a formula
 * differently.
 */
export const MARKDOWN_MATH = {
  library: 'katex',
  version: '0.19.1',
} as const;

/**
 * What draws diagrams (plan 33, decision 8), and its release; `rich/diagrams.spec.ts` holds it to
 * the installed package, whose browser build the render-worker serves. A document with `diagrams`
 * names it, because a new release may draw a diagram differently.
 */
export const MARKDOWN_DIAGRAMS = {
  library: 'mermaid',
  version: '12.3.0',
} as const;

/**
 * The revision of each theme's stylesheet. A change to a theme bumps its revision, so a render is
 * never deduplicated against a file in yesterday's look; `themes.spec.ts` holds each to a hash of
 * its CSS.
 */
export const MARKDOWN_THEME_REVISIONS: Readonly<Record<MarkdownTheme, number>> =
  {
    document: 2,
    none: 1,
  };

/**
 * How a render records its converter, its theme and the libraries its settings let it use, in
 * `engine_version` and the deduplication key, so that the key changes when one of them does:
 * `markdown-it 15.0.3, rules 2, theme document 2, highlight.js 11.12.0, katex 0.19.1, mermaid 12.3.0`.
 * The settings decide, not the text, so a document without code names highlight.js as well. A theme
 * alone, as callers before plan 33 pass it, stands for that theme with the other defaults.
 */
export function markdownVersion(
  markdown:
    | MarkdownTheme
    | (Pick<ResolvedMarkdown, 'theme' | 'highlight'> & {
        math?: boolean;
        diagrams?: boolean;
      }),
): string {
  const { parser, version, rules } = MARKDOWN_CONVERTER;
  const { theme, highlight, math, diagrams } =
    typeof markdown === 'string'
      ? { ...resolveMarkdown({}), theme: markdown }
      : markdown;
  const parts = [
    `${parser} ${version}`,
    `rules ${rules}`,
    `theme ${theme} ${MARKDOWN_THEME_REVISIONS[theme]}`,
  ];
  if (highlight)
    parts.push(
      `${MARKDOWN_HIGHLIGHTER.library} ${MARKDOWN_HIGHLIGHTER.version}`,
    );
  if (math) parts.push(`${MARKDOWN_MATH.library} ${MARKDOWN_MATH.version}`);
  if (diagrams)
    parts.push(`${MARKDOWN_DIAGRAMS.library} ${MARKDOWN_DIAGRAMS.version}`);
  return parts.join(', ');
}
