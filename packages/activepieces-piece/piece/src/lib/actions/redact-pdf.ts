import { createAction, Property } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { type Render } from '../common/client';
import { finishRender } from '../common/finish';
import { pdfToolRequest } from '../common/pdf-request';
import { pdfSourceOf, redactFields } from '../common/pdf-tools';
import { pdfFile, saveFile, storedPdf } from '../common/props';

/**
 * Redact PDF (plan 30): texts and rectangles removed from the file itself, the result read again
 * before it is delivered (`redaction_incomplete` otherwise). Starter plan and above.
 */
export const redactPdf = createAction({
  auth: formfeedAuth,
  name: 'redact_pdf',
  displayName: 'Redact PDF',
  description:
    'Removes texts and areas from the PDF itself, not just from view, and checks the result before it is delivered (Starter plan and above).',
  props: {
    file: pdfFile,
    source: storedPdf,
    texts: Property.Array({
      displayName: 'Texts',
      description:
        'Texts to remove wherever they stand, such as a name or an IBAN, found whatever their spacing. They are never stored.',
      required: false,
    }),
    rectangles: Property.Array({
      displayName: 'Rectangles',
      description:
        'Areas to remove, in points from the top-left corner of the page as a viewer shows it (72 points are an inch). Give at least one text or rectangle.',
      required: false,
      properties: {
        page: Property.Number({ displayName: 'Page', required: true }),
        x: Property.Number({
          displayName: 'X',
          description: 'Points from the left edge of the page.',
          required: true,
        }),
        y: Property.Number({
          displayName: 'Y',
          description: 'Points from the top edge of the page.',
          required: true,
        }),
        width: Property.Number({ displayName: 'Width', required: true }),
        height: Property.Number({ displayName: 'Height', required: true }),
      },
    }),
    matchCase: Property.Checkbox({
      displayName: 'Match case',
      description: 'Finds a text only in the case it is written in.',
      required: false,
    }),
    wholeWords: Property.Checkbox({
      displayName: 'Whole words',
      description: 'Finds a text only as a whole word.',
      required: false,
    }),
    drawBox: Property.Checkbox({
      displayName: 'Draw a box',
      description:
        'Draws a box over each removed place. Without it the place is left blank.',
      required: false,
      defaultValue: true,
    }),
    boxColor: Property.ShortText({
      displayName: 'Box color',
      description: 'A hex color such as `#000000`. Black when empty.',
      required: false,
    }),
    filename: Property.ShortText({
      displayName: 'File name',
      description:
        "The name of the redacted PDF. The source's name when empty.",
      required: false,
    }),
    saveFile,
  },
  async run(context) {
    const { propsValue } = context;
    const { file, source } = pdfSourceOf(propsValue.file, propsValue.source);
    const fields = redactFields({
      source,
      filename: propsValue.filename ?? undefined,
      texts: propsValue.texts,
      rectangles: propsValue.rectangles,
      matchCase: propsValue.matchCase,
      wholeWords: propsValue.wholeWords,
      drawBox: propsValue.drawBox,
      boxColor: propsValue.boxColor ?? undefined,
    });
    const render = await pdfToolRequest<Render>(
      context.auth,
      'redact',
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
