import { run } from './commands';

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
