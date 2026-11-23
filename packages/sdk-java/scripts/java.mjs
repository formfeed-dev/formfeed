// Runs the Java SDK's checks in Docker (plan 34), so `pnpm nx test sdk-java` works on any machine
// with Docker and CI runs the same thing: the official Maven image of the Java version asked for
// (docker/Dockerfile), the repository mounted so the tests read packages/api-types' vectors and
// goldens and tools/publish's release version, Maven's repository in a volume of its own. Maven
// builds into the container's /tmp, so a run leaves nothing in the checkout but what `fix` formats.
//
//   node packages/sdk-java/scripts/java.mjs test|lint|fix|mvn [args...]
//   JAVA=25 node packages/sdk-java/scripts/java.mjs test        (another Java; 11 by default)
//
// `lint` (javac's -Xlint:all -Werror, javadoc's doclint and google-java-format) and `fix` run on the
// newest LTS whatever JAVA says, because google-java-format needs Java 21; `--release 11` holds the
// sources to Java 11's API there, and `test` runs them on the Java that JAVA names.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const NEWEST = '25';

const java = process.env.JAVA ?? '11';
if (!/^\d+$/.test(java)) {
  console.error(`JAVA is a major version such as 11 or ${NEWEST}, not ${java}`);
  process.exit(2);
}

const goals = {
  test: ['test'],
  lint: ['-Plint', '-DskipTests', 'verify', 'spotless:check'],
  fix: ['spotless:apply'],
};

const [task = 'test', ...rest] = process.argv.slice(2);
const args = task === 'mvn' ? rest : goals[task];
if (!args) {
  console.error(
    `unknown task ${task}; one of ${Object.keys(goals).join(', ')}, mvn`,
  );
  process.exit(2);
}
const version = task === 'lint' || task === 'fix' ? NEWEST : java;
if (version !== java) {
  console.error(
    `${task} runs on Java ${NEWEST}: google-java-format needs Java 21 (JAVA=${java} is for test)`,
  );
}
const image = `formfeed/sdk-java:${version}`;

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
    `JAVA=${version}`,
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
    'formfeed-maven-cache:/m2',
    '-w',
    '/repo/packages/sdk-java',
    image,
    'mvn',
    '-Dmaven.repo.local=/m2/repository',
    '-Dformfeed.build=/tmp/formfeed-build',
    ...args,
  ]),
);
