import { MARKDOWN_LIMITS } from '../lib/markdown/settings';

/**
 * Draws a Markdown document's diagrams in its page (plan 33, decision 10): every
 * `pre[data-ff-mermaid]` the converter wrote becomes Mermaid's SVG inside its figure, once the
 * fonts are loaded, because Mermaid measures text. Each figure is named by the diagram's `accTitle`
 * and `accDescr`, joined by a full stop, which Chromium makes the `Alt` of its `Figure` (decision
 * 13). The runner reads the two lines itself (`readDiagram`) and hands Mermaid the source without
 * them: Mermaid 12 writes them into the picture for 16 of its kinds only, a C4 diagram carries the
 * title of the diagram drawn before it, a kanban board draws the line as a column, and mindmaps,
 * Sankey and block diagrams refuse it.
 *
 * The answer says how many were drawn, or which failed and why, by the line of the Markdown text.
 * It never rejects: the render-worker reads it as data (`waitForReady`), and a diagram that does
 * not parse becomes `422 markdown_syntax_error` there.
 */

/** What the page answers once its diagrams are drawn. */
export type DiagramsOutcome =
  | { drawn: number }
  | { failed: { line: number; message: string } }
  | { unavailable: string };

/** What the runner uses of Mermaid's browser build, which sets `window.mermaid`. */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/** What the page's look gives a diagram: the document's font, and its accent as `#rrggbb`. */
export interface DiagramStyle {
  fontFamily: string;
  /** The brand kit's primary colour, else the `document` theme's link colour. */
  accent: string;
}

/** The accent without a brand kit: the `document` theme's link colour. */
export const DEFAULT_ACCENT = '#0b57d0';

/** A message's length in a problem's `detail`, which carries it whole otherwise. */
const MESSAGE_LENGTH = 300;

const TEXT = '#1f2328';

/**
 * The slices of a pie: light tones that the text's colour reads on, apart enough to tell in print.
 * Mermaid derives them from the nodes' colour, which left them too pale to tell apart.
 */
const PIE = [
  '#a5c8f5',
  '#ffd59e',
  '#a3e4b7',
  '#f5a8b0',
  '#cdb8f6',
  '#f9e79f',
  '#9fdfdf',
  '#e2c4a8',
  '#c5d0dc',
  '#ffc2e2',
  '#d4e9a3',
  '#d9d9d9',
];

