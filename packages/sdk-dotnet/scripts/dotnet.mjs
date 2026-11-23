// Runs the checks of the .NET SDK in Docker (plan 34), so `pnpm nx test sdk-dotnet` works on any
// machine with Docker and CI runs the same thing: the official .NET SDK image with the .NET 8 and
// .NET 10 runtimes beside it (docker/Dockerfile), the repository mounted so the tests read
// packages/api-types' vectors and goldens, NuGet's packages in a volume of their own, and the build
// output in the container (FORMFEED_ARTIFACTS), so the mounted repository gets no bin/ or obj/ owned
// by root and nothing relies on file modes, which Docker Desktop does not show.
//
//   node packages/sdk-dotnet/scripts/dotnet.mjs test|lint|fix|dotnet [args...]
//   DOTNET=11.0 node packages/sdk-dotnet/scripts/dotnet.mjs test     (another SDK; 10.0 by default)
//
// test runs the tests on net10.0 and net8.0; lint checks the formatting (dotnet format) and builds
// with the analyzers' warnings as errors; fix formats; dotnet passes its arguments to the CLI.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const dotnet = process.env.DOTNET ?? '10.0';
if (!/^\d+\.\d+$/.test(dotnet)) {
  console.error(`DOTNET is an SDK version such as 10.0, not ${dotnet}`);
  process.exit(2);
}
const image = `formfeed/sdk-dotnet:${dotnet}`;

const solution = 'Formfeed.slnx';
const commands = {
  test: 'dotnet test --project tests/Formfeed.Tests/Formfeed.Tests.csproj',
  lint: [
    `dotnet restore ${solution}`,
    `dotnet format ${solution} --verify-no-changes --no-restore`,
    `dotnet build ${solution} --no-restore -c Release -warnaserror -p:TreatWarningsAsErrors=true`,
  ].join(' && '),
  fix: `dotnet format ${solution}`,
};

const [task = 'test', ...rest] = process.argv.slice(2);
const command = task === 'dotnet' ? `dotnet ${rest.join(' ')}` : commands[task];
if (!command) {
  console.error(
    `unknown task ${task}; one of ${Object.keys(commands).join(', ')}, dotnet`,
  );
  process.exit(2);
}

const run = (dockerArgs) => {
  const result = spawnSync('docker', dockerArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

const built =
  spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
    .status === 0;
if (!built) {
  const status = run([
    'build',
    '--build-arg',
    `DOTNET=${dotnet}`,
    '-t',
    image,
    resolve(here, '../docker'),
  ]);
  if (status !== 0) process.exit(status);
}

process.exit(
  run([
    'run',
    '--rm',
    '-v',
    `${repo}:/repo`,
    '-v',
    'formfeed-nuget-cache:/nuget',
    '-e',
    'FORMFEED_ARTIFACTS=/tmp/artifacts',
    '-w',
    '/repo/packages/sdk-dotnet',
    image,
    'sh',
    '-c',
    command,
  ]),
);
