import { HttpMethod } from '@activepieces/pieces-common';
import { createAction, Property } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { formfeedRequest, type Render } from '../common/client';
import { finishRender } from '../common/finish';
import { filename, pageOutput, saveFile, settings } from '../common/props';
import { parseObject, renderBody } from '../common/utils';

export const createDocumentFromHtml = createAction({
  auth: formfeedAuth,
  name: 'create_document_from_html',
  displayName: 'Create Document from HTML',
  description: 'Renders HTML to a PDF or an image without a stored template.',
  props: {
    html: Property.LongText({
      displayName: 'HTML',
      description: 'The document as HTML, up to 5 MB. Template expressions are filled from **Data**.',
      required: true,
    }),
    engine: Property.StaticDropdown({
      displayName: 'Template language',
      description: 'How expressions in the HTML are written.',
      required: false,
      defaultValue: 'jinja2',
      options: {
        options: [
          { label: 'Jinja2', value: 'jinja2' },
          { label: 'Liquid', value: 'liquid' },
          { label: 'Handlebars', value: 'handlebars' },
        ],
      },
    }),
    data: Property.Json({
      displayName: 'Data (JSON)',
      description: 'Values for the expressions in the HTML.',
      required: false,
    }),
    output: pageOutput,
    filename,
    settings,
    saveFile,
  },
  async run(context) {
    const { propsValue } = context;
    const body = renderBody({
      html: propsValue.html,
      engine: propsValue.engine ?? undefined,
      data: parseObject(propsValue.data),
      output: propsValue.output ?? undefined,
      filename: propsValue.filename ?? undefined,
      settings: parseObject(propsValue.settings, 'Settings'),
    });
    const render = await formfeedRequest<Render>({ auth: context.auth, method: HttpMethod.POST, path: '/renders', body });
    return finishRender({
      auth: context.auth,
      files: context.files,
      render,
      saveFile: propsValue.saveFile ?? undefined,
      filename: propsValue.filename ?? undefined,
    });
  },
});
