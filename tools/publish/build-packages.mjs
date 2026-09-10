/**
 * Builds @formfeed/sdk, engine, devkit and testing into dist/packages/<dir>, ready for `npm publish`.
 *
 * - JavaScript: esbuild, one ESM (`.js`) and one CommonJS (`.cjs`) file per entry. Dependencies and
 *   the sibling packages stay external; internal workspace libraries (@formfeed/api-types) are
 *   inlined, since they are not published. CommonJS is for Jest, which loads setup files with
 *   `require` unless run in its experimental ESM mode.
 * - Types: one `tsc` run over all four packages (their public types reference each other), then
 *   every declaration is rewritten for publishing: workspace aliases become package names
 *   (`@formfeed/sdk-ts` → `@formfeed/sdk`) and relative specifiers get the `.js` extension that
 *   `moduleResolution: nodenext` requires. A `.d.cts` twin is written for `require` consumers, so
 *   CommonJS projects do not see ESM types ("masquerading as ESM").
 * - Manifest: generated, never kept in the package folder — see packages.mjs for why.
 *
 * A published declaration that still names an unpublished workspace package fails the build.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { VERSION, common, packages, published, renames } from './packages.mjs';
import { writeThirdPartyLicenses } from './third-party-licenses.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const typesOut = join(root, 'dist/publish-types');

/** Sibling packages exactly, everything else as a caret range from the workspace's version. */
function versionOf(dep) {
  if (published.has(dep)) return VERSION;
  const v = rootPkg.dependencies?.[dep] ?? rootPkg.devDependencies?.[dep];
  if (!v) throw new Error(`${dep} is not in the root package.json`);
  return /^\d+\.\d+\.\d+$/.test(v) ? `^${v}` : v;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

// ---------------------------------------------------------------------------------- declarations
function emitTypes() {
  rmSync(typesOut, { recursive: true, force: true });
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(root, 'tools/publish/tsconfig.types.json')], {
    cwd: root,
    stdio: 'inherit',
  });
}

