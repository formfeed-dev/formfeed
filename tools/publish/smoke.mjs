/**
 * Installs the built packages the way a user would and checks they work.
 *
 * `npm pack` each package, install the tarballs into an empty project, then run the documented
 * examples as ESM and as CommonJS, and type-check a consumer under `moduleResolution: nodenext`
 * and `bundler` — including the Vitest matcher augmentation of `@formfeed/testing/vitest`.
 * Run `nx run publish:bundle` first. SMOKE_DIR picks the scratch directory (default: os temp).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packages } from './packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env['SMOKE_DIR'] ?? tmpdir();
mkdirSync(base, { recursive: true });
const dir = mkdtempSync(join(base, 'formfeed-smoke-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd = dir) =>
  execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32' });

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push([true, name]);
  } catch (e) {
    const detail = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
    results.push([false, `${name}\n      ${detail.split('\n').slice(0, 12).join('\n      ')}`]);
  }
};

try {
  // 1. pack, exactly what `npm publish` would upload
  const tarballs = packages.map((pkg) => {
    const out = run(npm, ['pack', '--pack-destination', dir], join(root, 'dist/packages', pkg.dir));
    return join(dir, out.trim().split('\n').pop());
  });

  // 2. a fresh project that installs the tarballs from disk and everything else from the registry
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  run(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error', ...tarballs, 'typescript@5', 'vitest@4', '@types/node@22']);

  // 3. the engine example, verbatim, as ESM: the docs page and the engine README (the npm page, and
  // the only copy in the public repository, which has no docs app) carry the same example, so
  // neither can drift from the package or from each other
  const examples = ['apps/docs/docs/devkit/engine-package.md', 'packages/engine/README.md']
    .filter((path) => existsSync(join(root, path)))
    .map((path) => [path, readFileSync(join(root, path), 'utf8').match(/```ts\r?\n([\s\S]*?)```/)?.[1]?.replace(/\r\n/g, '\n')]);
  for (const [path, text] of examples)
    if (!text?.includes("from '@formfeed/engine'")) throw new Error(`no engine example found in ${path}`);
  if (!examples.length || new Set(examples.map(([, text]) => text)).size > 1)
    throw new Error(`the engine example must be identical in ${examples.map(([path]) => path).join(' and ')}`);
  const example = examples[0][1];
  writeFileSync(
    join(dir, 'esm.mjs'),
    `${example}
if (analysis.variables[0]?.path?.[0] !== 'title') throw new Error('analyze: ' + JSON.stringify(analysis.variables));
if (!html.includes('<h1>HELLO</h1>')) throw new Error('render: ' + html);
if (!document.includes('HELLO')) throw new Error('assembleDocument');

const { Formfeed } = await import('@formfeed/sdk');
const { renderLocal } = await import('@formfeed/devkit');
const { matchers, loadTemplate } = await import('@formfeed/testing');
if (typeof new Formfeed({ apiKey: 'ff_test_x' }).renders?.create !== 'function') throw new Error('sdk');
if (typeof renderLocal !== 'function' || typeof loadTemplate !== 'function') throw new Error('devkit/testing');
if (typeof matchers.toRenderWithoutErrors !== 'function') throw new Error('matchers');
console.log('esm ok');
`,
  );
  check('ESM: the engine example from the docs runs verbatim, and every package imports', () => run('node', ['esm.mjs']));

  // 4. the same packages through require, which is how Jest loads setup files
  writeFileSync(
    join(dir, 'cjs.cjs'),
    `const { getEngine } = require('@formfeed/engine');
const { Formfeed } = require('@formfeed/sdk');
require('@formfeed/devkit');
const { matchers } = require('@formfeed/testing');
if (typeof getEngine('jinja2').compile !== 'function') throw new Error('engine');
if (typeof Formfeed !== 'function' || typeof matchers !== 'object') throw new Error('sdk/testing');
console.log('cjs ok');
`,
  );
  check('CommonJS: every package loads through require', () => run('node', ['cjs.cjs']));

  // 5. types, as a consumer sees them — including the matcher augmentation of the Vitest entry
  writeFileSync(
    join(dir, 'consumer.ts'),
    `import { getEngine, type Engine } from '@formfeed/engine';
import { Formfeed, FormfeedError } from '@formfeed/sdk';
import type { LocalTemplate } from '@formfeed/devkit';
import { loadTemplate, type TemplateHandle } from '@formfeed/testing';
import '@formfeed/testing/vitest';
import { expect } from 'vitest';

const engine: Engine = getEngine('handlebars');
const client = new Formfeed({ apiKey: 'ff_test_x' });
export async function usage(tpl: TemplateHandle, local: LocalTemplate): Promise<void> {
  void engine; void client; void local; void FormfeedError; void loadTemplate;
  await expect(tpl).toRenderWithoutErrors({});
  // @ts-expect-error: an unknown matcher must stay a type error, or the augmentation proves nothing
  await expect(tpl).toBeAFormfeedMatcherThatDoesNotExist();
}
`,
  );
  for (const [label, options] of [
    ['nodenext', { module: 'nodenext', moduleResolution: 'nodenext' }],
    ['bundler', { module: 'esnext', moduleResolution: 'bundler' }],
  ]) {
    writeFileSync(
      join(dir, `tsconfig.${label}.json`),
      JSON.stringify({
        compilerOptions: { ...options, target: 'es2022', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] },
        files: ['consumer.ts'],
      }),
    );
    check(`types resolve under moduleResolution: ${label}, with the Vitest matchers`, () =>
      run('node', [join(dir, 'node_modules/typescript/bin/tsc'), '-p', `tsconfig.${label}.json`]),
    );
  }
} finally {
  for (const [ok, name] of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (results.some(([ok]) => !ok) || results.length === 0) process.exitCode = 1;
  if (!process.env['SMOKE_KEEP']) rmSync(dir, { recursive: true, force: true });
  else console.log(`kept ${dir}`);
}