const collapse = (text: string | null | undefined) =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** `#rrggbb` mixed with white by `amount`, from 0 (the colour) to 1 (white). */
export function tint(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `#${[n >> 16, (n >> 8) & 255, n & 255]
    .map((v) =>
      Math.round(v + (255 - v) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * Mermaid's configuration (decision 8): nothing runs on load, labels are encoded and clicks off
 * (`strict`), ids follow a counter, so the same document gives the same file, the `base` theme in
 * the document's font and accent, no shadows, and an error throws instead of drawing a box. A
 * diagram's own directive may change its look, but none of the rest.
 */
export function mermaidConfig(style: DiagramStyle): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    deterministicIds: true,
    suppressErrorRendering: true,
    maxTextSize: MARKDOWN_LIMITS.diagramBytes,
    theme: 'base',
    fontFamily: style.fontFamily,
    themeVariables: {
      fontFamily: style.fontFamily,
      // nodes in a light tint of the accent, so their labels stay dark, and the accent on borders
      primaryColor: tint(style.accent, 0.86),
      primaryBorderColor: style.accent,
      primaryTextColor: TEXT,
      textColor: TEXT,
      lineColor: '#59636e',
      dropShadow: 'none',
      pieTitleTextColor: TEXT,
      pieSectionTextColor: TEXT,
      pieLegendTextColor: TEXT,
      ...Object.fromEntries(PIE.map((colour, i) => [`pie${i + 1}`, colour])),
    },
    secure: [
      'secure',
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'suppressErrorRendering',
      'maxEdges',
      'deterministicIds',
      'deterministicIDSeed',
    ],
  };
}

/**
 * A Mermaid error's message on one line, without the excerpt of the source and the caret its
 * parsers add, and without its own line number, which the problem gives as the document's.
 */
export function messageOf(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String((error as { message?: unknown })?.message ?? error);
  const lines = raw.split('\n').map((line) => line.trim());
  // Jison: "Parse error on line 2:", the source, a caret, "Expecting …, got …"
  const parse = /^Parse error on line \d+:?$/i.test(lines[0] ?? '');
  const text = parse
    ? lines.filter((line, i) => i > 0 && /^Expecting\b/.test(line)).join(' ') ||
      'Parse error'
    : raw;
  // Langium: "Parsing failed: Lexer error on line 2, column 9: … at offset: 12, …", in positions
  // of the text Mermaid parsed, which the problem's line replaces
  const message = collapse(
    text
      .replace(/^Parsing failed:\s*/i, '')
      .replace(/found `\n`/g, 'found the end of a line')
      .replace(/ on line \d+(?:, column \d+)?/gi, '')
      .replace(/ at offset: \d+,?/gi, ','),
  );
  return message.length > MESSAGE_LENGTH
    ? `${message.slice(0, MESSAGE_LENGTH - 1)}…`
    : message;
}

/**
 * The line of the Markdown text a Mermaid error is about: the diagram's own line where the error
 * says one (Jison's `hash.loc`, else "line N" in the message), else its first line, through the
 * runner's map of the lines Mermaid counts (`DiagramSource.lines`) from `first`, the document's line
 * of the fence's first line of source.
 */
export function errorLine(
  first: number,
  error: unknown,
  lines?: readonly number[],
  front = 0,
): number {
  const hash = (
    error as {
      hash?: { loc?: { first_line?: unknown }; token?: unknown };
    } | null
  )?.hash;
  const loc = hash?.loc?.first_line;
  let within = typeof loc === 'number' && loc >= 1 ? loc : undefined;
  // Mermaid's `positionedShapeError`, a flowchart's error about a node (no token), counts the front
  // matter's lines in; its parsers count from the line after it
  if (within !== undefined && hash?.token === null) within -= front;
  if (within === undefined) {
    const raw = error instanceof Error ? error.message : String(error);
    const m = /\bline (\d+)/i.exec(raw);
    if (m) within = Number(m[1]);
  }
  const line = within !== undefined && within >= 1 ? within : 1;
  // without a map, the lines are the source's; past the map's end, its last line
  return (
    first + (lines ? (lines[Math.min(line, lines.length) - 1] ?? 0) : line - 1)
  );
}

/** A diagram's source as the runner hands it to Mermaid, and what it read of it first. */
export interface DiagramSource {
  /**
   * What Mermaid reads: no accessibility lines or comments, no empty lines before the diagram's
   * first line or between it and the next, and the directives before it put onto that line.
   */
  text: string;
  /** The name `accTitle` and `accDescr` give the diagram, joined by a full stop, or empty. */
  name: string;
  /**
   * The source's line, from 0, of each line Mermaid counts in `text`, from its line 1: the one after
   * the front matter.
   */
  lines: number[];
  /** The front matter's lines. */
  front: number;
}

const ACC_TITLE = /^[\t ]*accTitle[\t ]*:(.*)$/;
const ACC_DESCR = /^[\t ]*accDescr[\t ]*:(.*)$/;
const ACC_BLOCK = /^[\t ]*accDescr[\t ]*\{(.*)$/;
/** A comment, which Mermaid drops before its parsers see the text; `%%{` opens a directive. */
const COMMENT = /^[\t ]*%%(?!\{)./;
const DIRECTIVE = /^[\t ]*%%\{/;

/** An accessibility line's text, up to an inline comment, as Mermaid's grammars end it. */
const accText = (text: string) => collapse(text.replace(/%%.*$/, ''));

/**
 * Reads a diagram's `accTitle` and `accDescr` (a line each, or `accDescr { … }` over several) and
 * hands Mermaid the rest in a form whose lines it counts alike for every kind, with a map back to
 * the source's. Mermaid 12 drops comment lines, and for every kind but flowcharts the empty lines
 * before a diagram's first line, the one a `%%{init}%%` directive leaves included, and mindmaps and
 * kanban boards refuse an empty line after their first; so the runner blanks the comments, takes
 * empty lines out there, puts the leading directives onto the first line, and maps what is left.
 * Front matter stays as written, since Mermaid reads its YAML.
 */
export function readDiagram(source: string): DiagramSource {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const at = (i: number) => lines[i] ?? '';
  let start = 0;
  while (start < lines.length && !at(start).trim()) start++;
  let body = start;
  const open = /^([\t ]*)---[\t ]*$/.exec(at(start));
  if (open) {
    const close = `${open[1] ?? ''}---`;
    for (let i = start + 1; i < lines.length; i++)
      if (at(i).startsWith(close) && !at(i).slice(close.length).trim()) {
        body = i + 1;
        break;
      }
  }
  let title = '';
  let description = '';
  for (let i = body; i < lines.length; i++) {
    const line = at(i);
    let m: RegExpExecArray | null;
    if ((m = ACC_TITLE.exec(line))) {
      title = accText(m[1] ?? '');
      lines[i] = '';
    } else if ((m = ACC_DESCR.exec(line))) {
      description = accText(m[1] ?? '');
      lines[i] = '';
    } else if ((m = ACC_BLOCK.exec(line))) {
      // the block ends at its first `}`, as Mermaid's lexer reads it; one never closed is Mermaid's
      const parts: string[] = [];
      let rest = m[1] ?? '';
      let end = i;
      let close = rest.indexOf('}');
      while (close < 0 && end + 1 < lines.length) {
        parts.push(rest);
        end++;
        rest = COMMENT.test(at(end)) ? '' : at(end);
        close = rest.indexOf('}');
      }
      if (close < 0) continue;
      parts.push(rest.slice(0, close));
      description = collapse(parts.join(' '));
      for (let k = i; k < end; k++) lines[k] = '';
      // what follows the `}` on its line is read again
      lines[end] = rest.slice(close + 1);
      i = end - 1;
    } else if (COMMENT.test(line)) lines[i] = '';
  }
  let first = body;
  const directives: string[] = [];
  while (first < lines.length) {
    if (!at(first).trim()) {
      first++;
      continue;
    }
    if (!DIRECTIVE.test(at(first))) break;
    // a directive runs to its `}%%`, over several lines if it is written so
    let directive = at(first).trim();
    while (!directive.includes('}%%') && first + 1 < lines.length) {
      first++;
      directive += ` ${at(first).trim()}`;
    }
    directives.push(directive);
    first++;
  }
  const parts = [title, description].filter(Boolean);
  const name = parts
    .map((part, i) =>
      i < parts.length - 1 && !/[.!?:]$/.test(part) ? `${part}.` : part,
    )
    .join(' ');
  // nothing to draw: Mermaid says so, of the source as it was written
  if (first >= lines.length)
    return { text: source, name, lines: [0], front: 0 };
  const kept = [`${directives.join('')}${at(first)}`];
  const map = [first];
  let next = first + 1;
  while (next < lines.length && !at(next).trim()) next++;
  for (let i = next; i < lines.length; i++) {
    kept.push(at(i));
    map.push(i);
  }
  return {
    text: [...lines.slice(start, body), ...kept].join('\n'),
    name,
    lines: map,
    front: body - start,
  };
}

/** A CSS colour as `#rrggbb`, as the page computes it, or null for what is no colour. */
export function cssColour(win: Window, value: string): string | null {
  if (!value) return null;
  const probe = win.document.createElement('span');
  probe.style.color = value;
  if (!probe.style.color) return null;
  win.document.body.appendChild(probe);
  const computed = win.getComputedStyle(probe).color;
  probe.remove();
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(computed);
  return m
    ? `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`
    : null;
}

