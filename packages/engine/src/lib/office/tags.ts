import { placeholderPattern, type TemplateSource } from './template-text';

/**
 * Normalising the tags Word leaves behind (spec 22 §4.3 step 4).
 *
 * Word splits typed text into several runs — spell-check marks, revision ids, a changed font — so
 * `{{ customer.name }}` often sits in three `<w:r>` elements, and the template source that comes out
 * of `toTemplateSource` has markup placeholders inside the tag. Here a tag's characters move into the
 * run where the tag starts (which keeps that run's formatting) by dropping the run boundaries in
 * between, and Word's autocorrect inside the tag is undone, because `{{ date(x, "short") }}` becomes
 * curly quotes as the customer types and would otherwise be a syntax error nobody can see.
 *
 * A tag that crosses a paragraph, a hyperlink, a content control, a field or a tracked change is not
 * merged: moving the text would move it out of its element. It reports `office-tag-spans-elements`.
 */

export type OfficeDiagnosticCode =
  | 'office-tag-spans-elements'
  | 'office-tag-autocorrected'
  | 'office-tag-in-field'
  | 'office-block-unbalanced'
  | 'office-reference-in-loop'
  | 'office-font-substituted'
  | 'unsupported-in-office';

export interface OfficeDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: OfficeDiagnosticCode;
  message: string;
  /** Part the diagnostic belongs to, `word/document.xml`. */
  part: string;
  /** 1-based paragraph in that part, as the editor lists it. */
  paragraph: number;
  /** The tag as it reads after normalisation, for the message. */
  text: string;
}

export interface NormalisedTags {
  template: TemplateSource;
  diagnostics: OfficeDiagnostic[];
}

/** Opening and closing delimiters of the three engines; `{#` is Jinja2's comment. */
const OPENERS = ['{{', '{%', '{#'] as const;
const CLOSERS: Record<string, string> = { '{{': '}}', '{%': '%}', '{#': '#}' };

const AUTOCORRECTED: Array<[RegExp, string]> = [
  [/[“”„‟″]/g, '"'],
  [/[‘’‚‛′]/g, "'"],
  [/…/g, '...'],
  [/[–—]/g, '-'],
  [/[\u00A0\u202F\u2007]/g, ' '],
  [/\u200B|\u200C|\u200D|\uFEFF/g, ''],
];

