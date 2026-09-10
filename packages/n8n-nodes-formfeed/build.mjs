// Compiles the node package the way n8n loads it: CommonJS in dist/, plus the package manifest
// and the node icon. `n8n` in package.json points at dist/nodes and dist/credentials.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../dist/packages/n8n-nodes-formfeed');
const require = createRequire(import.meta.url);

mkdirSync(out, { recursive: true });
// run tsc through node: spawning npx.cmd fails with EINVAL on Windows since Node 22
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(here, 'tsconfig.lib.json')], {
  stdio: 'inherit',
  cwd: here,
});

// the icon lives next to the node source and must sit next to the compiled node
cpSync(join(here, 'src/nodes/Formfeed/formfeed.svg'), join(out, 'dist/nodes/Formfeed/formfeed.svg'));

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
delete pkg.devDependencies;
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
for (const file of ['README.md', 'LICENSE']) cpSync(join(here, file), join(out, file));
writeFileSync(join(out, 'index.js'), 'module.exports = {};\n');
console.log('n8n-nodes-formfeed ->', out);
