import { notesFor, type ImportNote } from './common';

/**
 * SCSS → CSS for imported stylesheets (PDFMonkey stores "CSS or SCSS"). Formfeed styles are CSS,
 * and the engine must stay free of a Sass compiler, so the caller may pass one (`compile`): the app
 * loads `sass` on demand, the CLI when it is installed. Without it, the plain-CSS subset that most
 * stylesheets use is converted here: `//` comment lines go, top-level `$variables` are substituted,
 * and everything that needs a real compiler (mixins, functions, control flow) is reported with its
 * line. Nested rules are left as they are: Chromium renders CSS nesting natively.
 */
export interface ScssResult {
  css: string;
  warnings: ImportNote[];
  changes: string[];
}

const DOCS = '/migrate/pdfmonkey#styles';

const needsCompiler: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /@(mixin|include)\b/, what: '@mixin/@include' },
  { pattern: /@extend\b/, what: '@extend' },
  { pattern: /@(if|else|each|for|while|function|return)\b/, what: 'SCSS control flow and functions' },
  { pattern: /@(use|forward)\b/, what: '@use/@forward' },
  { pattern: /(^|[\s,{])%[a-zA-Z_][\w-]*\s*\{/m, what: '%placeholder selectors' },
  { pattern: /\b(darken|lighten|saturate|desaturate|adjust-hue|mix|transparentize|opacify|fade-in|fade-out|percentage|map-get|nth)\s*\(/, what: 'Sass colour and map functions' },
  { pattern: /#\{/, what: 'interpolation #{…}' },
];

/** True when the stylesheet uses anything beyond CSS (nesting aside, which CSS has too). */
export function isScss(source: string): boolean {
  return /(^|[^\w-])\$[a-zA-Z_][\w-]*\s*:/m.test(source) || /^\s*\/\//m.test(source) || needsCompiler.some((r) => r.pattern.test(source));
}

/** Top-level `$name: value;` declarations, outside every block. */
function topLevelVariables(source: string): Map<string, string> {
  const vars = new Map<string, string>();
  let depth = 0;
  let statement = '';
  for (const ch of source) {
    if (ch === '{') {
      depth++;
      statement = '';
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      statement = '';
    } else if (ch === ';' && depth === 0) {
      const m = /^\s*\$([a-zA-Z_][\w-]*)\s*:\s*([\s\S]+?)\s*(!default)?\s*$/.exec(statement);
      if (m && m[1] && m[2]) vars.set(m[1], m[2]);
      statement = '';
    } else statement += ch;
  }
  return vars;
}

export function convertScss(source: string, compile?: (source: string) => string): ScssResult {
  const warnings: ImportNote[] = [];
  const changes: string[] = [];
  if (!source.trim() || !isScss(source)) return { css: source, warnings, changes };

  if (compile) {
    try {
      const css = compile(source);
      changes.push('SCSS compiled to CSS');
      return { css, warnings, changes };
    } catch (e) {
      warnings.push({
        code: 'scss-compile',
        message: `The SCSS did not compile (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); it was converted without a compiler instead.`,
        docs: DOCS,
      });
    }
  }

  let css = source.replace(/^[ \t]*\/\/.*(\r?\n)?/gm, '');
  if (css !== source) changes.push('SCSS line comments (//) removed');

  const vars = topLevelVariables(css);
  if (vars.size) {
    css = css.replace(/(?<=^|[;{}\s])\$([a-zA-Z_][\w-]*)\s*:[^;{}]*;[ \t]*\r?\n?/gm, (m, name: string) => (vars.has(name) ? '' : m));
    // longest names first, so `$primary-dark` is not replaced as `$primary` + `-dark`
    const names = [...vars.keys()].sort((a, b) => b.length - a.length);
    for (let pass = 0; pass < 5; pass++) {
      const before = css;
      for (const name of names) css = css.replace(new RegExp(`\\$${name}(?![\\w-])`, 'g'), vars.get(name) ?? '');
      if (css === before) break;
    }
    changes.push(`SCSS variables substituted: ${names.map((n) => `$${n}`).join(', ')}`);
  }

  for (const rule of needsCompiler)
    warnings.push(
      ...notesFor(css, rule.pattern, {
        code: 'scss-needs-compiler',
        message: `The stylesheet uses ${rule.what}, which only a Sass compiler resolves; convert it to CSS by hand or import with the Formfeed app, which compiles SCSS.`,
        docs: DOCS,
      }, { once: true }),
    );
  warnings.push(
    ...notesFor(css, /\$[a-zA-Z_][\w-]*/, {
      code: 'scss-variable',
      message: 'A SCSS variable that is not declared at the top level was left in place; replace it with its value or a CSS custom property.',
      docs: DOCS,
    }, { once: true }),
  );
  return { css, warnings, changes };
}
