import { startHttp, startStdio } from './lib/transports';

/**
 * `formfeed-mcp` (stdio, default) or `formfeed-mcp --http [--port 8790] [--host 0.0.0.0]`.
 * FORMFEED_API_KEY is required for stdio; the HTTP endpoint takes the key from each request.
 * FORMFEED_BASE_URL / FORMFEED_REGION select the API host.
 */
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const baseUrl = process.env['FORMFEED_BASE_URL'];
const region = process.env['FORMFEED_REGION'] as 'eu' | 'us' | undefined;

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'formfeed-mcp: Model Context Protocol server for Formfeed\n\n  formfeed-mcp              stdio; needs FORMFEED_API_KEY\n  formfeed-mcp --http       Streamable HTTP on --port (8790) and --host (127.0.0.1); the key comes from Authorization: Bearer\n',
  );
} else if (args.includes('--http')) {
  startHttp({ port: Number(flag('--port') ?? 8790), host: flag('--host') ?? '127.0.0.1', baseUrl, region }).then((h) =>
    process.stderr.write(`formfeed-mcp listening on ${h.url}\n`),
  );
} else {
  const apiKey = process.env['FORMFEED_API_KEY'];
  if (!apiKey) {
    process.stderr.write('FORMFEED_API_KEY is required for the stdio server\n');
    process.exitCode = 3;
  } else {
    startStdio({ apiKey, baseUrl, region }).catch((e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
  }
}
