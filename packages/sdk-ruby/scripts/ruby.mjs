// Runs the Ruby SDK's checks in Docker (plan 34), so `pnpm nx test sdk-ruby` works on any machine
// with Docker and CI runs the same thing: the official Ruby image (docker/Dockerfile), the repository
// mounted at /repo so the tests read packages/api-types' vectors and goldens, the gems in the volume
// formfeed-gem-cache.
//
//   node packages/sdk-ruby/scripts/ruby.mjs test|lint|fix|build|bundle [args...]
//   RUBY=4.0 node packages/sdk-ruby/scripts/ruby.mjs test        (another Ruby; 3.3 by default)
//
// The Gemfile is copied into the volume per Ruby version and resolved there, so its lockfile never
// lands in the repository and the two Rubies of CI do not share one; nothing the checks do writes
// into the mounted folder but `fix`. `build` packs the gem from a copy of this folder alone, as a
// release builds it without the repository, installs it and loads it.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const ruby = process.env.RUBY ?? '3.3';
if (!/^\d+\.\d+(\.\d+)?(-[a-z0-9]+)?$/.test(ruby)) {
  console.error(`RUBY is a version such as 3.3 or 4.0, not ${ruby}`);
  process.exit(2);
}
const image = `formfeed/sdk-ruby:${ruby}`;

const gemfiles = `/gems/gemfiles/${ruby}`;
const build = [
  'rm -rf /tmp/gem && mkdir /tmp/gem',
  'cp -R formfeed.gemspec LICENSE README.md lib /tmp/gem/',
  'cd /tmp/gem',
  'gem build --strict formfeed.gemspec',
  'gem install --local --no-document ./formfeed-*.gem',
  'cd /',
  `ruby -e 'require "formfeed"; Formfeed::Client.new(api_key: "ff_test_0"); puts "formfeed #{Formfeed::VERSION} loads from #{Gem.loaded_specs.fetch("formfeed").full_gem_path}"'`,
].join(' && ');
const commands = {
  test: 'bundle exec rake test',
  lint: 'bundle exec rubocop',
  fix: 'bundle exec rubocop --autocorrect',
  build,
};

const [task = 'test', ...rest] = process.argv.slice(2);
const command = task === 'bundle' ? `bundle ${rest.join(' ')}` : commands[task];
if (!command) {
  console.error(
    `unknown task ${task}; one of ${Object.keys(commands).join(', ')}, bundle`,
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
    `RUBY=${ruby}`,
    '-t',
    image,
    resolve(here, '../docker'),
  ]);
  if (status !== 0) process.exit(status);
}

// the gem build needs no development gems; everything else installs them first, which reads the
// network only when the Gemfile asks for something the volume does not hold
const install =
  task === 'build' || task === 'bundle'
    ? ''
    : '(bundle check > /dev/null 2>&1 || bundle install --quiet) && ';
process.exit(
  run([
    'run',
    '--rm',
    '-v',
    `${repo}:/repo`,
    '-v',
    'formfeed-gem-cache:/gems',
    '-e',
    `BUNDLE_GEMFILE=${gemfiles}/Gemfile`,
    '-w',
    '/repo/packages/sdk-ruby',
    image,
    'sh',
    '-c',
    `mkdir -p ${gemfiles} && cp Gemfile ${gemfiles}/Gemfile && ${install}${command}`,
  ]),
);
