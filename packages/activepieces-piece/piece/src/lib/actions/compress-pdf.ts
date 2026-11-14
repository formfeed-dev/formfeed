import { createAction, Property } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { type Render } from '../common/client';
import { finishRender } from '../common/finish';
import { pdfToolRequest } from '../common/pdf-request';
import { compressFields, pdfSourceOf } from '../common/pdf-tools';
import { pdfFile, saveFile, storedPdf } from '../common/props';

/** Compress PDF (plan 30): smaller without losing anything. Starter plan and above. */
export const compressPdf = createAction({
  auth: formfeedAuth,
  name: 'compress_pdf',
  displayName: 'Compress PDF',
  description:
    'Makes a PDF smaller without losing anything: image quality is never lowered (Starter plan and above).',
  props: {
    file: pdfFile,
    source: storedPdf,
    filename: Property.ShortText({
      displayName: 'File name',
      description: "The name of the smaller PDF. The source's name when empty.",
      required: false,
    }),
    saveFile,
  },
  async run(context) {
    const { propsValue } = context;
    const { file, source } = pdfSourceOf(propsValue.file, propsValue.source);
    const fields = compressFields({
      source,
      filename: propsValue.filename ?? undefined,
    });
    const render = await pdfToolRequest<Render>(
      context.auth,
      'compress',
      fields,
      file,
    );
    return finishRender({
      auth: context.auth,
      files: context.files,
      render,
      saveFile: propsValue.saveFile ?? undefined,
      filename: propsValue.filename ?? undefined,
      nameFromLink: true,
    });
  },
});
