// Copies the piece into a checkout of activepieces/activepieces, where their CLI builds, bundles and
// publishes it (their framework is no longer released to npm, so nothing outside that monorepo can
// build a piece for current releases).
//
//   node packages/activepieces-piece/export.mjs <path to the activepieces checkout> [community|custom]
//
// Run their scaffold once first (`npm run create-piece`, name `formfeed`, type as given here): it
// writes the tsconfig, lint and package files their build expects. This script then replaces the
// sources and the README, and adds the one dependency the piece has besides their framework.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../tools/publish/packages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [checkout, kind = 'custom'] = process.argv.slice(2);
if (!checkout || !['community', 'custom'].includes(kind)) {
  console.error('usage: node packages/activepieces-piece/export.mjs <activepieces checkout> [community|custom]');
  process.exit(2);
}
const target = resolve(checkout, 'packages', 'pieces', kind, 'formfeed');
const manifestPath = join(target, 'package.json');
if (!existsSync(manifestPath)) {
  console.error(`${target} has no package.json. Scaffold it first in the checkout: npm run create-piece (name: formfeed, type: ${kind}).`);
  process.exit(1);
}

// the scaffold's translation file stays; everything else under src is ours
const i18n = join(target, 'src', 'i18n');
const keep = existsSync(i18n) ? join(target, '.i18n-keep') : null;
if (keep) cpSync(i18n, keep, { recursive: true });
rmSync(join(target, 'src'), { recursive: true, force: true });
cpSync(join(here, 'piece', 'src'), join(target, 'src'), { recursive: true });
if (keep) {
  cpSync(keep, i18n, { recursive: true });
  rmSync(keep, { recursive: true, force: true });
}
cpSync(join(here, 'piece', 'README.md'), join(target, 'README.md'));

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
// published under our own scope: their repository no longer takes pieces from outside contributors
manifest.name = '@formfeed/activepieces-piece';
// the shared version of the published packages, released together on a `v*` tag
manifest.version = VERSION;
// their publish step refuses ranges; the version is the root package.json's
const root = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
const formData = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).dependencies['form-data'] ?? root.dependencies?.['form-data'];
manifest.dependencies = { ...manifest.dependencies, 'form-data': formData };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`piece copied to ${target} as ${manifest.name}@${manifest.version}`);
console.log('next: node packages/activepieces-piece/build.mjs builds and bundles it (see packages/activepieces-piece/README.md)');
