/**
 * Formulas in a Markdown document (plan 33, decisions 5 to 7 and 9): rules of our own on the model of
 * `@vscode/markdown-it-katex` 1.1.2 (MIT), and KaTeX 0.19 to typeset what they read.
 *
 * The forms are GitHub's four: `$…$` and ``$`…`$`` inline, `$$…$$` on lines of their own, and
 * ` ```math ` fences. A `$` opens before a character that is no space and closes after one, and not
 * before a digit, as Pandoc reads it, so `$5 and $10` stays text; `\$` is a dollar sign. The inline
 * rule is the plugin's, which step 1 measured linear: it looks for the next `$` only, and a `$` that
 * cannot open or close is text. The block rule is new: the plugin's looked at the whole document
 * again for every line of a `$$` that was never closed (41 s at 300 kB), where this one reads each
 * line of a formula once, and a `$$` that is never closed fails the render instead of taking the
 * rest of the document. Reading math inside raw HTML stays out.
 *
 * Every formula is counted and measured as it is read, so a document past the limits of
 * `MARKDOWN_LIMITS` fails before any formula is typeset. KaTeX typesets with decision 7's options and
 * fails instead of printing an error box (the plugin's renderers printed every error, even with
 * `throwOnError`); a command KaTeX trusts only on request (`\href`, `\url`, `\includegraphics`,
 * `\htmlClass` and the like) fails as well, where KaTeX would print it in red. A formula is
 * `role="img"` with its TeX as `aria-label`, and KaTeX's HTML loses its `aria-hidden`: only then does
 * Chromium tag it, as a `Figure` whose `Alt` is the TeX, which the render-worker renames `Formula`
 * (decision 13). KaTeX's MathML copy is not written.
 */
import katex, { type KatexOptions } from 'katex';
import type {
  Env,
  MarkdownIt as Parser,
  StateBlock,
  StateCore,
  StateInline,
  Token,
} from 'markdown-it';
import { MarkdownSyntaxError, RenderLimitError } from '../../errors';
import { defaultLimits } from '../../limits';
import { MARKDOWN_LIMITS, utf8Bytes } from '../settings';

/** The release that typesets, as KaTeX reports it. */
export const KATEX_VERSION: string = katex.version;

const DOLLAR = 0x24;
const BACKTICK = 0x60;
const BACKSLASH = 0x5c;

/** What a document's formulas carry through markdown-it, in its `env`. */
interface MathPass {
  /** The formulas read so far, and their TeX in UTF-8 bytes. */
  formulas: number;
  bytes: number;
  /** The line, from 0, of the block whose inline content is being read. */
  blockLine: number;
  /** One document's macros: `\gdef` holds within the document and not into the next. */
  macros: NonNullable<KatexOptions['macros']>;
  /** The HTML the formulas made, in UTF-16 units, held to the render's output limit. */
  html: number;
}

const PASS = 'formfeedMath';
function passOf(env: Env): MathPass {
  let pass = env[PASS] as MathPass | undefined;
  if (!pass)
    env[PASS] = pass = {
      formulas: 0,
      bytes: 0,
      blockLine: 0,
      macros: {},
      html: 0,
    };
  return pass;
}

/**
 * Where a formula's TeX starts: a block's line, or, inline, the block's line and the place in its
 * text, from which the line is counted only when an error needs it.
 */
type Place = { line: number } | { block: number; text: string; at: number };

/** Line breaks in `text` before `end`. */
function breaksBefore(text: string, end: number): number {
  let count = 0;
  for (
    let at = text.indexOf('\n');
    at >= 0 && at < end;
    at = text.indexOf('\n', at + 1)
  )
    count++;
  return count;
}

/** The line, from 1, of a place in a formula's TeX: its start without an offset. */
function lineOf(place: Place, tex = '', offset = 0): number {
  const start =
    'line' in place
      ? place.line
      : place.block + breaksBefore(place.text, place.at);
  return start + 1 + (offset > 0 ? breaksBefore(tex, offset) : 0);
}

const grouped = (n: number) => n.toLocaleString('en-US');

