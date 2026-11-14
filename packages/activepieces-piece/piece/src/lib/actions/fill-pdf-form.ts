import { createAction, Property } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { type Render } from '../common/client';
import { finishRender } from '../common/finish';
import { pdfToolRequest } from '../common/pdf-request';
import { fillFields, fillValues, pdfSourceOf } from '../common/pdf-tools';
import { pdfFile, saveFile, storedPdf } from '../common/props';

/**
 * Fill PDF Form (plan 30, spec 21 §3): values by the full field names Get PDF Info lists, kept
 * fillable or flattened. The values are never stored. Starter plan and above.
 */
export const fillPdfForm = createAction({
  auth: formfeedAuth,
  name: 'fill_pdf_form',
  displayName: 'Fill PDF Form',
  description:
    'Fills the fields of a PDF form by their names, kept fillable or drawn into the pages (Starter plan and above).',
  props: {
    file: pdfFile,
    source: storedPdf,
    fields: Property.Array({
      displayName: 'Fields',
      description:
        'The full name of each field, as **Get PDF Info** lists it, and its value: text, `true` or `false` for a check box, an option of a choice or radio group, or a JSON list such as `["a","b"]` for a list box that takes several. An entry without a value leaves its field as it is.',
      required: false,
      properties: {
        name: Property.ShortText({ displayName: 'Name', required: true }),
        value: Property.ShortText({ displayName: 'Value', required: false }),
      },
    }),
    flatten: Property.Checkbox({
      displayName: 'Flatten',
      description:
        'Draws the values into the pages and removes the fields, so they can no longer be changed.',
      required: false,
    }),
    lenient: Property.Checkbox({
      displayName: 'Leave out what does not fit',
      description:
        "Leaves out a name the form lacks or a value its field does not take, and lists them in the result's `form.skipped`, instead of failing.",
      required: false,
    }),
    filename: Property.ShortText({
      displayName: 'File name',
      description: "The name of the filled PDF. The source's name when empty.",
      required: false,
    }),
    saveFile,
  },
  async run(context) {
    const { propsValue } = context;
    const { file, source } = pdfSourceOf(propsValue.file, propsValue.source);
    const fields = fillFields({
      source,
      filename: propsValue.filename ?? undefined,
      values: fillValues(propsValue.fields),
      flatten: propsValue.flatten,
      lenient: propsValue.lenient,
    });
    const render = await pdfToolRequest<Render>(
      context.auth,
      'fill',
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
