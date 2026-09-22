import { HttpMethod } from '@activepieces/pieces-common';
import { createAction, Property } from '@activepieces/pieces-framework';
import FormData from 'form-data';
import { formfeedAuth } from '../auth';
import { formfeedRequest } from '../common/client';

/** Puts an image or PDF into the workspace file library, where templates use it with `asset()`. */
export const uploadFile = createAction({
  auth: formfeedAuth,
  name: 'upload_file',
  displayName: 'Upload File',
  description: 'Adds an image or PDF to the file library, where templates use it by name.',
  props: {
    file: Property.File({
      displayName: 'File',
      description: 'PNG, JPEG, WebP, GIF, SVG, AVIF or PDF, up to 10 MB.',
      required: true,
    }),
    name: Property.ShortText({
      displayName: 'Name in library',
      description: "The name templates use with `asset()`, for example `brand/logo.png`. The file's own name when empty. Uploading a name again replaces that file.",
      required: false,
    }),
  },
  async run(context) {
    const { file } = context.propsValue;
    const name = context.propsValue.name?.trim() || file.filename;
    const form = new FormData();
    form.append('file', file.data, { filename: name.split('/').pop() || 'file' });
    form.append('name', name);
    return formfeedRequest<Record<string, unknown>>({
      auth: context.auth,
      method: HttpMethod.POST,
      path: '/files',
      body: form,
      headers: form.getHeaders(),
    });
  },
});
