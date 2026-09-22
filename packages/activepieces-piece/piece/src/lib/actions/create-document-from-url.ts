import { HttpMethod } from '@activepieces/pieces-common';
import { createAction, Property } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { formfeedRequest, type Render } from '../common/client';
import { finishRender } from '../common/finish';
import { filename, pageOutput, saveFile, settings } from '../common/props';
import { parseObject, renderBody } from '../common/utils';

export const createDocumentFromUrl = createAction({
  auth: formfeedAuth,
  name: 'create_document_from_url',
  displayName: 'Create Document from URL',
  description: 'Renders a public web page to a PDF or an image.',
  props: {
    url: Property.ShortText({
      displayName: 'URL',
      description: 'A public `https` page, for example `https://example.com/report`.',
      required: true,
    }),
    output: pageOutput,
    filename,
    settings,
    saveFile,
  },
  async run(context) {
    const { propsValue } = context;
    const body = renderBody({
      url: propsValue.url,
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
