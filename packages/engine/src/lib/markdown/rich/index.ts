/**
 * `@formfeed/engine/markdown/rich` (plan 33): what a Markdown document may use beyond markdown-it,
 * handed to `markdownToHtml` by the host that converts documents, the render-worker's Markdown
 * thread. Only documents use it (decision 1): the `markdown` helper's fragments stay as they are, so
 * the template sandbox carries none of it. The published `@formfeed/engine` does not export it
 * (§9), so highlight.js is no dependency of the engine, the devkit or the testing package.
 */
import type { RichMarkdown } from '../convert';
import { codeHighlighter } from './code';

export {
  HIGHLIGHT_LANGUAGES,
  HIGHLIGHTER_VERSION,
  codeHighlighter,
  highlightLanguage,
} from './code';

/** What the converter takes as `rich`: highlighted code. */
export function richMarkdown(): RichMarkdown {
  return { highlighter: codeHighlighter };
}
