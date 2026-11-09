import MarkdownIt from 'markdown-it';
import type {
  Env,
  MarkdownIt as Parser,
  StateBlock,
  StateCore,
  Token,
} from 'markdown-it';
import footnote from 'markdown-it-footnote';
import {
  opensWithFrontMatter,
  readFrontMatter,
  type FrontMatterMetadata,
} from './front-matter';
import {
  dropEncodedKept,
  holdsKept,
  keptPattern,
  restoreKept,
  type KeptHtml,
} from './kept';
import type { MarkdownHtmlMode } from './settings';
import { Slugger } from './slug';

/**
 * Markdown to HTML (plan 29 §5), on markdown-it 15, which step 1 measured linear on every input
 * made to be slow, with `markdown-it-footnote` and rules of our own. One parser serves the Markdown
 * source, which converts a document (`markdownToHtml`), and the `markdown` helper, which converts a
 * fragment of a template (`markdownFragment`). Every rule of ours looks at one token or one line at
 * a time: step 1's first prototype was quadratic through a single rule that scanned ahead.
 *
 * What both read: GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks) and
 * footnotes; links and pictures kept to the schemes of decision 3; a page break at a line that is
 * `\newpage`, `\pagebreak` or `<!-- pagebreak -->`; a no-break space in an empty table cell, without
 * which Chromium writes no cell and a PDF/UA-1 file fails rule 7.2-43. What only a document does:
 * front matter, the title from the first heading, heading levels closed up in the tags (the first
 * is `h1`, none more than one below the heading it stands under, the size written kept by the class
 * `ff-h<n>`), heading ids by GitHub's rule and the wrapper `<div class="ff-markdown">`.
 */

export interface MarkdownConvertOptions {
  /** Raw HTML: `safe` shows it as text, `allow` writes it as it stands (decision 3). */
  html: MarkdownHtmlMode;
  /** A single line break is a `<br>`. */
  breaks?: boolean;
  /** The helpers' HTML behind its placeholders, in a Markdown render with an engine (`kept.ts`). */
  kept?: KeptHtml;
}

export interface ConvertedMarkdown {
  /** The document inside its wrapper. */
  html: string;
  /** The text of the first heading, which names a document that has no title of its own. */
  heading?: string;
  /** What the front matter says, where it says it. */
  frontMatter: FrontMatterMetadata;
}

type Kind = 'document' | 'fragment';

/** What one conversion carries through markdown-it's rules, in its `env`. */
interface Pass {
  kind: Kind;
  kept?: KeptHtml;
  heading?: string;
}

const PASS = 'formfeed';
const passOf = (env: Env | undefined): Pass =>
  (env?.[PASS] as Pass | undefined) ?? { kind: 'fragment' };

// --- addresses (decision 3) ---------------------------------------------------------------------

const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const IMAGE_SCHEMES = new Set(['http', 'https']);
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i;

/**
 * What a browser drops from an address before it reads the scheme: control characters and spaces,
 * so that `java\tscript:` is `javascript:` to it and to us.
 */
// eslint-disable-next-line no-control-regex -- these characters are what the rule is about
const IGNORED_IN_ADDRESS = /[\x00-\x20\x7f]/g;

/** The scheme of an address as a browser reads it. */
function schemeOf(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(IGNORED_IN_ADDRESS, ''));
  return m?.[1]?.toLowerCase() ?? null;
}

/** A link keeps `http`, `https`, `mailto`, `tel`, relative addresses and `#anchors`. */
export function linkAllowed(href: string): boolean {
  if (!href) return false;
  const scheme = schemeOf(href);
  return scheme === null || LINK_SCHEMES.has(scheme);
}

/** A picture keeps `http`, `https`, relative addresses (the file library) and `data:image/` in five types. */
export function imageAllowed(src: string): boolean {
  if (!src) return false;
  const scheme = schemeOf(src);
  if (scheme === null || IMAGE_SCHEMES.has(scheme)) return true;
  return (
    scheme === 'data' && DATA_IMAGE.test(src.replace(IGNORED_IN_ADDRESS, ''))
  );
}

