import { readFileSync } from 'node:fs';

describe('generated frame scripts', () => {
  it('match a fresh build of src/frame (run `pnpm nx run engine:frames` after changing them)', async () => {
    const { framesModule, outputPath } =
      (await import('../../scripts/build-frames.mjs')) as {
        framesModule: () => Promise<string>;
        outputPath: string;
      };
    expect(readFileSync(outputPath, 'utf8').replace(/\r\n/g, '\n')).toBe(
      await framesModule(),
    );
  }, 30_000);
});
