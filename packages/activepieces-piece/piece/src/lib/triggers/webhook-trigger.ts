import { HttpMethod } from '@activepieces/pieces-common';
import { createTrigger, Property, TriggerStrategy } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { formfeedRequest, type Render } from '../common/client';
import { headerValue, verifySignature } from '../common/utils';

const HOOK_ID = 'formfeed_webhook_id';
const HOOK_SECRET = 'formfeed_webhook_secret';

export interface WebhookEvent {
  id: string;
  type: string;
  created_at: string;
  workspace_id: string | null;
  data: Record<string, unknown>;
}

interface Definition {
  name: string;
  displayName: string;
  description: string;
  events: string[];
  sampleData: WebhookEvent;
  /** Recent items for the test button, shaped like deliveries; none when the API cannot list them. */
  recent?: (auth: unknown) => Promise<WebhookEvent[]>;
}

/** Wraps a render the way a delivery does, for the test button. */
export const asEvent = (type: string, render: Render): WebhookEvent => ({
  id: `evt_test_${render.id}`,
  type,
  created_at: String(render['completed_at'] ?? render['created_at'] ?? ''),
  workspace_id: null,
  data: render,
});

/**
 * A trigger that registers a webhook endpoint of the workspace for its events, keeps the endpoint's
 * signing secret in the flow's store and returns only deliveries whose `Webhook-Signature` matches
 * (spec 04 §2.4).
 */
export function webhookTrigger(definition: Definition) {
  return createTrigger({
    auth: formfeedAuth,
    name: definition.name,
    displayName: definition.displayName,
    description: definition.description,
    type: TriggerStrategy.WEBHOOK,
    props: {
      environment: Property.StaticDropdown({
        displayName: 'Environment',
        description: "Which renders' events start the flow: those of live keys, of test keys, or both.",
        required: false,
        defaultValue: 'both',
        options: {
          options: [
            { label: 'Live and test renders', value: 'both' },
            { label: 'Live renders only', value: 'live' },
            { label: 'Test renders only', value: 'test' },
          ],
        },
      }),
    },
    sampleData: definition.sampleData,
    async onEnable(context) {
      const environment = context.propsValue.environment;
      const hook = await formfeedRequest<{ id: string; secret: string }>({
        auth: context.auth,
        method: HttpMethod.POST,
        path: '/webhooks',
        body: {
          url: context.webhookUrl,
          events: definition.events,
          ...(environment && environment !== 'both' ? { environments: [environment] } : {}),
          description: 'Activepieces',
        },
      });
      try {
        await context.store.put(HOOK_ID, hook.id);
        await context.store.put(HOOK_SECRET, hook.secret);
      } catch (error) {
        // an endpoint nobody can verify or remove must not stay behind
        await formfeedRequest({ auth: context.auth, method: HttpMethod.DELETE, path: `/webhooks/${hook.id}` }).catch(() => undefined);
        throw error;
      }
    },
    async onDisable(context) {
      const id = await context.store.get<string>(HOOK_ID);
      if (id) {
        await formfeedRequest({ auth: context.auth, method: HttpMethod.DELETE, path: `/webhooks/${encodeURIComponent(id)}` }).catch(
          () => undefined, // already removed in the app
        );
      }
      await context.store.delete(HOOK_ID);
      await context.store.delete(HOOK_SECRET);
    },
    async test(context) {
      const recent = definition.recent ? await definition.recent(context.auth).catch(() => []) : [];
      return recent.length > 0 ? recent : [definition.sampleData];
    },
    async run(context) {
      const secret = await context.store.get<string>(HOOK_SECRET);
      const payload = context.payload as { body: unknown; rawBody?: unknown; headers?: Record<string, unknown> };
      if (!verifySignature(secret, headerValue(payload.headers, 'webhook-signature'), payload.rawBody)) return [];
      const event = payload.body as WebhookEvent | undefined;
      if (!event?.id || !definition.events.includes(event.type)) return [];
      return [event];
    },
  });
}