/**
 * Counts and measures a formula as it is read; throws once the document is past a limit, naming the
 * line where it passed it.
 */
function admit(pass: MathPass, tex: string, place: Place): void {
  const { formulaBytes, formulas, mathBytes } = MARKDOWN_LIMITS;
  pass.formulas++;
  if (pass.formulas > formulas) {
    const line = lineOf(place);
    throw new MarkdownSyntaxError(
      'math',
      `The formula on line ${line} is one more than the ${grouped(formulas)} a document may hold`,
      line,
    );
  }
  const bytes = utf8Bytes(tex);
  if (bytes > formulaBytes) {
    const line = lineOf(place);
    throw new MarkdownSyntaxError(
      'math',
      `The formula on line ${line} is ${grouped(bytes)} bytes long; a formula may be at most ${grouped(formulaBytes)}`,
      line,
    );
  }
  pass.bytes += bytes;
  if (pass.bytes > mathBytes) {
    const line = lineOf(place);
    throw new MarkdownSyntaxError(
      'math',
      `With the formula on line ${line}, the document's formulas hold more than the ${mathBytes / 1024} kB of TeX a document may hold`,
      line,
    );
  }
}

// --- inline: `$…$` and ``$`…`$`` ---------------------------------------------------------------

interface Found {
  tex: string;
  /** Where the TeX starts in the inline text. */
  at: number;
  /** Where the formula ends, after its closing delimiter. */
  end: number;
  markup: string;
}

/**
 * `$…$`: the next `$` that no backslash escapes closes it, if a space stands neither after the
 * opening `$` nor before the closing one, and no digit after the closing one. Only that `$` is
 * looked at, so a `$` that does not open costs the distance to the next.
 */
function dollarFormula(state: StateInline, start: number): Found | null {
  const { src, posMax: max } = state;
  const isSpace = state.md.utils.isWhiteSpace;
  if (start + 1 >= max || isSpace(src.charCodeAt(start + 1))) return null;
  let at = start + 1;
  for (;;) {
    at = src.indexOf('$', at);
    if (at < 0 || at >= max) return null;
    let slashes = 0;
    for (let i = at - 1; src.charCodeAt(i) === BACKSLASH; i--) slashes++;
    if (slashes % 2 === 0) break;
    at++;
  }
  const after = src.charCodeAt(at + 1);
  if (isSpace(src.charCodeAt(at - 1)) || (after >= 0x30 && after <= 0x39))
    return null;
  return {
    tex: src.slice(start + 1, at),
    at: start + 1,
    end: at + 1,
    markup: '$',
  };
}

/**
 * The last search for `` `$ `` in one inline text: the inline parser asks with positions that only
 * grow, so a text of openers that are never closed is searched once and not once per opener.
 */
const tickCloses = new WeakMap<StateInline, { from: number; at: number }>();
function nextTickClose(state: StateInline, from: number): number {
  const known = tickCloses.get(state);
  if (known && from >= known.from && (known.at < 0 || from <= known.at))
    return known.at;
  const at = state.src.indexOf('`$', from);
  tickCloses.set(state, { from, at });
  return at;
}

/** ``$`…`$``, GitHub's form: the first `` `$ `` closes it, whatever stands between. */
function backtickFormula(state: StateInline, start: number): Found | null {
  const from = start + 2;
  const close = nextTickClose(state, from);
  if (close < 0 || close + 2 > state.posMax || close === from) return null;
  return {
    tex: state.src.slice(from, close),
    at: from,
    end: close + 2,
    markup: '$`',
  };
}