const NEVER = new Set(['javascript', 'vbscript', 'file']);

/**
 * What markdown-it may parse as a link or a picture at all (its `validateLink`): not a script, a
 * local file or data that is no picture, which stay the text that was written, as markdown-it leaves
 * them by default. Any other address becomes a link or a picture, and the core rule then keeps it
 * to its list, a link with another scheme keeping its text.
 */
function parseable(url: string): boolean {
  const scheme = schemeOf(url);
  if (scheme === null) return true;
  if (NEVER.has(scheme)) return false;
  return scheme !== 'data' || imageAllowed(url);
}

// --- raw HTML in `safe` (decision 3) ---------------------------------------------------------------

/** The formatting tags `safe` keeps, without attributes and with their closing tags. */
const KEPT_TAGS = 'sup|sub|kbd|mark|u|ins|del|s|small';
const BR = /^<br\s*\/?>$/i;
const KEPT_OPENING = new RegExp(`^<(${KEPT_TAGS})\\s*>$`, 'i');
const KEPT_CLOSING = new RegExp(`^<\\/(${KEPT_TAGS})\\s*>$`, 'i');
const COMMENT = /^<!--[\s\S]*-->$/;

/** What a raw inline tag of `safe` becomes; `meta.formfeed` of an `html_inline` token. */
type InlineVerdict = string | null;

/**
 * Decides every raw inline tag of one paragraph in `safe`: a `<br>` stays, a comment goes, a kept
 * formatting tag stays when it is closed again in the same paragraph, and everything else is shown as
 * text. Pairs are matched on a stack with a count per name, so an unmatched closing tag costs one
 * look and a paragraph of thousands of tags stays linear. Unclosed formatting tags would reach past
 * the paragraph: a browser opens `<u>` and `<s>` again in every block that follows.
 */
function judgeRawInline(children: Token[]): void {
  const stack: Array<{ name: string; token: Token }> = [];
  const open = new Map<string, number>();
  for (const child of children) {
    if (child.type !== 'html_inline') continue;
    const tag = child.content.trim();
    if (BR.test(tag)) {
      child.meta = { [PASS]: '<br>' };
      continue;
    }
    if (COMMENT.test(tag)) {
      child.meta = { [PASS]: '' };
      continue;
    }
    child.meta = { [PASS]: null };
    const opening = KEPT_OPENING.exec(tag)?.[1]?.toLowerCase();
    if (opening) {
      stack.push({ name: opening, token: child });
      open.set(opening, (open.get(opening) ?? 0) + 1);
      continue;
    }
    const name = KEPT_CLOSING.exec(tag)?.[1]?.toLowerCase();
    if (!name || !open.get(name)) continue;
    // what was opened inside it and not closed stays text
    for (let top = stack.pop(); top; top = stack.pop()) {
      open.set(top.name, (open.get(top.name) ?? 1) - 1);
      if (top.name !== name) continue;
      top.token.meta = { [PASS]: `<${name}>` };
      child.meta = { [PASS]: `</${name}>` };
      break;
    }
  }
}

// --- page breaks (decision 7) ----------------------------------------------------------------------

/** LaTeX's commands as LaTeX writes them; the comment in any case, as HTML reads one. */
const PAGE_BREAK_LINE =
  /^(?:\\newpage|\\pagebreak|<!--\s*[pP][aA][gG][eE][bB][rR][eE][aA][kK]\s*-->)[ \t]*$/;
const PAGE_BREAK = '<div class="page-break" style="break-after:page"></div>\n';

/**
 * A line that is `\newpage`, `\pagebreak` or `<!-- pagebreak -->`. It may end a paragraph, a quote
 * or a list without a blank line, as people write it. A block rule, so it reads its one line only.
 */
function pageBreakRule(
  state: StateBlock,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) return false;
  const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
  const end = state.eMarks[startLine] ?? start;
  const first = state.src.charCodeAt(start);
  // `\` or `<`, and no longer than the longest form with some spaces
  if ((first !== 0x5c && first !== 0x3c) || end - start > 64) return false;
  if (!PAGE_BREAK_LINE.test(state.src.slice(start, end))) return false;
  if (silent) return true;
  const token = state.push('formfeed_page_break', 'div', 0);
  token.map = [startLine, startLine + 1];
  token.block = true;
  state.line = startLine + 1;
  return true;
}

