// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- the typings of highlight.js's core must reach the render-worker, which imports this module by its path
/// <reference path="./highlight.d.ts" />
/**
 * Code in a Markdown document, coloured by highlight.js 11 (plan 33, decisions 2 and 3): synchronous,
 * without a DOM, and writing classes (`hljs-keyword`) that the `document` theme colours and
 * `settings.markdown.css` can colour otherwise. A fence is coloured when it names one of the
 * languages below by its name or an alias; no language, or one not listed, prints plain, and nothing
 * is guessed, because detection guesses wrong on short code and costs a pass per language.
 *
 * Three caps, from step 1 (§3), each counted in the order of the document so that the same text
 * always prints the same: a block over `highlightBlockBytes`, and a block with a line over
 * `highlightLineLength` characters, print plain, since the `markdown` and `yaml` grammars are
 * quadratic within a line; and a document colours its first `highlightBytes` of code, after which
 * every block prints plain.
 */
import type { LanguageFn } from 'highlight.js';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import objectivec from 'highlight.js/lib/languages/objectivec';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import phpTemplate from 'highlight.js/lib/languages/php-template';
import python from 'highlight.js/lib/languages/python';
import pythonRepl from 'highlight.js/lib/languages/python-repl';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import vbnet from 'highlight.js/lib/languages/vbnet';
import wasm from 'highlight.js/lib/languages/wasm';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { CodeHighlighter } from '../convert';
import { MARKDOWN_LIMITS, utf8Bytes } from '../settings';

/**
 * highlight.js's common set without `plaintext`, which has no colours to give, and with `dockerfile`
 * and `nginx`. Step 1 held every one of them to sixteen shapes of slow input; a language added here
 * needs the same (`code.slow.spec.ts`).
 */
const LANGUAGES: Readonly<Record<string, LanguageFn>> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  nginx,
  objectivec,
  perl,
  php,
  'php-template': phpTemplate,
  python,
  'python-repl': pythonRepl,
  r,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  vbnet,
  wasm,
  xml,
  yaml,
};

/** An instance of its own, so nothing else in the process registers into it. */
const engine = hljs.newInstance();
for (const [name, language] of Object.entries(LANGUAGES))
  engine.registerLanguage(name, language);

/** Every name and alias a fence may write, in lower case, to the language it means. */
const NAMES: ReadonlyMap<string, string> = new Map(
  Object.keys(LANGUAGES).flatMap((name) => [
    [name, name],
    ...(engine.getLanguage(name)?.aliases ?? []).map(
      (alias) => [alias.toLowerCase(), name] as [string, string],
    ),
  ]),
);

/** The languages a fence may name, by highlight.js's names. */
export const HIGHLIGHT_LANGUAGES: readonly string[] = Object.keys(LANGUAGES);

/** The release that colours, as highlight.js reports it. */
export const HIGHLIGHTER_VERSION: string = engine.versionString;

/** The language a fence's name means, or `null`: only names and aliases of the list count. */
export function highlightLanguage(name: string): string | null {
  return NAMES.get(name.toLowerCase()) ?? null;
}

/** Whether a line of the text is longer than `max` characters, reading each character once. */
function hasLineLongerThan(text: string, max: number): boolean {
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    if ((end === -1 ? text.length : end) - start > max) return true;
    if (end === -1) return false;
    start = end + 1;
  }
}

/**
 * The highlighter of one document: it colours a block while the document's budget lasts, and once a
 * block would take it past the budget, that block and every block after it print plain.
 */
export function codeHighlighter(): CodeHighlighter {
  let used = 0;
  let spent = false;
  return (code, name) => {
    const language = spent ? null : highlightLanguage(name);
    if (!language) return null;
    const bytes = utf8Bytes(code);
    if (
      bytes > MARKDOWN_LIMITS.highlightBlockBytes ||
      hasLineLongerThan(code, MARKDOWN_LIMITS.highlightLineLength)
    )
      return null;
    if (used + bytes > MARKDOWN_LIMITS.highlightBytes) {
      spent = true;
      return null;
    }
    used += bytes;
    return engine.highlight(code, { language, ignoreIllegals: true }).value;
  };
}
