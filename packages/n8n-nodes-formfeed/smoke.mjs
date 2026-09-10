// Loads the compiled node the way n8n does and checks the parts n8n relies on.
import Module, { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// the compiled nodes require n8n-workflow, which n8n provides at runtime; point Node at the copy
// installed for this package so the smoke test can load them from dist/
process.env.NODE_PATH = join(here, 'node_modules');
Module._initPaths();
const out = join(here, '../../dist/packages/n8n-nodes-formfeed');
const require = createRequire(import.meta.url);
const manifest = require(join(out, 'package.json'));

const fail = (message) => {
  console.error('smoke failed:', message);
  process.exit(1);
};

if (!manifest.n8n?.nodes?.length) fail('package.json has no n8n.nodes');
if (!manifest.keywords?.includes('n8n-community-node-package')) fail('missing community node keyword');

for (const relative of [...manifest.n8n.nodes, ...manifest.n8n.credentials]) {
  const loaded = require(join(out, relative));
  const [Exported] = Object.values(loaded);
  const instance = new Exported();
  // nodes describe themselves in `description`, credentials on the instance itself
  const subject = instance.description ?? instance;
  if (!subject.name) fail(`${relative} has no name`);
  if (!subject.displayName) fail(`${subject.name} has no displayName`);
  for (const property of subject.properties ?? []) {
    if (!property.name || !property.type) fail(`${subject.name}: property without name or type`);
    if (property.displayName === undefined) fail(`${subject.name}: property ${property.name} has no displayName`);
  }
  console.log('ok', subject.name);
}

console.log('n8n-nodes-formfeed smoke passed');