// --- one pass over the tokens -------------------------------------------------------------------------

const NBSP = String.fromCharCode(0xa0);
const TASK = /^\[([ xX])\](?=\s|$)\s*/;

/** The text of inline tokens as a reader sees it, the way GitHub reads a heading for its id. */
function plainText(
  children: Token[] | null,
  kept: KeptHtml | undefined,
  escape: (s: string) => string,
): string {
  let text = '';
  for (const child of children ?? [])
    if (child.type === 'text' || child.type === 'code_inline')
      text += child.content;
    else if (child.type === 'softbreak' || child.type === 'hardbreak')
      text += ' ';
  return restoreKept(text, kept, 'none', escape);
}

/** HTML that opens with an element a paragraph cannot hold: the `markdown` helper's, `pageBreak`'s. */
const BLOCK_HTML =
  /^\s*<(?:address|article|aside|blockquote|details|div|dl|fieldset|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|ul)\b/i;

/**
 * A paragraph that is one placeholder of block HTML and nothing else, which would otherwise put a
 * `<p>` around a `<p>` or a `<div>`. Inline HTML (an `nl2br` address, a picture, a chart's canvas)
 * stays in its paragraph.
 */
function paragraphOfOneBlock(
  inline: Token | undefined,
  kept: KeptHtml | undefined,
): boolean {
  if (
    !kept ||
    !inline ||
    inline.type !== 'inline' ||
    !holdsKept(inline.content, kept)
  )
    return false;
  const content = inline.content.trim();
  const match = keptPattern(kept.nonce).exec(content);
  if (!match || match.index !== 0 || match[0].length !== content.length)
    return false;
  return BLOCK_HTML.test(kept.html[Number(match[1])] ?? '');
}

/**
 * The rules of one conversion, as one core rule after markdown-it's own: they run once over the
 * tokens, with a stack of the open lists for task lists and one of the headings above for their
 * levels, so nothing looks back further than one token.
 */
function formfeedRules(kind: Kind, mode: MarkdownHtmlMode) {
  return (state: StateCore): void => {
    const pass = passOf(state.env);
    const kept = pass.kept;
    const escape = state.md.utils.escapeHtml;
    const tokens = state.tokens;
    const lists: Token[] = [];
    const outline: Array<{ written: number; tag: number }> = [];
    const slugger = kind === 'document' ? new Slugger() : null;
    // the rules change tokens and their children, never how many tokens there are
    for (const [i, token] of tokens.entries()) {
      switch (token.type) {
        case 'bullet_list_open':
        case 'ordered_list_open':
          lists.push(token);
          break;
        case 'bullet_list_close':
        case 'ordered_list_close':
          lists.pop();
          break;
        case 'heading_open': {
          if (!slugger) break;
          const written = Number(token.tag.slice(1));
          const text = plainText(
            tokens[i + 1]?.children ?? null,
            kept,
            escape,
          ).trim();
          if (pass.heading === undefined && text)
            pass.heading = text.replace(/\s+/g, ' ');
          while ((outline.at(-1)?.written ?? 0) >= written) outline.pop();
          const tag = Math.min(6, (outline.at(-1)?.tag ?? 0) + 1);
          outline.push({ written, tag });
          token.tag = `h${tag}`;
          const close = tokens[i + 2];
          if (close?.type === 'heading_close') close.tag = `h${tag}`;
          const id = slugger.slug(text);
          if (id) token.attrSet('id', id);
          token.attrJoin('class', `ff-h${written}`);
          break;
        }
        case 'td_open':
        case 'th_open': {
          const inline = tokens[i + 1];
          if (inline?.type === 'inline' && !inline.children?.length) {
            const space = new state.Token('text', '', 0);
            space.content = NBSP;
            inline.children = [space];
          }
          break;
        }
        case 'paragraph_open': {
          // a helper's block HTML alone on its lines is a block of its own, not text of a paragraph
          const close = tokens[i + 2];
          if (
            close?.type === 'paragraph_close' &&
            paragraphOfOneBlock(tokens[i + 1], kept)
          ) {
            token.hidden = true;
            close.hidden = true;
          }
          break;
        }
        case 'code_block':
        case 'fence':
          // code shows a helper's HTML as the text it is
          token.content = restoreKept(token.content, kept, 'html', escape);
          break;
        case 'inline': {
          // a task: the first paragraph of a list item opens with `[ ]` or `[x]`
          const item = tokens[i - 2];
          if (
            item?.type === 'list_item_open' &&
            tokens[i - 1]?.type === 'paragraph_open'
          )
            taskRule(state, token, item, lists.at(-1));
          inlineRules(state, token, mode, kept, escape);
          break;
        }
      }
    }
  };
}