export function normaliseTags(template: TemplateSource, part: string): NormalisedTags {
  const { text, origin, placeholders } = stripPlaceholders(template);
  /** Where a span of `text` sits in the source. */
  const sourceRange = (from: number, to: number): [number, number] => [
    origin[from] ?? template.source.length,
    (origin[to - 1] ?? template.source.length - 1) + 1,
  ];

  const diagnostics: OfficeDiagnostic[] = [];
  // Edits over the source: a dropped run boundary, or a tag rewritten without Word's autocorrect.
  const edits: Array<{ from: number; to: number; text: string }> = [];

  for (const tag of findTags(text)) {
    const inside = placeholders.filter((p) => p.at > tag.start && p.at < tag.end);
    const paragraph = paragraphOf(template, placeholders, tag.start);
    const raw = text.slice(tag.start, tag.end);
    const unsafe = inside.filter((p) => {
      const piece = template.markup[p.index];
      return !piece || piece.paragraphBoundary || piece.containerBoundary;
    });
    if (unsafe.length) {
      diagnostics.push({
        severity: 'error',
        code: 'office-tag-spans-elements',
        message: `The tag ${short(raw)} is split across a paragraph, a link, a field or a tracked change. Retype it in one go.`,
        part,
        paragraph,
        text: short(raw),
      });
      continue;
    }
    const corrected = undoAutocorrect(raw);
    if (inside.length || corrected !== raw) {
      // One edit for the whole tag: the corrected text without the run boundaries inside it.
      const [from, to] = sourceRange(tag.start, tag.end);
      edits.push({ from, to, text: corrected });
    }
    if (corrected !== raw) {
      diagnostics.push({
        severity: 'info',
        code: 'office-tag-autocorrected',
        message: `Word's autocorrect changed quotes or spaces in ${short(corrected)}; they were read as typed.`,
        part,
        paragraph,
        text: short(corrected),
      });
    }
  }

  // Field codes are markup, never template text: a tag typed there stays as it is (spec 22 §4.3 step 3).
  const reported = new Set<number>();
  for (const p of placeholders) {
    const raw = template.markup[p.index]?.raw ?? '';
    for (const m of raw.matchAll(/<w:instrText\b[^>]*>([^<]*)<\/w:instrText>/g)) {
      const code = decodeEntities(m[1] ?? '');
      if (!/\{\{|\{%|\{#/.test(code)) continue;
      const paragraph = paragraphOf(template, placeholders, p.at);
      if (reported.has(paragraph)) continue;
      reported.add(paragraph);
      diagnostics.push({
        severity: 'warning',
        code: 'office-tag-in-field',
        message: `The field code ${short(code.trim())} contains a tag, which stays as typed: fields are not filled. Put the tag in the document text instead.`,
        part,
        paragraph,
        text: short(code.trim()),
      });
    }
  }

  return { template: { ...template, source: applyEdits(template.source, edits) }, diagnostics };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

interface Placeholder {
  index: number;
  /** Position in the text without placeholders. */
  at: number;
  /** Its span in the template source. */
  from: number;
  to: number;
}

/** The source's text without placeholders, where each character came from, and the placeholders. */
function stripPlaceholders(template: TemplateSource): { text: string; origin: number[]; placeholders: Placeholder[] } {
  const pattern = placeholderPattern(template.nonce);
  let text = '';
  const origin: number[] = [];
  const placeholders: Placeholder[] = [];
  let last = 0;
  for (const m of template.source.matchAll(pattern)) {
    for (let i = last; i < (m.index ?? 0); i++) {
      text += template.source[i];
      origin.push(i);
    }
    placeholders.push({ index: Number(m[1]), at: text.length, from: m.index ?? 0, to: (m.index ?? 0) + m[0].length });
    last = (m.index ?? 0) + m[0].length;
  }
  for (let i = last; i < template.source.length; i++) {
    text += template.source[i];
    origin.push(i);
  }
  return { text, origin, placeholders };
}

/** A tag as the office template page lists it (spec 22 §6). */
export interface OfficeTag {
  part: string;
  paragraph: number;
  /** The tag as the engine reads it, on one line. */
  text: string;
  /** `output` for `{{ }}`, `block` for `{% %}` and Handlebars blocks, `comment` for `{# #}`. */
  kind: 'output' | 'block' | 'comment';
}

/** Every tag of a (normalised) part with its paragraph. */
export function listTags(template: TemplateSource, part: string): OfficeTag[] {
  const { text, placeholders } = stripPlaceholders(template);
  return findTags(text).map((tag) => {
    const raw = text.slice(tag.start, tag.end);
    const kind = raw.startsWith('{#') ? 'comment' : raw.startsWith('{%') || /^\{\{~?\s*[#/^]/.test(raw) || /^\{\{~?\s*else\b/.test(raw) ? 'block' : 'output';
    return { part, paragraph: paragraphOf(template, placeholders, tag.start), text: raw.replace(/\s+/g, ' ').trim(), kind };
  });
}

/** The 1-based paragraph an offset of the template source sits in (engine diagnostics). */
export function paragraphAtSource(template: TemplateSource, offset: number): number {
  const { origin, placeholders } = stripPlaceholders(template);
  // the text position of the first character at or after the offset
  let at = origin.findIndex((o) => o >= offset);
  if (at === -1) at = origin.length;
  return paragraphOf(template, placeholders, at);
}

/** Applies non-overlapping edits, last first, so earlier offsets stay valid. */
function applyEdits(source: string, edits: Array<{ from: number; to: number; text: string }>): string {
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
  return out;
}

/** Undoes what Word's autocorrect does to a tag while it is typed. */
export function undoAutocorrect(tag: string): string {
  let out = tag;
  for (const [pattern, replacement] of AUTOCORRECTED) out = out.replace(pattern, replacement);
  return out;
}

/** Tags in text, delimiters included; unclosed openers are ignored (the engine reports them). */
export function findTags(text: string): Array<{ start: number; end: number }> {
  const tags: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < text.length - 1; i++) {
    const opener = OPENERS.find((o) => text.startsWith(o, i));
    if (!opener) continue;
    const closer = CLOSERS[opener]!;
    const end = text.indexOf(closer, i + opener.length);
    if (end === -1) continue;
    // Handlebars' triple stash and Liquid's `}}}` close one character later.
    const stop = end + closer.length + (opener === '{{' && text[end + closer.length] === '}' ? 1 : 0);
    tags.push({ start: i, end: stop });
    i = stop - 1;
  }
  return tags;
}

/** 1-based paragraph the position sits in: every paragraph that opened before it. */
function paragraphOf(template: TemplateSource, placeholders: Array<{ index: number; at: number }>, at: number): number {
  let paragraphs = 0;
  for (const p of placeholders) {
    if (p.at > at) break;
    paragraphs += template.markup[p.index]?.paragraphOpens ?? 0;
  }
  return Math.max(1, paragraphs);
}

function short(tag: string): string {
  const oneLine = tag.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}
