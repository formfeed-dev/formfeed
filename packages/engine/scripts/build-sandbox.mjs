// Bundles the template sandbox's runtime (plan 27 §5.1) from `src/sandbox/entry.ts` into one script
// that sets `formfeedSandbox`. The render-worker's isolate and the editor's frame load the same
// bundle; it is built where it is used (the worker's build, `app:vendor`) and never committed.
//
//   node packages/engine/scripts/build-sandbox.mjs [<output file>]
//
// Without an argument it writes `dist/packages/engine/sandbox/formfeed-sandbox.js`.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = join(root, '..', '..');
export const defaultOutput = join(
  workspace,
  'dist/packages/engine/sandbox/formfeed-sandbox.js',
);

/**
 * The runtime's text. Node built-ins are refused rather than shimmed: the engine must stay free of
 * them (CLAUDE.md), and the isolate has none.
 */
export async function buildSandboxRuntime({ minify = true } = {}) {
  const result = await build({
    entryPoints: [join(root, 'src/sandbox/entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify,
    legalComments: 'none',
    logLevel: 'silent',
    tsconfig: join(root, 'tsconfig.lib.json'),
    plugins: [
      {
        name: 'no-node-builtins',
        setup(b) {
          b.onResolve({ filter: /^node:/ }, (args) => ({
            errors: [
              {
                text: `${args.path} is a Node built-in, which the template sandbox does not have (imported by ${args.importer})`,
              },
            ],
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

// run directly (drive letters may differ in case on Windows), not imported by a spec
if (
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() ===
    fileURLToPath(import.meta.url).toLowerCase()
) {
  const output = resolve(process.argv[2] ?? defaultOutput);
  const text = await buildSandboxRuntime();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, text);
  console.log(
    `wrote ${output} (${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MB)`,
  );
}