/** A checkbox where the first paragraph of a list item opens with `[ ]`, `[x]` or `[X]`. */
function taskRule(
  state: StateCore,
  inline: Token,
  item: Token,
  list: Token | undefined,
): void {
  const children = inline.children;
  const first = children?.[0];
  if (!children || first?.type !== 'text') return;
  const task = TASK.exec(first.content);
  if (!task) return;
  first.content = first.content.slice(task[0].length);
  const box = new state.Token('formfeed_task', 'input', 0);
  box.meta = { checked: task[1] !== ' ' };
  children.unshift(box);
  item.attrJoin('class', 'task-list-item');
  if (list && list.attrGet('class') !== 'contains-task-list')
    list.attrJoin('class', 'contains-task-list');
}

/** Addresses, inline code and raw tags of one inline token. */
function inlineRules(
  state: StateCore,
  inline: Token,
  mode: MarkdownHtmlMode,
  kept: KeptHtml | undefined,
  escape: (s: string) => string,
): void {
  const children = inline.children;
  if (!children?.length) return;

  let changed = false;
  let droppingLink = false;
  const out: Token[] = [];
  for (const child of children) {
    if (
      child.type === 'link_open' &&
      !linkAllowed(String(child.attrGet('href') ?? ''))
    ) {
      // the link goes, its text stays
      droppingLink = changed = true;
      continue;
    }
    if (child.type === 'link_close' && droppingLink) {
      droppingLink = false;
      continue;
    }
    if (
      child.type === 'image' &&
      !imageAllowed(String(child.attrGet('src') ?? ''))
    ) {
      const alt = new state.Token('text', '', 0);
      alt.content = plainText(child.children, kept, escape);
      out.push(alt);
      changed = true;
      continue;
    }
    if (child.type === 'code_inline')
      child.content = restoreKept(child.content, kept, 'html', escape);
    out.push(child);
  }
  if (changed) inline.children = out;
  if (mode === 'safe') judgeRawInline(inline.children ?? []);
}

// --- the parsers ----------------------------------------------------------------------------------

function createParser(
  kind: Kind,
  mode: MarkdownHtmlMode,
  breaks: boolean,
): Parser {
  const md = new MarkdownIt('default', {
    html: true,
    linkify: true,
    breaks,
    typographer: false,
  });
  md.use(footnote);
  // markdown-it asks with the address it decoded and encoded; links and pictures part afterwards
  md.validateLink = parseable;
  md.block.ruler.before('html_block', 'formfeed_page_break', pageBreakRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.core.ruler.push('formfeed', formfeedRules(kind, mode));

  const escape = md.utils.escapeHtml;
  const rules = md.renderer.rules;
  rules['formfeed_page_break'] = () => PAGE_BREAK;
  rules['formfeed_task'] = (tokens, idx) =>
    tokens[idx]?.meta?.['checked']
      ? '<input type="checkbox" disabled checked> '
      : '<input type="checkbox" disabled> ';
  rules['text'] = (tokens, idx, _options, env) =>
    restoreKept(
      escape(tokens[idx]?.content ?? ''),
      passOf(env).kept,
      'html',
      escape,
    );
  rules['html_inline'] = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    if (!token) return '';
    const kept = passOf(env).kept;
    if (mode === 'allow')
      return restoreKept(token.content, kept, 'html', escape);
    const verdict = token.meta?.[PASS] as InlineVerdict | undefined;
    if (typeof verdict === 'string') return verdict;
    return restoreKept(escape(token.content), kept, 'html', escape);
  };
  rules['html_block'] = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    if (!token) return '';
    const kept = passOf(env).kept;
    if (mode === 'allow')
      return restoreKept(token.content, kept, 'html', escape);
    const block = token.content.trim();
    if (COMMENT.test(block)) return '';
    if (BR.test(block)) return '<br>\n';
    const shown = escape(token.content.replace(/\n+$/, '')).replace(
      /\n/g,
      '<br>\n',
    );
    return `<p class="ff-raw">${restoreKept(shown, kept, 'html', escape)}</p>\n`;
  };
  return md;
}

