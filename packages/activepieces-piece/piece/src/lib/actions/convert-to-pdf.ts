import { HttpMethod } from '@activepieces/pieces-common';
import { createAction, Property } from '@activepieces/pieces-framework';
import FormData from 'form-data';
import { formfeedAuth } from '../auth';
import { formfeedRequest, type Render } from '../common/client';
import { finishRender } from '../common/finish';
import { saveFile } from '../common/props';
import { convertFields, formValue, pdfNameFor } from '../common/utils';

/**
 * Convert to PDF (spec 22 §3, §7): a Word, Excel, PowerPoint, OpenDocument or RTF file of an earlier
 * step, uploaded as multipart and not kept, or the render of a Word or PowerPoint template.
 * Starter plan and above.
 */
export const convertToPdf = createAction({
  auth: formfeedAuth,
  name: 'convert_to_pdf',
  displayName: 'Convert Document to PDF',
  description: 'Turns a Word, Excel, PowerPoint, OpenDocument or RTF file, or the render of a Word or PowerPoint template, into a PDF (Starter plan and above).',
  props: {
    file: Property.File({
      displayName: 'File',
      description: 'DOCX, XLSX, PPTX, ODT, ODS, ODP, DOC, XLS, PPT or RTF, up to 20 MB. It is converted and not kept. Leave empty to convert a render instead.',
      required: false,
    }),
    renderId: Property.ShortText({
      displayName: 'Render ID',
      description: 'Instead of a file: the ID (`rnd_…`) of a render of a Word or PowerPoint template, for example from **Create Document** with output DOCX.',
      required: false,
    }),
    pageRanges: Property.ShortText({
      displayName: 'Page ranges',
      description: 'Pages to convert, for example `1-3,5`. All pages when empty.',
      required: false,
    }),
    landscape: Property.Checkbox({
      displayName: 'Landscape',
      description: 'For spreadsheets and documents without their own page setup.',
      required: false,
    }),
    singlePageSheets: Property.Checkbox({
      displayName: 'One page per sheet',
      description: 'Each spreadsheet sheet on one page.',
      required: false,
    }),
    filename: Property.ShortText({
      displayName: 'File name',
      description: "The PDF's name. The file's own name with `.pdf` when empty.",
      required: false,
    }),
    saveFile,
  },
  async run(context) {
    const { propsValue } = context;
    const renderId = propsValue.renderId?.trim();
    if (Boolean(propsValue.file) === Boolean(renderId))
      throw new Error('Provide either a file or the ID of a Word or PowerPoint render.');
    const fields = convertFields({
      renderId,
      pageRanges: propsValue.pageRanges ?? undefined,
      landscape: propsValue.landscape ?? undefined,
      singlePageSheets: propsValue.singlePageSheets ?? undefined,
      filename: propsValue.filename ?? undefined,
    });
    let render: Render;
    if (renderId) {
      render = await formfeedRequest<Render>({ auth: context.auth, method: HttpMethod.POST, path: '/pdf/convert', body: fields });
    } else {
      const file = propsValue.file!;
      fields['filename'] ??= pdfNameFor(file.filename);
      const form = new FormData();
      form.append('file', file.data, { filename: file.filename });
      for (const [key, value] of Object.entries(fields)) form.append(key, formValue(value));
      render = await formfeedRequest<Render>({
        auth: context.auth,
        method: HttpMethod.POST,
        path: '/pdf/convert',
        body: form,
        headers: form.getHeaders(),
      });
    }
    return finishRender({
      auth: context.auth,
      files: context.files,
      render,
      saveFile: propsValue.saveFile ?? undefined,
      filename: fields['filename'] as string | undefined,
    });
  },
});
