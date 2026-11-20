/**
 * Diagrams in a Markdown document (plan 33, decisions 8 to 10): a ` ```mermaid ` fence becomes a
 * figure that holds its source, and Mermaid draws it in the document's page before it is printed,
 * as charts are drawn (`frame/diagrams.ts`, wired in by `assembleDocument`). Nothing of Mermaid runs
 * here: the converter only reads, counts and measures the fences, so a document past a limit is
 * refused before any script runs.
 *
 * The figure is `role="img"`, which the page names from the `<title>` and `<desc>` Mermaid writes
 * for a diagram's `accTitle` and `accDescr`; Chromium tags it as a `Figure` with that name as its
 * `Alt` (decision 13). The source line rides along as `data-ff-line`, so a diagram that does not
 * parse fails the render naming the line of the document.
 */
import type { Env, MarkdownIt as Parser, StateCore, Token } from 'markdown-it';
import { MarkdownSyntaxError } from '../../errors';
import { MARKDOWN_LIMITS, utf8Bytes } from '../settings';

/** How many diagrams a document's conversion has read; one count per document, in its `env`. */
const COUNT = 'formfeedDiagrams';

const grouped = (n: number) => n.toLocaleString('en-US');

/** A fence whose language is `mermaid` is a diagram; read after the blocks, before anything runs. */
function diagramFences(state: StateCore): void {
  const { unescapeAll } = state.md.utils;
  const env: Env = state.env;
  const { diagrams, diagramBytes } = MARKDOWN_LIMITS;
  for (const token of state.tokens) {
    if (token.type !== 'fence') continue;
    const language = unescapeAll(token.info).trim().split(/\s/, 1)[0] ?? '';
    if (language.toLowerCase() !== 'mermaid') continue;
    // the fence's first line of source, from 1: the line a diagram's own line 1 is
    const line = (token.map?.[0] ?? 0) + 2;
    const count = ((env[COUNT] as number | undefined) ?? 0) + 1;
    env[COUNT] = count;
    if (count > diagrams)
      throw new MarkdownSyntaxError(
        'diagram',
        `The diagram on line ${line - 1} is one more than the ${diagrams} a document may hold`,
        line - 1,
      );
    const bytes = utf8Bytes(token.content);
    if (bytes > diagramBytes)
      throw new MarkdownSyntaxError(
        'diagram',
        `The diagram on line ${line - 1} is ${grouped(bytes)} bytes long; a diagram may be at most ${grouped(diagramBytes)}`,
        line - 1,
      );
    token.type = 'formfeed_diagram';
    token.meta = { line };
  }
}

/**
 * The rules and renderer of diagrams, as a markdown-it plugin: the converter adds it to the parser
 * of a document that asks for diagrams, which its host made (`RichMarkdown.diagrams`).
 */
export function diagramRules(md: Parser): void {
  md.core.ruler.after('block', 'formfeed_diagrams', diagramFences);
  const escape = md.utils.escapeHtml;
  md.renderer.rules['formfeed_diagram'] = (tokens: Token[], idx: number) => {
    const token = tokens[idx];
    if (!token) return '';
    const line = (token.meta as { line: number }).line;
    // the source as text, which the page reads back from the element before it draws; the parser
    // drops a line break right after `<pre>`, so one goes there and the source's own first line stays
    return `<figure class="ff-diagram" role="img"><pre data-ff-mermaid data-ff-line="${line}">\n${escape(token.content)}</pre></figure>\n`;
  };
}
