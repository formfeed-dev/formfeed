import {
  lineStarts,
  locate,
  rawTextElements,
  Scanner,
  tagName,
} from '../source-scan';
import type { EngineId } from '../types';
import {
  AUDIT_SEVERITY,
  AUDIT_SNIPPET_LENGTH,
  auditMessage,
  type AuditCode,
  type AuditFinding,
  type UaOptions,
} from './index';

/**
 * The half of the audit that needs no rendered page (plan 21 §6): what a template's source and
 * settings already say. `formfeed validate`, the MCP server's validation and the editor report it
 * before any preview has run: a document without a title, and an image written without `alt`.
 * Everything else depends on what the data makes of the template and is the frame script's.
 *
 * A finding names its place as a preview would (`body:<line>:<column>`), so the editor shows one
 * problem where both halves found the same tag.
 */
export interface StaticAuditInput {
  engine: EngineId;
  /** The body template. */
  html: string;
  /** The template's head, where a `<title>` may stand. */
  head?: string;
  /** `pdf.metadata.title` of the settings. */
  title?: string | null;
}

const finding = (
  code: AuditCode,
  src: string | null,
  snippet: string,
): AuditFinding => ({
  code,
  severity: AUDIT_SEVERITY[code],
  src,
  snippet,
  args: {},
});

/** Attributes that give an image a name or take it out of the reading. */
const NAMING = new Set(['alt', 'aria-label', 'aria-labelledby', 'title']);

/**
 * What an `<img>` tag says about its text. `null` where the tag's attributes are built by template
 * syntax (`<img {{ attrs }}>`): the source cannot say, and the rendered page will.
 */
function imageIsNamed(
  attributes: string,
  scanner: Scanner,
  base: number,
): boolean | null {
  const n = attributes.length;
  let i = 0;
  let named = false;
  while (i < n) {
    const ch = attributes[i]!;
    if (/[\s/>]/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '{' && scanner.skipTemplate(base + i) !== null) return null;
    const start = i;
    while (i < n && !/[\s=/>]/.test(attributes[i]!)) i++;
    const name = attributes.slice(start, i).toLowerCase();
    while (i < n && /\s/.test(attributes[i]!)) i++;
    let value = '';
    if (attributes[i] === '=') {
      i++;
      while (i < n && /\s/.test(attributes[i]!)) i++;
      const quote = attributes[i];
      if (quote === '"' || quote === "'") {
        const end = scanner.skipTo(base + i + 1, quote) - base;
        value = attributes.slice(i + 1, Math.max(i + 1, end - 1));
        i = end;
      } else {
        const from = i;
        while (i < n && !/[\s>]/.test(attributes[i]!)) i++;
        value = attributes.slice(from, i);
      }
    }
    if (NAMING.has(name)) named = true;
    else if (name === 'aria-hidden' && value.trim() !== 'false') named = true;
    else if (name === 'role' && /^(presentation|none)$/.test(value.trim()))
      named = true;
  }
  return named;
}

/** A static finding as the lists outside the editor show it. */
export interface StaticAuditDiagnostic {
  severity: 'error' | 'warning';
  /** `accessibility-<code>` of the finding. */
  code: string;
  message: string;
  /** Where in the body template; absent for a finding about the document as a whole (its title). */
  location?: { line: number; column: number };
}

/**
 * The static findings of a template that declares `pdf.ua`, for the callers that list a template's
 * problems without a preview: `formfeed validate` and the API's template validation. A fault the
 * validator fails the file for is an error where the declaration is strict, since every render of
 * the template then fails for it, and a warning where it only reports.
 */
export function staticAuditDiagnostics(
  input: StaticAuditInput,
  ua: UaOptions,
): StaticAuditDiagnostic[] {
  return staticAudit(input).map((found) => {
    const at = /^body:(\d+):(\d+)$/.exec(found.src ?? '');
    return {
      severity:
        found.severity === 'error' && ua.check === 'strict'
          ? 'error'
          : 'warning',
      code: `accessibility-${found.code}`,
      message: auditMessage(found),
      ...(at
        ? { location: { line: Number(at[1]), column: Number(at[2]) } }
        : {}),
    };
  });
}

export function staticAudit(input: StaticAuditInput): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (!input.title?.trim() && !/<title[\s>]/i.test(input.head ?? ''))
    findings.push(finding('document-title', null, ''));

  const source = input.html;
  const scanner = new Scanner(source, input.engine);
  const lines = lineStarts(source);
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
    const next = source[i + 1];
    if (next === '!' || next === '?') {
      i = scanner.tagEnd(i + 2);
      continue;
    }
    if (next === '/') {
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
    if (name.toLowerCase() === 'img') {
      const named = imageIsNamed(source.slice(nameEnd, end), scanner, nameEnd);
      if (named === false) {
        const { line, column } = locate(lines, i);
        const tag = source.slice(i, end).replace(/\s+/g, ' ');
        findings.push(
          finding(
            'image-alt',
            `body:${line}:${column}`,
            tag.length > AUDIT_SNIPPET_LENGTH
              ? `${tag.slice(0, AUDIT_SNIPPET_LENGTH - 1)}…`
              : tag,
          ),
        );
      }
    }
    i = end;
    if (rawTextElements.has(name.toLowerCase()) && source[end - 1] === '>')
      i = scanner.skipToClosingTag(end, name);
  }
  return findings;
}
