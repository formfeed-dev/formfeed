// Runs the Go SDK's checks in Docker (plan 34), so `pnpm nx test sdk-go` works on any machine with
// Docker and CI runs the same thing: the official Go image with staticcheck pinned
// (docker/Dockerfile), the repository mounted so the tests read packages/api-types' vectors and
// goldens and tools/publish's version, the module and build caches in a volume of their own.
//
//   node packages/sdk-go/scripts/go.mjs test|vet|fmt|staticcheck|lint|fix [args...]
//   node packages/sdk-go/scripts/go.mjs go <command> [args...]    (any go command, such as `go version`)
//   GO=1.27 node packages/sdk-go/scripts/go.mjs test               (another Go; 1.26, the oldest supported, by default)
//
// `test` runs with the race detector where the image has cgo (the official images do) and takes go
// test's flags after it (`test -v -run TestVectors`). Commands run through `sh -c` and nothing
// depends on a file's mode, which Docker Desktop does not keep; only `fix` writes into the checkout,
// as the calling user on Linux and macOS, so the files stay theirs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const go = process.env.GO ?? '1.26';
if (!/^\d+\.\d+(\.\d+)?$/.test(go)) {
  console.error(`GO is a Go version such as 1.27, not ${go}`);
  process.exit(2);
}
const image = `formfeed/sdk-go:${go}`;
const context = resolve(here, '../docker');
const staticcheck = /^ARG STATICCHECK=(\S+)$/m.exec(
  readFileSync(resolve(context, 'Dockerfile'), 'utf8'),
)?.[1];

const gofmt =
  'unformatted=$(gofmt -l .); if [ -n "$unformatted" ]; then echo "gofmt would change these files (run the fix task):"; echo "$unformatted"; exit 1; fi';
const commands = {
  test: (args) =>
    `if [ "$(go env CGO_ENABLED)" = 1 ]; then race=-race; else race=; fi; go test $race -count=1 ${args} ./...`,
  vet: () => 'go vet ./...',
  fmt: () => gofmt,
  staticcheck: () => 'staticcheck ./...',
  lint: () => `${gofmt}; go vet ./... && staticcheck ./...`,
  fix: () => 'gofmt -w .',
  go: (args) => `go ${args}`,
};

const [task = 'test', ...rest] = process.argv.slice(2);
const command = commands[task]?.(rest.join(' '));
if (!command) {
  console.error(
    `unknown task ${task}; one of ${Object.keys(commands).join(', ')}`,
  );
  process.exit(2);
}

const run = (dockerArgs) => {
  const result = spawnSync('docker', dockerArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

// the image is built once per Go version, and again when the Dockerfile pins another staticcheck
const label = spawnSync(
  'docker',
  [
    'image',
    'inspect',
    '--format',
    '{{ index .Config.Labels "dev.formfeed.staticcheck" }}',
    image,
  ],
  { encoding: 'utf8' },
);
if (label.status !== 0 || label.stdout.trim() !== staticcheck) {
  const status = run([
    'build',
    '--build-arg',
    `GO=${go}`,
    '-t',
    image,
    context,
  ]);
  if (status !== 0) process.exit(status);
}

const user =
  task === 'fix' && typeof process.getuid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : [];
process.exit(
  run([
    'run',
    '--rm',
    ...user,
    '-v',
    `${repo}:/repo`,
    '-v',
    'formfeed-go-cache:/cache',
    '-e',
    'GOMODCACHE=/cache/mod',
    '-e',
    'GOCACHE=/cache/build',
    '-e',
    'XDG_CACHE_HOME=/cache/xdg',
    '-w',
    '/repo/packages/sdk-go',
    image,
    'sh',
    '-c',
    command,
  ]),
);