function inlineRule(state: StateInline, silent: boolean): boolean {
  const { src, pos: start } = state;
  if (src.charCodeAt(start) !== DOLLAR) return false;
  // a run of dollars is text: `$$` is display math on lines of its own only (decision 5)
  if (src.charCodeAt(start + 1) === DOLLAR) {
    let end = start + 2;
    while (end < state.posMax && src.charCodeAt(end) === DOLLAR) end++;
    if (!silent) state.pending += src.slice(start, end);
    state.pos = end;
    return true;
  }
  const found =
    src.charCodeAt(start + 1) === BACKTICK
      ? backtickFormula(state, start)
      : dollarFormula(state, start);
  if (!found) {
    if (!silent) state.pending += '$';
    state.pos = start + 1;
    return true;
  }
  if (!silent) {
    const pass = passOf(state.env);
    const place: Place = { block: pass.blockLine, text: src, at: found.at };
    // counted where it is read for good, not where a link's label is only looked through
    admit(pass, found.tex, place);
    const token = state.push('math_inline', 'math', 0);
    token.content = found.tex;
    token.markup = found.markup;
    token.meta = { place };
  }
  state.pos = found.end;
  return true;
}

/**
 * markdown-it's own `inline` core rule, which parses every block's inline text, and notes the line
 * the block starts on first, so that an inline formula's line can be counted from it.
 */
function inlineWithLines(state: StateCore): void {
  const pass = passOf(state.env);
  for (const token of state.tokens)
    if (token.type === 'inline') {
      pass.blockLine = token.map?.[0] ?? pass.blockLine;
      state.md.inline.parse(
        token.content,
        state.md,
        state.env,
        token.children as Token[],
      );
    }
}

// --- blocks: `$$…$$` and ` ```math ` --------------------------------------------------------------

/**
 * `$$` at the start of a line opens a formula, which the first line that ends in `$$` closes; on one
 * line, `$$…$$` is a formula when the closing `$$` ends the line. A `$$` in the middle of the first
 * line makes no formula, as the plugin reads it. Each line is read once, and a formula that its
 * container ends before it is closed fails the render.
 */
function blockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) return false;
  const { src } = state;
  const begin = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
  const max = state.eMarks[startLine] ?? begin;
  if (
    max - begin < 2 ||
    src.charCodeAt(begin) !== DOLLAR ||
    src.charCodeAt(begin + 1) !== DOLLAR
  )
    return false;
  const first = src.slice(begin + 2, max);
  const closing = first.indexOf('$$');
  const trimmed = first.trimEnd();
  if (closing >= 0) {
    // `$$…$$` on its line; `$$$$` and a `$$` with text after it are no formula
    if (closing !== trimmed.length - 2 || !trimmed.slice(0, -2).trim())
      return false;
    if (silent) return true;
    push(state, trimmed.slice(0, -2), startLine, startLine, startLine + 1);
    return true;
  }
  if (silent) return true;

  let next = startLine;
  let last: string | null = null;
  while (++next < endLine) {
    const from = (state.bMarks[next] ?? 0) + (state.tShift[next] ?? 0);
    const to = state.eMarks[next] ?? from;
    // a line that is not empty and indented less than the container ends the container
    if (from < to && (state.sCount[next] ?? 0) < state.blkIndent) break;
    const line = src.slice(from, to).trimEnd();
    if (line.endsWith('$$')) {
      last = line.slice(0, -2);
      break;
    }
  }
  if (last === null) {
    const line = startLine + 1;
    throw new MarkdownSyntaxError(
      'math',
      `The formula that opens with $$ on line ${line} is never closed: a line that ends in $$ closes it`,
      line,
    );
  }
  const head = first.trim() ? `${first}\n` : '';
  // without the line break before the closing line, so that an error at the end of the input names
  // the formula's last line and not the line that closes it
  const tex = (
    head +
    state.getLines(startLine + 1, next, state.sCount[startLine] ?? 0, true) +
    (last.trim() ? last : '')
  ).trimEnd();
  push(state, tex, startLine, head ? startLine : startLine + 1, next + 1);
  return true;
}

function push(
  state: StateBlock,
  tex: string,
  startLine: number,
  texLine: number,
  nextLine: number,
): void {
  const place: Place = { line: texLine };
  admit(passOf(state.env), tex, place);
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = tex;
  token.markup = '$$';
  token.map = [startLine, nextLine];
  token.meta = { place };
  state.line = nextLine;
}

