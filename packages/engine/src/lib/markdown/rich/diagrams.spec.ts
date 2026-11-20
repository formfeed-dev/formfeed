// @vitest-environment jsdom
// (one test reads the markup as a page's parser does)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MarkdownSyntaxError } from '../../errors';
import { markdownToHtml, type MarkdownConvertOptions } from '../convert';
import { MARKDOWN_DIAGRAMS, MARKDOWN_LIMITS } from '../settings';
import { richMarkdown } from './index';

const rich = richMarkdown();
const convert = async (
  text: string,
  options: Partial<MarkdownConvertOptions> = {},
) =>
  (
    await markdownToHtml(text, {
      html: 'safe',
      diagrams: true,
      rich,
      ...options,
    })
  ).html;

const failure = async (text: string) => {
  const e = await convert(text).then(
    () => null,
    (error: unknown) => error,
  );
  if (!(e instanceof MarkdownSyntaxError))
    throw new Error(`expected a MarkdownSyntaxError, got ${String(e)}`);
  return { line: e.line, part: e.part, message: e.message };
};

const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

describe('the diagrams’ library', () => {
  it('is the release the version names, whose browser build the worker serves', () => {
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(
      readFileSync(require.resolve('mermaid/package.json'), 'utf8'),
    ) as { version: string };
    expect(MARKDOWN_DIAGRAMS.version).toBe(manifest.version);
  });
});

describe('diagrams in a document (plan 33, decisions 8 and 10)', () => {
  it('turns a mermaid fence into a figure that holds its source and its first line', async () => {
    const html = await convert(
      '# Flow\n\n```mermaid\nflowchart LR\n  A[Order] --> B{"x < y & z"}\n```\n\nText.',
    );
    expect(html).toContain(
      '<figure class="ff-diagram" role="img"><pre data-ff-mermaid data-ff-line="4">\nflowchart LR\n  A[Order] --&gt; B{&quot;x &lt; y &amp; z&quot;}\n</pre></figure>',
    );
  });

  it('keeps a fence’s empty first line, which the page’s parser would drop after <pre>', async () => {
    const html = await convert('```mermaid\n\nflowchart LR\n```');
    const holder = document.createElement('div');
    holder.innerHTML = html;
    expect(holder.querySelector('pre')?.textContent).toBe('\nflowchart LR\n');
  });

  it('counts the lines of front matter in, and takes the fence’s language in any case', async () => {
    const html = await convert(
      '---\ntitle: T\n---\n\n```Mermaid\npie\n  "A" : 1\n```',
    );
    expect(html).toContain('data-ff-line="6"');
  });

  it('is code where it was not asked for, or where the host brought nothing to read it', async () => {
    const text = '```mermaid\nflowchart LR\n  A --> B\n```';
    const plain = await convert(text, { diagrams: false });
    expect(plain).toContain('<pre><code class="language-mermaid">');
    expect(plain).not.toContain('data-ff-mermaid');
    expect(await convert(text, { rich: undefined })).toBe(plain);
  });

  it('leaves other fences alone, and reads formulas beside diagrams', async () => {
    const html = await convert(
      '```ts\nconst a = 1;\n```\n\n```mermaid\npie\n  "A" : 1\n```\n\n$x^2$',
      { math: true, highlight: true },
    );
    expect(html).toContain('<code class="hljs language-ts">');
    expect(html).toContain('data-ff-mermaid');
    expect(html).toContain('aria-label="x^2"');
  });
});

describe('the limits of a document’s diagrams (decision 8)', () => {
  const { diagrams, diagramBytes } = MARKDOWN_LIMITS;
  const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;

  it('refuses the 51st diagram before anything is drawn, naming its fence', async () => {
    const text = Array.from({ length: diagrams + 1 }, () =>
      fence('pie\n  "A" : 1'),
    ).join('\n\n');
    // each fence is four lines and an empty line: the 51st opens on line 251
    expect(await failure(text)).toEqual({
      line: diagrams * 5 + 1,
      part: 'diagram',
      message: `The diagram on line ${diagrams * 5 + 1} is one more than the ${diagrams} a document may hold`,
    });
    expect(
      (await convert(text.split('\n\n').slice(0, diagrams).join('\n\n'))).match(
        /data-ff-mermaid/g,
      ),
    ).toHaveLength(diagrams);
  });

  it('refuses a diagram over 50 kB', async () => {
    const source = `flowchart LR\n${'  A --> B\n'.repeat(Math.ceil(diagramBytes / 10))}`;
    expect(await failure(`# A\n\n${fence(source)}`)).toMatchObject({
      line: 3,
      part: 'diagram',
      message: expect.stringMatching(
        /^The diagram on line 3 is [\d,]+ bytes long; a diagram may be at most 51,200$/,
      ),
    });
  });

  it('reads 1 MB of fences within the time limit', async () => {
    for (const text of [
      // many small diagrams: refused at the 51st
      fence('pie\n  "A" : 1')
        .concat('\n\n')
        .repeat(40_000)
        .slice(0, 1024 * 1024),
      // one fence never closed, which markdown-it runs to the end
      `\`\`\`mermaid\n${'A --> B\n'.repeat(131_000)}`,
    ]) {
      const startedAt = cpuMs();
      await convert(text).catch(() => undefined);
      expect(cpuMs() - startedAt).toBeLessThan(5000);
    }
  }, 30_000);
});
