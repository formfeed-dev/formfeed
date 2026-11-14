import { createAction, Property } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { type Render } from '../common/client';
import { finishRender } from '../common/finish';
import { pdfToolRequest } from '../common/pdf-request';
import { pdfSourceOf, toImageFields } from '../common/pdf-tools';
import { pdfFile, saveFile, storedPdf } from '../common/props';

/** Convert PDF to Image (plan 30): pages as PNG or JPEG, several as a ZIP. Starter plan and above. */
export const pdfToImage = createAction({
  auth: formfeedAuth,
  name: 'pdf_to_image',
  displayName: 'Convert PDF to Image',
  description:
    'Draws pages of a PDF as PNG or JPEG pictures: one page as the picture, several as a ZIP (Starter plan and above).',
  props: {
    file: pdfFile,
    source: storedPdf,
    pages: Property.ShortText({
      displayName: 'Pages',
      description:
        'The pages to draw, such as `1`, `1-3,5` or `2-` for page 2 to the last. Every page when empty, at most 100 in one call.',
      required: false,
    }),
    format: Property.StaticDropdown({
      displayName: 'Format',
      required: false,
      defaultValue: 'png',
      options: {
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpg' },
        ],
      },
    }),
    dpi: Property.Number({
      displayName: 'Resolution (DPI)',
      description:
        '36 to 300, 150 when empty. At 72 a pixel stands for a point.',
      required: false,
    }),
    quality: Property.Number({
      displayName: 'JPEG quality',
      description: '1 to 100. Ignored for PNG.',
      required: false,
    }),
    filename: Property.ShortText({
      displayName: 'File name',
      description:
        "The name of the result: one page is `thumb.png`, several are `thumb.zip` with `thumb-1.png` and so on. The source's name when empty.",
      required: false,
    }),
    saveFile,
  },
  async run(context) {
    const { propsValue } = context;
    const { file, source } = pdfSourceOf(propsValue.file, propsValue.source);
    const fields = toImageFields({
      source,
      filename: propsValue.filename ?? undefined,
      pages: propsValue.pages ?? undefined,
      format: propsValue.format ?? undefined,
      dpi: propsValue.dpi,
      quality: propsValue.quality,
    });
    const render = await pdfToolRequest<Render>(
      context.auth,
      'toImage',
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
