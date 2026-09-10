/**
 * THIRD_PARTY_LICENSES.md for an esbuild bundle: every npm package whose code ended up in the
 * output, with its licence text. MIT, BSD and ISC all require the notice to travel with every copy,
 * and an inlined dependency is a copy; the published package's own licence does not cover it.
 *
 * Pass the metafile of a build run with `metafile: true`. Workspace sources are not in
 * node_modules and are covered by the package's own LICENSE.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** `…/node_modules/.pnpm/x@1/node_modules/@scope/name/lib/a.js` → `…/node_modules/@scope/name` */
function packageRoot(input) {
  const parts = input.replace(/\\/g, '/').split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return null;
  const length = parts[at + 1].startsWith('@') ? 2 : 1;
  return parts.slice(0, at + 1 + length).join('/');
}

function licenceText(dir) {
  const file = readdirSync(dir).find((name) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(name));
  return file ? readFileSync(join(dir, file), 'utf8').trim() : null;
}

/** The packages bundled into any output of `metafile`, sorted by name. */
export function bundledPackages(metafile, cwd = process.cwd()) {
  const roots = new Set();
  for (const output of Object.values(metafile.outputs))
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      if (bytesInOutput === 0) continue; // tree-shaken away entirely
      const root = packageRoot(input);
      if (root) roots.add(resolve(cwd, root));
    }
  const byName = new Map();
  for (const dir of roots) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const licence = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'UNKNOWN';
    byName.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, licence, text: licenceText(dir) });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * Writes `file` for the packages in `metafile`; returns their number. Writes nothing when the
 * bundle inlines no npm package. A package that ships no licence file fails the build unless its
 * `license` field names one, in which case the SPDX identifier stands in for the text.
 */
export function writeThirdPartyLicenses(metafile, file, { title }) {
  const packages = bundledPackages(metafile);
  if (!packages.length) return 0;
  const sections = packages.map(({ name, version, licence, text }) => {
    if (!text && licence === 'UNKNOWN') throw new Error(`${name}@${version} is bundled but states no licence`);
    const body = text ? `\`\`\`text\n${text.replace(/```/g, "'''")}\n\`\`\`` : `Licensed under ${licence}; the package ships no licence file.`;
    return `## ${name} ${version}\n\nLicence: ${licence}\n\n${body}\n`;
  });
  writeFileSync(
    file,
    `# Third-party licences\n\n${title} includes code from the following npm packages, each under its own licence.\n\n${sections.join('\n')}`,
  );
  return packages.length;
}
