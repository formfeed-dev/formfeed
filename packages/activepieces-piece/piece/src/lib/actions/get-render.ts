import { createAction, Property } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { formfeedRequest, type Render } from '../common/client';

export const getRender = createAction({
  auth: formfeedAuth,
  name: 'get_render',
  displayName: 'Get Render',
  description: 'Returns a render by its ID, with a fresh download URL once it has succeeded.',
  props: {
    renderId: Property.ShortText({
      displayName: 'Render ID',
      description: 'The ID of a render (`rnd_…`), for example from **Create Document**.',
      required: true,
    }),
  },
  async run(context) {
    return formfeedRequest<Render>({
      auth: context.auth,
      path: `/renders/${encodeURIComponent(context.propsValue.renderId.trim())}`,
    });
  },
});
