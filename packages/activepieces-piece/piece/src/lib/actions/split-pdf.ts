import { createAction, Property } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { type Render } from '../common/client';
import { finishRender } from '../common/finish';
import { pdfToolRequest } from '../common/pdf-request';
import { pdfSourceOf, splitFields } from '../common/pdf-tools';
import { pdfFile, saveFile, storedPdf } from '../common/props';

/** Split PDF (plan 30): parts every N pages or by page ranges, one ZIP. Starter plan and above. */
export const splitPdf = createAction({
  auth: formfeedAuth,
  name: 'split_pdf',
  displayName: 'Split PDF',
  description:
    'Cuts a PDF into parts, every N pages or by page ranges, delivered as one ZIP (Starter plan and above).',
  props: {
    file: pdfFile,
    source: storedPdf,
    ranges: Property.Array({
      displayName: 'Page ranges',
      description:
        'One part per entry, each a page selection such as `1-3,5`, or `4-` for page 4 to the last. Leave empty to split every N pages.',
      required: false,
    }),
    every: Property.Number({
      displayName: 'Pages per part',
      description:
        'Without page ranges: this many pages per part, 1 when empty.',
      required: false,
    }),
    filename: Property.ShortText({
      displayName: 'File name',
      description:
        "The name of the ZIP: `parts.zip` holds `parts-1.pdf`, `parts-2.pdf` and so on, and a single part is `parts.pdf`. The source's name when empty.",
      required: false,
    }),
    saveFile,
  },
  async run(context) {
    const { propsValue } = context;
    const { file, source } = pdfSourceOf(propsValue.file, propsValue.source);
    const fields = splitFields({
      source,
      filename: propsValue.filename ?? undefined,
      ranges: propsValue.ranges,
      every: propsValue.every,
    });
    const render = await pdfToolRequest<Render>(
      context.auth,
      'split',
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