/** Draws every diagram of the page in turn; see the module's comment. */
export async function drawDiagrams(
  win: Window,
  mermaid: MermaidApi | undefined,
): Promise<DiagramsOutcome> {
  const doc = win.document;
  const sources = Array.from(
    doc.querySelectorAll<HTMLElement>('pre[data-ff-mermaid]'),
  );
  if (!sources.length) return { drawn: 0 };
  if (!mermaid) return { unavailable: 'Mermaid did not load' };
  await (doc as Document & { fonts?: { ready: Promise<unknown> } }).fonts
    ?.ready;
  const scope = doc.querySelector('.ff-markdown') ?? doc.body;
  const computed = win.getComputedStyle(scope);
  mermaid.initialize(
    mermaidConfig({
      fontFamily: computed.fontFamily,
      accent:
        cssColour(
          win,
          computed.getPropertyValue('--brand-color-primary').trim(),
        ) ?? DEFAULT_ACCENT,
    }),
  );
  let drawn = 0;
  for (const [index, pre] of sources.entries()) {
    const first = Number(pre.getAttribute('data-ff-line')) || 1;
    const diagram = readDiagram(pre.textContent ?? '');
    let svg: string;
    try {
      ({ svg } = await mermaid.render(`ff-diagram-${index + 1}`, diagram.text));
    } catch (error) {
      return {
        failed: {
          line: errorLine(first, error, diagram.lines, diagram.front),
          message: messageOf(error),
        },
      };
    }
    const holder = doc.createElement('div');
    holder.innerHTML = svg;
    const picture = holder.firstElementChild;
    if (!picture)
      return { failed: { line: first - 1, message: 'Mermaid drew nothing' } };
    const figure = pre.parentElement;
    pre.replaceWith(picture);
    if (diagram.name && figure) figure.setAttribute('aria-label', diagram.name);
    drawn++;
  }
  return { drawn };
}
