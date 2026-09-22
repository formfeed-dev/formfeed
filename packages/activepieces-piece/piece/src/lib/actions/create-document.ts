import { HttpMethod } from '@activepieces/pieces-common';
import { createAction, Property } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { formfeedRequest, type Render } from '../common/client';
import { finishRender } from '../common/finish';
import {
  dataJson,
  filename,
  saveFile,
  templateDropdown,
  templateFields,
  templateOutput,
  versionDropdown,
} from '../common/props';
import { dataFromFields, mergeData, parseObject, renderBody } from '../common/utils';

export const createDocument = createAction({
  auth: formfeedAuth,
  name: 'create_document',
  displayName: 'Create Document',
  description: 'Renders a PDF, image, Word or PowerPoint document from one of your templates.',
  props: {
    template: templateDropdown,
    version: versionDropdown,
    fields: templateFields,
    data: dataJson,
    output: templateOutput,
    filename,
    locale: Property.ShortText({
      displayName: 'Locale',
      description: 'Overrides the template locale, for example `de-DE`.',
      required: false,
    }),
    saveFile,
  },
  async run(context) {
    const { propsValue } = context;
    const body = renderBody({
      template: propsValue.template,
      version: propsValue.version ?? undefined,
      data: mergeData(dataFromFields(propsValue.fields), parseObject(propsValue.data)),
      output: propsValue.output ?? undefined,
      filename: propsValue.filename ?? undefined,
      locale: propsValue.locale ?? undefined,
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
