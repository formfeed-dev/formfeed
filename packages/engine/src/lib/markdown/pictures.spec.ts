import { describe, expect, it } from 'vitest';
import {
  MarkdownPictureError,
  inlineMarkdownPictures,
  type PictureFiles,
} from './pictures';

/** A folder `/doc` with the files given; `..` leads out of it. */
function folder(files: Record<string, Uint8Array>): PictureFiles & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    locate(path) {
      asked.push(path);
      const parts: string[] = [];
      for (const part of path.replace(/\\/g, '/').split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
          if (!parts.length) return null;
          parts.pop();
        } else parts.push(part);
      }
      if (path.startsWith('/')) return null;
      return `/doc/${parts.join('/')}`;
    },
    async read(file) {
      return files[file.slice('/doc/'.length)] ?? null;
    },
  };
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const pngUri = 'data:image/png;base64,iVBORw==';

describe('inlineMarkdownPictures', () => {
  it('sends a picture inside the folder as a data URI and leaves a library name as written', async () => {
    const files = folder({ 'logo.png': png, 'img/chart one.svg': png });
    const result = await inlineMarkdownPictures(
      [
        '# Report',
        '',
        '![Logo](logo.png "Our logo") and ![Chart](<img/chart one.svg>)',
        '![Seal](seal.png) from the library, ![Web](https://example.test/a.png)',
        '[![Badge](./logo.png)](https://example.test)',
      ].join('\n'),
      files,
    );
    expect(result.markdown).toBe(
      [
        '# Report',
        '',
        `![Logo](${pngUri} "Our logo") and ![Chart](data:image/svg+xml;base64,iVBORw==)`,
        '![Seal](seal.png) from the library, ![Web](https://example.test/a.png)',
        `[![Badge](${pngUri})](https://example.test)`,
      ].join('\n'),
    );
    expect(result.inlined).toEqual([
      'logo.png',
      'img/chart one.svg',
      './logo.png',
    ]);
    expect(result.library).toEqual(['seal.png']);
  });

  it('reads a percent-encoded name and a reference-style picture', async () => {
    const result = await inlineMarkdownPictures(
      [
        '![A][logo] and ![b%20c.png]',
        '',
        '[logo]: logo.png',
        '[b%20c.png]: b%20c.png',
        '[site]: site.png',
      ].join('\n'),
      folder({ 'logo.png': png, 'b c.png': png, 'site.png': png }),
    );
    expect(result.markdown).toBe(
      [
        '![A][logo] and ![b%20c.png]',
        '',
        `[logo]: ${pngUri}`,
        `[b%20c.png]: ${pngUri}`,
        // a definition no picture uses is a link's, and stays as written
        '[site]: site.png',
      ].join('\n'),
    );
  });

  it('leaves pictures in code alone', async () => {
    const text = [
      '```markdown',
      '![Logo](logo.png)',
      '```',
      '',
      '    ![Indented](logo.png)',
      '',
      'Write `![Logo](logo.png)` or ``![x](logo.png)`` to show one.',
      '',
      '<div>',
      '![Raw](logo.png)',
      '</div>',
    ].join('\n');
    const files = folder({ 'logo.png': png });
    const result = await inlineMarkdownPictures(text, files);
    expect(result.markdown).toBe(text);
    expect(files.asked).toEqual([]);
  });

  it('refuses a path outside the folder, before reading anything', async () => {
    for (const path of ['../secret.png', '/etc/logo.png', 'a/../../b.png']) {
      const error = await inlineMarkdownPictures(
        `![x](${path})`,
        folder({}),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MarkdownPictureError);
      expect(error).toMatchObject({ code: 'outside', path });
    }
  });

  it('refuses a file that is no picture type the converter keeps', async () => {
    const error = await inlineMarkdownPictures(
      '![x](notes.txt)',
      folder({ 'notes.txt': png }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'type',
      message: 'The picture notes.txt is no PNG, JPEG, GIF, WebP or SVG file',
    });
  });

  it('refuses a document that its pictures take past 1 MB, naming the largest', async () => {
    const big = new Uint8Array(600 * 1024);
    const error = await inlineMarkdownPictures(
      '![a](a.png) ![b](b.png) ![a again](a.png)',
      folder({ 'a.png': big, 'b.png': png }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'too_large', path: 'a.png' });
    expect((error as Error).message).toContain('a.png is 0.6 MB');
    expect((error as Error).message).toContain('more than the 1 MB');
  });

  it('keeps CRLF line ends and the offsets of later lines', async () => {
    const result = await inlineMarkdownPictures(
      '# A\r\n\r\n`x`\r\n![L](logo.png)\r\n',
      folder({ 'logo.png': png }),
    );
    expect(result.markdown).toBe(`# A\r\n\r\n\`x\`\r\n![L](${pngUri})\r\n`);
  });
});