const parsers = new Map<string, Parser>();

/** One parser per kind, mode and line-break option, made once: the rules keep nothing between calls. */
function parserFor(
  kind: Kind,
  mode: MarkdownHtmlMode,
  breaks: boolean,
): Parser {
  const key = `${kind}:${mode}:${breaks}`;
  let md = parsers.get(key);
  if (!md) parsers.set(key, (md = createParser(kind, mode, breaks)));
  return md;
}

/** What is left of the placeholders after rendering stands in attributes, where it is text. */
function finish(
  html: string,
  kept: KeptHtml | undefined,
  escape: (s: string) => string,
): string {
  return dropEncodedKept(restoreKept(html, kept, 'text', escape), kept);
}

/** FNV-1a, so that footnotes of two fragments in one document get ids of their own. */
function fragmentId(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const ENTITY =
  /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** HTML's character references decoded, as Markdown decodes them in text; nothing else changes. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  const { unescapeAll } = parserFor('fragment', 'safe', false).utils;
  return text.replace(ENTITY, (entity) => unescapeAll(entity));
}

/**
 * The front matter's values as the PDF's metadata takes them: entities decoded, so a value the engine
 * escaped reads as written, and placeholders removed.
 */
function metadataText(
  metadata: FrontMatterMetadata,
  kept: KeptHtml | undefined,
  escape: (s: string) => string,
): FrontMatterMetadata {
  const out: FrontMatterMetadata = {};
  for (const [key, value] of Object.entries(metadata) as Array<
    [keyof FrontMatterMetadata, string]
  >) {
    const text = restoreKept(
      decodeEntities(value),
      kept,
      'none',
      escape,
    ).trim();
    if (text) out[key] = text;
  }
  return out;
}

/**
 * Converts a Markdown document (plan 29 §5): the HTML in its wrapper, the first heading's text and
 * what the front matter says. Asynchronous because the `yaml` package loads only for a document that
 * opens with front matter.
 */
export async function markdownToHtml(
  text: string,
  options: MarkdownConvertOptions,
): Promise<ConvertedMarkdown> {
  const md = parserFor('document', options.html, options.breaks === true);
  let body = text;
  let frontMatter: FrontMatterMetadata = {};
  if (opensWithFrontMatter(text)) {
    const read = await readFrontMatter(text);
    if (read) {
      body = read.body;
      frontMatter = metadataText(
        read.metadata,
        options.kept,
        md.utils.escapeHtml,
      );
    }
  }
  const pass: Pass = { kind: 'document', kept: options.kept };
  const inner = finish(
    md.render(body, { [PASS]: pass }),
    options.kept,
    md.utils.escapeHtml,
  );
  return {
    html: `<div class="ff-markdown">\n${inner}</div>\n`,
    heading: pass.heading,
    frontMatter,
  };
}

/**
 * Converts the Markdown of a template value (the `markdown` helper): no front matter, title, closed
 * up levels, ids or wrapper, which belong to a document.
 */
export function markdownFragment(
  text: string,
  options: MarkdownConvertOptions,
): string {
  const md = parserFor('fragment', options.html, options.breaks === true);
  const env: Env = {
    [PASS]: { kind: 'fragment', kept: options.kept } satisfies Pass,
  };
  if (text.includes('[^')) env['docId'] = fragmentId(text);
  return finish(md.render(text, env), options.kept, md.utils.escapeHtml);
}