/** A fence whose language is `math` is a formula; read after the blocks and before their text. */
function mathFences(state: StateCore): void {
  const { unescapeAll } = state.md.utils;
  const pass = passOf(state.env);
  for (const token of state.tokens) {
    if (token.type !== 'fence') continue;
    const language = unescapeAll(token.info).trim().split(/\s/, 1)[0] ?? '';
    if (language.toLowerCase() !== 'math') continue;
    const place: Place = { line: (token.map?.[0] ?? 0) + 1 };
    token.content = token.content.trimEnd();
    admit(pass, token.content, place);
    token.type = 'math_block';
    token.meta = { place };
  }
}

// --- typesetting ---------------------------------------------------------------------------------

const KATEX_OPENING = '<span class="katex">';
const KATEX_HIDDEN = '<span class="katex-html" aria-hidden="true">';

/**
 * Typesets one formula with decision 7's options; throws a `MarkdownSyntaxError` with the line
 * where it fails, and once the formulas' HTML is past the render's output limit.
 */
function typeset(
  pass: MathPass,
  token: Token,
  display: boolean,
  escape: (text: string) => string,
): string {
  const tex = token.content;
  if (!tex.trim()) return '';
  const place = (token.meta as { place: Place }).place;
  const untrusted: string[] = [];
  let html: string;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      output: 'html',
      throwOnError: true,
      strict: 'ignore',
      // what KaTeX would print in red instead, a link or a picture, fails below
      trust: (context) => {
        untrusted.push(context.command);
        return false;
      },
      maxExpand: 1000,
      maxSize: 10,
      macros: pass.macros,
    });
  } catch (e) {
    if (e instanceof katex.ParseError) {
      const line = lineOf(place, tex, e.position);
      throw new MarkdownSyntaxError(
        'math',
        `The formula on line ${line} does not parse: ${e.rawMessage}`,
        line,
      );
    }
    // KaTeX parses by descent, and a formula nested a few thousand deep runs out of stack
    if (e instanceof RangeError) {
      const line = lineOf(place);
      throw new MarkdownSyntaxError(
        'math',
        `The formula on line ${line} is nested too deeply to be typeset`,
        line,
      );
    }
    throw e;
  }
  if (untrusted.length) {
    const line = lineOf(place);
    throw new MarkdownSyntaxError(
      'math',
      `The formula on line ${line} uses ${untrusted[0]}, which a formula may not use`,
      line,
    );
  }
  // a formula that only defines a macro (`\gdef`) shows nothing, and has nothing to tag or name
  if (html.includes(`${KATEX_HIDDEN}</span>`)) return '';
  pass.html += html.length;
  if (pass.html > defaultLimits.outputBytes)
    throw new RenderLimitError(
      'outputBytes',
      `The document's formulas make more than ${defaultLimits.outputBytes / 1024 / 1024} MB of HTML, which is what a document may make`,
    );
  // its name, so that Chromium tags it (decision 13): the TeX, on one line
  const alt = escape(tex.replace(/\s+/g, ' ').trim());
  return html
    .replace(
      KATEX_OPENING,
      () => `<span class="katex" role="img" aria-label="${alt}">`,
    )
    .replace(KATEX_HIDDEN, () => '<span class="katex-html">');
}

/**
 * The rules and renderers of formulas, as a markdown-it plugin: the converter adds it to the parser
 * of a document that asks for math, which its host made (`RichMarkdown.math`).
 */
export function mathRules(md: Parser): void {
  // after `escape`, so `\$` is text before this rule sees a dollar, and before `backticks`
  md.inline.ruler.after('escape', 'formfeed_math', inlineRule);
  md.block.ruler.after('blockquote', 'formfeed_math', blockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.core.ruler.after('block', 'formfeed_math_fences', mathFences);
  md.core.ruler.at('inline', inlineWithLines);
  const escape = md.utils.escapeHtml;
  md.renderer.rules['math_inline'] = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    return token ? typeset(passOf(env ?? {}), token, false, escape) : '';
  };
  md.renderer.rules['math_block'] = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    const html = token ? typeset(passOf(env ?? {}), token, true, escape) : '';
    return html ? `<p class="ff-math">${html}</p>\n` : '';
  };
}
