import { editableRegionAt } from './source-edit';
import {
  lineStarts,
  locate,
  rawTextElements,
  Scanner,
  tagName,
} from './source-scan';
import type { EngineId } from './types';

/**
 * Click-to-source for the editor's previews (spec 06 §3): every HTML start tag written literally in
 * the template source gets `data-ff-src="<file>:<line>:<column>"` right after its tag name, so the
 * rendered element says where it came from instead of the editor searching the template for it.
 * Elements from a loop all point at the loop body, which is the line that wrote them.
 *
 * With `editable`, a start tag whose content is a region the preview can edit (plan 16 §3.1,
 * `editableRegionAt`) also gets `data-ff-edit="text"`, or `data-ff-edit="t"` when its whole content
 * is one `t()` call.
 *
 * The annotation must never change what the template means: tags inside template syntax, in
 * blocks whose output is captured or filtered as a string (`{% set %}…{% endset %}`, `{% filter %}`,
 * `{% capture %}`), in raw and comment blocks, in `<script>`/`<style>`/`<textarea>`/`<title>` and
 * HTML comments, closing tags, declarations, tags whose name is built by template syntax and tags
 * that already carry the attribute stay untouched. Removing the attributes from the rendered output
 * gives the document of the original source. Preview only: saved versions, API renders and the
 * render-worker never see them.
 */
export type SourceFile = 'body' | 'header' | 'footer';

export const sourceAttribute = 'data-ff-src';
export const editAttribute = 'data-ff-edit';

export interface SourceLocation {
  file: SourceFile;
  /** 1-based, as Monaco counts. */
  line: number;
  /** 1-based UTF-16 column of the tag's `<`. */
  column: number;
}

export interface AnnotateOptions {
  /** Mark editable regions with `data-ff-edit` as well (the preview's edit mode). */
  editable?: boolean;
}

/** Parses a `data-ff-src` value; null when it is not one. */
export function parseSourceAttribute(
  value: string | null | undefined,
): SourceLocation | null {
  const match = /^(body|header|footer):(\d+):(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const line = Number(match[2]);
  const column = Number(match[3]);
  if (line < 1 || column < 1) return null;
  return { file: match[1] as SourceFile, line, column };
}

export function annotateSourcePositions(
  source: string,
  engine: EngineId,
  file: SourceFile,
  options: AnnotateOptions = {},
): string {
  const scanner = new Scanner(source, engine);
  const lines = lineStarts(source);
  const out: string[] = [];
  let copied = 0;
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '{') {
      i = scanner.skipTemplate(i) ?? i + 1;
      continue;
    }
    if (ch !== '<') {
      i++;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      i = scanner.skipTo(i + 4, '-->');
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      i = scanner.skipTo(i + 9, ']]>');
      continue;
    }
    const next = source[i + 1];
    if (next === '!' || next === '?') {
      i = scanner.tagEnd(i + 2);
      continue;
    }
    if (next === '/') {
      // a closing tag: nothing to annotate, its name is plain text
      i += 2;
      continue;
    }
    tagName.lastIndex = i + 1;
    const name = tagName.exec(source)?.[0];
    if (!name) {
      i++;
      continue;
    }
    const nameEnd = i + 1 + name.length;
    const end = scanner.tagEnd(nameEnd);
    const after = source[nameEnd];
    // `<h{{ level }}>` builds its name with template syntax: there is no safe place to insert
    const plainName =
      after === undefined || after === '>' || after === '/' || /\s/.test(after);
    if (
      plainName &&
      !source.slice(nameEnd, end).toLowerCase().includes(sourceAttribute)
    ) {
      const { line, column } = locate(lines, i);
      const region = options.editable
        ? editableRegionAt(source, engine, i)
        : null;
      const edit =
        region && !('reason' in region)
          ? ` ${editAttribute}="${region.kind}"`
          : '';
      out.push(
        source.slice(copied, nameEnd),
        ` ${sourceAttribute}="${file}:${line}:${column}"${edit}`,
      );
      copied = nameEnd;
    }
    i = end;
    if (rawTextElements.has(name.toLowerCase()) && source[end - 1] === '>')
      i = scanner.skipToClosingTag(end, name);
  }
  out.push(source.slice(copied));
  return out.join('');
}
