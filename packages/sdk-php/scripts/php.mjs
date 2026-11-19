// Runs the checks of the PHP packages in Docker (plan 34), so `pnpm nx test sdk-php` and
// `pnpm nx test sdk-laravel` work on any machine with Docker and CI runs the same thing: the official
// PHP image with Composer (docker/Dockerfile), the repository mounted so the tests read
// packages/api-types' vectors and goldens and the Laravel package finds the SDK beside it, Composer's
// cache in a volume of its own.
//
//   node packages/sdk-php/scripts/php.mjs [--package sdk-laravel] test|stan|cs|fix|lint|composer [args...]
//   PHP=8.5 node packages/sdk-php/scripts/php.mjs test        (another PHP version; 8.3 by default)
//   LARAVEL=12 node packages/sdk-php/scripts/php.mjs --package sdk-laravel test
//
// The SDK installs from its composer.lock once there is one. The Laravel package resolves afresh
// every time, against the Laravel that LARAVEL names (the newest by default), because it is checked
// on two of them and reads the SDK's working copy through a path repository.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const php = process.env.PHP ?? '8.3';
const laravel = process.env.LARAVEL;
const image = `formfeed/sdk-php:${php}`;

const commands = {
  test: 'vendor/bin/phpunit',
  stan: 'vendor/bin/phpstan analyse --no-progress --memory-limit=1G',
  cs: 'vendor/bin/php-cs-fixer check --diff',
  fix: 'vendor/bin/php-cs-fixer fix',
  lint: 'vendor/bin/php-cs-fixer check --diff && vendor/bin/phpstan analyse --no-progress --memory-limit=1G',
};

let args = process.argv.slice(2);
let name = 'sdk-php';
if (args[0] === '--package') {
  name = args[1] ?? '';
  args = args.slice(2);
}
if (!['sdk-php', 'sdk-laravel'].includes(name)) {
  console.error(`unknown package ${name}; sdk-php or sdk-laravel`);
  process.exit(2);
}
if (laravel !== undefined && !/^\d+$/.test(laravel)) {
  console.error(`LARAVEL is a major version such as 12, not ${laravel}`);
  process.exit(2);
}

const [task = 'test', ...rest] = args;
const command =
  task === 'composer' ? `composer ${rest.join(' ')}` : commands[task];
if (!command) {
  console.error(
    `unknown task ${task}; one of ${Object.keys(commands).join(', ')}, composer`,
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
    `PHP=${php}`,
    '-t',
    image,
    resolve(here, '../docker'),
  ]);
  if (status !== 0) process.exit(status);
}

const quiet = '--no-progress --quiet --prefer-dist';
const install =
  task === 'composer'
    ? ''
    : name === 'sdk-laravel'
      ? `composer update ${quiet}${laravel ? ` --with laravel/framework:^${laravel}.0` : ''} && `
      : `composer install ${quiet} && `;
process.exit(
  run([
    'run',
    '--rm',
    '-v',
    `${repo}:/repo`,
    '-v',
    'formfeed-composer-cache:/tmp/composer-cache',
    '-e',
    'COMPOSER_CACHE_DIR=/tmp/composer-cache',
    '-w',
    `/repo/packages/${name}`,
    image,
    'sh',
    '-c',
    `${install}${command}`,
  ]),
);
