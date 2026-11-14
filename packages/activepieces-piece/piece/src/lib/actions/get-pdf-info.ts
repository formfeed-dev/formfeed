import { createAction } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { pdfToolRequest } from '../common/pdf-request';
import { infoFields, pdfSourceOf } from '../common/pdf-tools';
import { pdfFile, storedPdf } from '../common/props';

/**
 * Get PDF Info (plan 30): page count, page sizes, properties and the form's fields, whose full
 * names Fill PDF Form takes. Free on every plan; it creates no render.
 */
export const getPdfInfo = createAction({
  auth: formfeedAuth,
  name: 'get_pdf_info',
  displayName: 'Get PDF Info',
  description:
    'Gets the page count, page sizes, document properties and form fields of a PDF, with the names Fill PDF Form takes. Free on every plan.',
  props: {
    file: pdfFile,
    source: storedPdf,
  },
  async run(context) {
    const { file, source } = pdfSourceOf(
      context.propsValue.file,
      context.propsValue.source,
    );
    return pdfToolRequest<Record<string, unknown>>(
      context.auth,
      'info',
      infoFields({ source }),
      file,
    );
  },
});
