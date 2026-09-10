import type {
  IDataObject,
  IHookFunctions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { TRIGGER_EVENTS, baseUrl, type FormfeedCredentials } from '../../lib/api';

/**
 * Starts a workflow when Formfeed reports a finished render, batch or quota warning. The node
 * registers its own webhook endpoint on activation and removes it again on deactivation.
 */
export class FormfeedTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Formfeed Trigger',
    name: 'formfeedTrigger',
    icon: 'file:formfeed.svg',
    group: ['trigger'],
    version: 1,
    description: 'Runs when a Formfeed render or batch finishes',
    defaults: { name: 'Formfeed Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'formfeedApi', required: true }],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'webhook',
      },
    ],
    properties: [
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        required: true,
        default: ['render.completed'],
        options: TRIGGER_EVENTS.map((event) => ({ name: event, value: event })),
        description: 'Which events start this workflow',
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const stored = this.getWorkflowStaticData('node')['webhookId'] as string | undefined;
        if (!stored) return false;
        const list = (await apiRequest(this, 'GET', '/webhooks')) as { data?: Array<{ id: string }> };
        return (list.data ?? []).some((endpoint) => endpoint.id === stored);
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const created = (await apiRequest(this, 'POST', '/webhooks', {
          url: this.getNodeWebhookUrl('default'),
          events: this.getNodeParameter('events', 0) as string[],
          description: 'n8n',
        })) as { id: string; secret?: string };
        const data = this.getWorkflowStaticData('node');
        data['webhookId'] = created.id;
        // shown once by the API; kept so a Code node can verify the signature if a workflow wants to
        if (created.secret) data['secret'] = created.secret;
        return true;
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData('node');
        const id = data['webhookId'] as string | undefined;
        if (!id) return true;
        try {
          await apiRequest(this, 'DELETE', `/webhooks/${encodeURIComponent(id)}`);
        } catch {
          // already gone: nothing to clean up
        }
        delete data['webhookId'];
        delete data['secret'];
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const body = this.getBodyData() as IDataObject;
    return { workflowData: [this.helpers.returnJsonArray([body])] };
  }
}

async function apiRequest(
  context: IHookFunctions,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const credentials = (await context.getCredentials('formfeedApi')) as unknown as FormfeedCredentials;
  return context.helpers.httpRequestWithAuthentication.call(context, 'formfeedApi', {
    method,
    url: `${baseUrl(credentials)}${path}`,
    json: true,
    ...(body === undefined ? {} : { body }),
  });
}
