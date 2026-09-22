// Builds the publishable piece in a checkout of activepieces/activepieces, the only place its current
// framework exists (it is no longer released to npm), and leaves the package in
// dist/packages/activepieces-piece, ready for `npm publish`. Runs in the public repository's release
// workflow and on any Linux or WSL shell with Node 24, git and bun (their tooling does not run on
// Windows).
//
//   node packages/activepieces-piece/build.mjs [checkout directory, default tmp/activepieces]
//
// Their release is pinned in ACTIVEPIECES_RELEASE below and raised on purpose: on 2026-09-22 their
// main did not compile under their own CLI, and a release of ours must not depend on that.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { common, VERSION } from '../../tools/publish/packages.mjs';

export const ACTIVEPIECES_RELEASE = '0.91.1';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, '..', '..');
const checkout = resolve(process.argv[2] ?? join(workspace, 'tmp', 'activepieces'));
const piece = join(checkout, 'packages', 'pieces', 'custom', 'formfeed');
const out = join(workspace, 'dist', 'packages', 'activepieces-piece');

const run = (command, args, cwd = checkout, env = {}) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
const tsNode = (project, script) =>
  run('npx', ['ts-node', '-r', 'tsconfig-paths/register', '--project', project, '-e', script]);

// 1. their repository at the pinned release, with dependencies (a test helper would build Redis)
if (!existsSync(join(checkout, '.git'))) {
  mkdirSync(dirname(checkout), { recursive: true });
  run('git', ['clone', '--depth', '1', '--branch', ACTIVEPIECES_RELEASE, 'https://github.com/activepieces/activepieces.git', checkout], workspace);
} else {
  run('git', ['fetch', '--depth', '1', 'origin', 'tag', ACTIVEPIECES_RELEASE]);
  run('git', ['checkout', '--force', '--quiet', ACTIVEPIECES_RELEASE]);
}
run('bun', ['install'], checkout, { REDISMS_DISABLE_POSTINSTALL: '1' });

// 2. the piece folder their CLI scaffolds (create-piece only asks interactively)
if (!existsSync(join(piece, 'package.json')))
  tsNode(
    'packages/cli/tsconfig.json',
    "require('./packages/cli/src/lib/commands/create-piece').createPiece('formfeed', '@formfeed/activepieces-piece', 'custom')",
  );

// 3. our sources into it, then their build and bundle (framework and form-data inlined)
run(process.execPath, [join(here, 'export.mjs'), checkout, 'custom'], workspace);
run('bun', ['install'], checkout, { REDISMS_DISABLE_POSTINSTALL: '1' });
run('npm', ['run', 'cli', '--', 'pieces', 'generate-translation-file', 'packages/pieces/custom/formfeed']);
run('npx', ['turbo', 'run', 'build', '--filter=@formfeed/activepieces-piece']);
tsNode(
  'tools/tsconfig.tools.json',
  "require('./packages/cli/src/lib/utils/prepare-piece-utils').preparePieceDistForPublish('packages/pieces/custom/formfeed').then(() => {}, (e) => { console.error(e); process.exit(1); })",
);

// 4. what their bundle leaves out: the npm page, the licence, and the manifest fields npm's provenance
//    and the package page need (the repository must be the public one the release runs in)
const bundle = join(piece, 'dist');
const manifest = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'));
if (Object.keys(manifest.dependencies ?? {}).length > 0)
  throw new Error(`the bundle still depends on ${Object.keys(manifest.dependencies).join(', ')}`);
cpSync(join(here, 'piece', 'README.md'), join(bundle, 'README.md'));
cpSync(join(here, 'LICENSE'), join(bundle, 'LICENSE'));
const { engines: _engines, ...fields } = common('activepieces-piece');
Object.assign(manifest, fields, {
  version: VERSION,
  description: 'Formfeed for Activepieces: create PDFs, images, Word and PowerPoint documents from templates.',
  license: 'MIT',
  homepage: 'https://docs.formfeed.dev/integrations/activepieces',
  keywords: ['activepieces', 'piece', 'formfeed', 'pdf', 'pdf-generation', 'template'],
  files: [...new Set([...(manifest.files ?? []), 'README.md', 'LICENSE'])],
});
writeFileSync(join(bundle, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

rmSync(out, { recursive: true, force: true });
cpSync(bundle, out, { recursive: true });
console.log(`@formfeed/activepieces-piece@${VERSION} built on Activepieces ${ACTIVEPIECES_RELEASE} -> ${out}`);
