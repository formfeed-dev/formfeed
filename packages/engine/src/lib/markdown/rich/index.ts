/**
 * `@formfeed/engine/markdown/rich` (plan 33): what a Markdown document may use beyond markdown-it,
 * handed to `markdownToHtml` by the host that converts documents, the render-worker's Markdown
 * thread. Only documents use it (decision 1): the `markdown` helper's fragments stay as they are, so
 * the template sandbox carries none of it. The published `@formfeed/engine` does not export it
 * (§9), so highlight.js and KaTeX are no dependencies of the engine, the devkit or the testing
 * package.
 */
import type { RichMarkdown } from '../convert';
import { codeHighlighter } from './code';
import { diagramRules } from './diagrams';
import { mathRules } from './math';

export {
  HIGHLIGHT_LANGUAGES,
  HIGHLIGHTER_VERSION,
  codeHighlighter,
  highlightLanguage,
} from './code';
export { diagramRules } from './diagrams';
export { KATEX_VERSION, mathRules } from './math';

/**
 * What the converter takes as `rich`: highlighted code, typeset formulas, and the fences of diagrams
 * that the page draws.
 */
export function richMarkdown(): RichMarkdown {
  return {
    highlighter: codeHighlighter,
    math: mathRules,
    diagrams: diagramRules,
  };
}
