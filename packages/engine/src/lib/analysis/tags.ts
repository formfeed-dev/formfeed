import type {
  BlockRef,
  Diagnostic,
  Position,
  Range,
  VariableRef,
} from '../types';

/** Builds a range from a 1-based start position and a length on the same line. */
export function rangeAt(line: number, column: number, length: number): Range {
  return {
    start: { line, column },
    end: { line, column: column + Math.max(1, length) },
  };
}

/** Converts a 0-based offset into a 1-based position. */
export function positionOf(source: string, offset: number): Position {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}

export function rangeOf(source: string, start: number, end: number): Range {
  return { start: positionOf(source, start), end: positionOf(source, end) };
}

interface TagSpec {
  /** Regex over the whole source; group 1 = tag keyword, group 2 = the rest of the tag. */
  pattern: RegExp;
  openers: Record<string, BlockRef['type']>;
  /** Closing keyword → opening keyword. */
  closers: Record<string, string>;
  /** Keywords that continue a block without opening or closing one. */
  continuations: string[];
}

export const jinjaTags: TagSpec = {
  pattern: /\{%-?\s*(\w+)([\s\S]*?)-?%\}/g,
  openers: {
    for: 'for',
    if: 'if',
    block: 'block',
    raw: 'raw',
    macro: 'macro',
    set: 'other',
    call: 'other',
    filter: 'other',
    autoescape: 'other',
    verbatim: 'raw',
  },
  closers: {
    endfor: 'for',
    endif: 'if',
    endblock: 'block',
    endraw: 'raw',
    endmacro: 'macro',
    endset: 'set',
    endcall: 'call',
    endfilter: 'filter',
    endautoescape: 'autoescape',
    endverbatim: 'verbatim',
  },
  continuations: ['elif', 'else'],
};

export const liquidTags: TagSpec = {
  pattern: /\{%-?\s*(\w+)([\s\S]*?)-?%\}/g,
  openers: {
    for: 'for',
    if: 'if',
    unless: 'if',
    case: 'if',
    raw: 'raw',
    capture: 'other',
    tablerow: 'for',
    comment: 'other',
  },
  closers: {
    endfor: 'for',
    endif: 'if',
    endunless: 'unless',
    endcase: 'case',
    endraw: 'raw',
    endcapture: 'capture',
    endtablerow: 'tablerow',
    endcomment: 'comment',
  },
  continuations: ['elsif', 'else', 'when'],
};

/**
 * Pairs opening and closing block tags by text scan. Works even when the parser bails out on the
 * first error, so the editor gets every mismatch at once (spec 05 §3).
 */
export function scanBlocks(
  source: string,
  spec: TagSpec,
): { blocks: BlockRef[]; diagnostics: Diagnostic[] } {
  const blocks: BlockRef[] = [];
  const diagnostics: Diagnostic[] = [];
  const stack: Array<{ keyword: string; block: BlockRef }> = [];
  const pattern = new RegExp(spec.pattern.source, 'g');
  let m: RegExpExecArray | null;
  let inRaw: string | null = null;
  // `set` is a block only in its `{% set x %}...{% endset %}` form; `{% set x = 1 %}` is not.
  const isBlockOpener = (keyword: string, rest: string) =>
    keyword === 'set' ? !rest.includes('=') : keyword in spec.openers;
  while ((m = pattern.exec(source))) {
    const keyword = m[1] ?? '';
    const rest = m[2] ?? '';
    const range = rangeOf(source, m.index, m.index + m[0].length);
    if (inRaw) {
      if (spec.closers[keyword] === inRaw) {
        const open = stack.pop();
        if (open) open.block.close = range;
        inRaw = null;
      }
      continue;
    }
    if (isBlockOpener(keyword, rest)) {
      const block: BlockRef = {
        type: spec.openers[keyword] ?? 'other',
        open: range,
      };
      blocks.push(block);
      stack.push({ keyword, block });
      if (block.type === 'raw' || keyword === 'comment') inRaw = keyword;
    } else if (keyword in spec.closers) {
      const expected = spec.closers[keyword];
      const top = stack.at(-1);
      if (!top) {
        diagnostics.push({
          severity: 'error',
          code: 'unexpected-end-tag',
          message: `Unexpected {% ${keyword} %} without an open block`,
          range,
        });
      } else if (top.keyword !== expected) {
        diagnostics.push({
          severity: 'error',
          code: 'mismatched-end-tag',
          message: `Expected {% end${top.keyword} %} to close the {% ${top.keyword} %} at line ${top.block.open.start.line}, found {% ${keyword} %}`,
          range,
        });
        // recover: close the nearest matching opener if there is one
        const idx = stack.map((s) => s.keyword).lastIndexOf(expected);
        if (idx >= 0) {
          const closed = stack.splice(idx, 1)[0];
          if (closed) closed.block.close = range;
        }
      } else {
        stack.pop();
        top.block.close = range;
      }
    } else if (spec.continuations.includes(keyword) && !stack.length) {
      diagnostics.push({
        severity: 'error',
        code: 'unexpected-tag',
        message: `{% ${keyword} %} outside of a block`,
        range,
      });
    }
  }
  for (const open of stack) {
    diagnostics.push({
      severity: 'error',
      code: 'unclosed-block',
      message: `{% ${open.keyword} %} is never closed; add {% end${open.keyword} %}`,
      range: open.block.open,
    });
  }
  return { blocks, diagnostics };
}

// --- sample-data checks ----------------------------------------------------------------------

/** Looks a path up in sample data; arrays are traversed by union of their items' keys. */
export function resolvePath(
  data: unknown,
  path: string[],
): { found: boolean; value: unknown } {
  let current: unknown = data;
  for (const key of path) {
    if (Array.isArray(current)) {
      if (/^\d+$/.test(key)) {
        current = current[Number(key)];
        continue;
      }
      // a loop item: search any element that has the key
      const hit = current.find(
        (item) => item && typeof item === 'object' && key in (item as object),
      );
      if (!hit) return { found: false, value: undefined };
      current = (hit as Record<string, unknown>)[key];
      continue;
    }
    if (current && typeof current === 'object' && key in (current as object)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

/**
 * Warns for `read` variables whose path is missing from the sample data. Loop variables are
 * resolved through their source (`for line in invoice.lines` → `invoice.lines[]`) when known.
 */
export function missingPathDiagnostics(
  variables: VariableRef[],
  sampleData: unknown,
  loopSources: Map<string, string[] | null>,
  builtinRoots: Set<string>,
): Diagnostic[] {
  if (
    sampleData === undefined ||
    sampleData === null ||
    typeof sampleData !== 'object'
  )
    return [];
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const v of variables) {
    if (v.kind === 'assigned') continue;
    const root = v.path[0];
    if (!root || builtinRoots.has(root)) continue;
    let path = v.path;
    if (loopSources.has(root)) {
      const source = loopSources.get(root);
      if (!source) continue; // loop over an unknown expression: nothing to check against
      path = [...source, ...v.path.slice(1)];
    }
    const key = path.join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    if (!resolvePath(sampleData, path).found) {
      out.push({
        severity: 'warning',
        code: 'unknown-variable',
        message: `"${v.path.join('.')}" is not present in the sample data`,
        range: v.range,
      });
    }
  }
  return out;
}
