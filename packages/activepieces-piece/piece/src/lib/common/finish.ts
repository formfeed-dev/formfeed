import { downloadBytes, waitForRender, type Render } from './client';
import { downloadName } from './utils';

interface FilesService {
  write(params: { fileName: string; data: Buffer }): Promise<string>;
}

/**
 * What every document action returns: the finished render and, unless the flow turned it off, the
 * document as a file for the next step. A failed render throws with the API's problem detail.
 */
export async function finishRender(params: {
  auth: unknown;
  files: FilesService;
  render: Render;
  saveFile: boolean | undefined;
  filename: string | undefined;
}): Promise<Render & { file?: string; fileName?: string }> {
  const done = await waitForRender(params.auth, params.render);
  if (done.status === 'failed') {
    const problem = done.error ?? {};
    throw new Error(
      `Render ${done.id} failed: ${problem.detail || problem.title || 'unknown error'}${problem.code ? ` (${problem.code})` : ''}`,
    );
  }
  if (done.status !== 'succeeded' || params.saveFile === false || !done.download_url) return done;
  const fileName = downloadName(params.filename, done.id, done.output);
  const file = await params.files.write({ fileName, data: await downloadBytes(done.download_url) });
  return { ...done, file, fileName };
}
