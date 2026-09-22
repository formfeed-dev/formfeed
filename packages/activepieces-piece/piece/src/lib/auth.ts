import { PieceAuth } from '@activepieces/pieces-framework';
import { formfeedRequest, problemError } from './common/client';

/**
 * A workspace API key (spec 04 §1). The check is `GET /account`, which needs the `account:read` scope
 * (a default of new keys; a key without it fails the connection with 403).
 * The campaign in the link is the Activepieces listing's (apps/landing/src/lib/listings.ts).
 */
export const formfeedAuth = PieceAuth.SecretText({
  displayName: 'API key',
  description: `Create a key at [app.formfeed.dev](https://app.formfeed.dev/keys?utm_source=activepieces) under **API keys**, keeping the default scopes (\`account:read\` is the connection check) and adding \`file:write\` and \`webhook:manage\`.

A key starting with \`ff_test_\` renders for free (with a watermark on the Free plan), which is what you want while building a flow.`,
  required: true,
  validate: async ({ auth }) => {
    try {
      await formfeedRequest({ auth, path: '/account' });
      return { valid: true };
    } catch (error) {
      return { valid: false, error: problemError(error).message };
    }
  },
});