/** Rewrites one declaration file's module specifiers for publishing; returns the offending ones. */
function rewriteSpecifiers(file, text) {
  const bad = [];
  const out = text.replace(
    /((?:from|import)\s*\(?\s*)(['"])([^'"]+)\2/g,
    (match, lead, quote, spec) => {
      if (spec.startsWith('.')) {
        const base = resolve(dirname(file), spec);
        if (existsSync(`${base}.d.ts`)) return `${lead}${quote}${spec}.js${quote}`;
        if (existsSync(join(base, 'index.d.ts'))) return `${lead}${quote}${spec}/index.js${quote}`;
        return match;
      }
      const renamed = renames[spec] ?? spec;
      const scope = renamed.match(/^@formfeed\/[^/]+/)?.[0];
      if (scope && !published.has(scope)) bad.push(spec);
      return `${lead}${quote}${renamed}${quote}`;
    },
  );
  return { out, bad };
}

function publishTypes(pkg, outDir) {
  const emitted = join(typesOut, 'packages', pkg.dir, 'src');
  const source = join(root, 'packages', pkg.dir, 'src');
  const target = join(outDir, 'types');
  mkdirSync(target, { recursive: true });
  cpSync(emitted, target, { recursive: true });
  // hand-written declarations (the engine's ambient typings for deep imports) are not emitted
  for (const file of walk(source))
    if (file.endsWith('.d.ts')) cpSync(file, join(target, relative(source, file)));

  const offending = [];
  for (const file of walk(target)) {
    if (!file.endsWith('.d.ts')) continue;
    const { out, bad } = rewriteSpecifiers(file, readFileSync(file, 'utf8'));
    for (const spec of bad) offending.push(`${relative(root, file)}: ${spec}`);
    writeFileSync(file, out);
    // CommonJS twin: same types, specifiers pointing at .cjs files
    writeFileSync(file.replace(/\.d\.ts$/, '.d.cts'), out.replace(/(['"])(\.[^'"]*)\.js\1/g, '$1$2.cjs$1'));
  }
  if (offending.length)
    throw new Error(`${pkg.name} declarations name unpublished packages:\n  ${offending.join('\n  ')}`);
}

// ---------------------------------------------------------------------------------- javascript
async function bundle(pkg, outDir) {
  const external = [
    ...pkg.dependencies,
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.values(renames),
  ];
  const outputs = {};
  for (const [subpath, entry] of Object.entries(pkg.entries)) {
    const name = subpath === '.' ? 'index' : subpath.slice(2);
    for (const format of ['esm', 'cjs']) {
      const { metafile } = await build({
        entryPoints: [join(root, 'packages', pkg.dir, entry)],
        outfile: join(outDir, `${name}.${format === 'esm' ? 'js' : 'cjs'}`),
        bundle: true,
        format,
        platform: pkg.platform,
        target: 'es2022',
        mainFields: ['module', 'main'],
        external,
        alias: renames,
        tsconfig: join(root, 'tsconfig.base.json'),
        legalComments: 'none',
        metafile: true,
        logLevel: 'warning',
      });
      Object.assign(outputs, metafile.outputs);
    }
  }
  // dependencies stay external, so this normally writes nothing; it catches a package inlined by accident
  writeThirdPartyLicenses({ outputs }, join(outDir, 'THIRD_PARTY_LICENSES.md'), { title: `\`${pkg.name}\`` });
}

// ---------------------------------------------------------------------------------- manifest
function manifest(pkg) {
  const exportsMap = {};
  for (const subpath of Object.keys(pkg.entries)) {
    const name = subpath === '.' ? 'index' : subpath.slice(2);
    exportsMap[subpath] = {
      import: { types: `./types/${name}.d.ts`, default: `./${name}.js` },
      require: { types: `./types/${name}.d.cts`, default: `./${name}.cjs` },
    };
  }
  exportsMap['./package.json'] = './package.json';
  const sideEffectEntries = Object.keys(pkg.entries).filter((s) => s !== '.');
  return {
    name: pkg.name,
    version: VERSION,
    description: pkg.description,
    license: 'MIT',
    type: 'module',
    main: './index.cjs',
    module: './index.js',
    types: './types/index.d.ts',
    exports: exportsMap,
    files: ['*.js', '*.cjs', 'types', 'README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.md'],
    // the setup files register matchers when imported, so they must never be tree-shaken
    sideEffects: sideEffectEntries.length
      ? sideEffectEntries.flatMap((s) => [`./${s.slice(2)}.js`, `./${s.slice(2)}.cjs`])
      : false,
    dependencies: Object.fromEntries(pkg.dependencies.map((d) => [d, versionOf(d)])),
    ...(pkg.peerDependencies && {
      peerDependencies: pkg.peerDependencies,
      peerDependenciesMeta: Object.fromEntries((pkg.optionalPeers ?? []).map((p) => [p, { optional: true }])),
    }),
    keywords: pkg.keywords,
    homepage: pkg.homepage,
    ...common(pkg.dir),
  };
}

function readme(pkg) {
  const own = join(root, 'packages', pkg.dir, 'README.md');
  if (!existsSync(own)) throw new Error(`packages/${pkg.dir}/README.md is missing: it becomes the npm page`);
  return readFileSync(own, 'utf8');
}

// ---------------------------------------------------------------------------------- main
emitTypes();
for (const pkg of packages) {
  const outDir = join(root, 'dist/packages', pkg.dir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await bundle(pkg, outDir);
  publishTypes(pkg, outDir);
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(manifest(pkg), null, 2)}\n`);
  writeFileSync(join(outDir, 'README.md'), readme(pkg));
  cpSync(join(root, 'packages', pkg.dir, 'LICENSE'), join(outDir, 'LICENSE'));
  console.log(`built ${pkg.name}@${VERSION} → ${relative(root, outDir)}`);
}
