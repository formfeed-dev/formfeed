import { formfeedRequest, type Render } from '../common/client';
import { asEvent, webhookTrigger } from './webhook-trigger';

const WORKSPACE = 'f0000000-0000-4000-8000-000000000001';

const recentRenders = (status: 'succeeded' | 'failed', type: string) => async (auth: unknown) => {
  const page = await formfeedRequest<{ data?: Render[] }>({ auth, path: '/renders', queryParams: { status, limit: '5' } });
  return (page.data ?? []).map((render) => asEvent(type, render));
};

export const renderCompleted = webhookTrigger({
  name: 'render_completed',
  displayName: 'Render Completed',
  description: 'Triggers when a render succeeds, whether it came from a flow, the app or the API.',
  events: ['render.completed'],
  recent: recentRenders('succeeded', 'render.completed'),
  sampleData: {
    id: 'evt_5b0c8e6f2d4a4c3e9b1a7f6e5d4c3b2a',
    type: 'render.completed',
    created_at: '2026-09-11T10:00:00Z',
    workspace_id: WORKSPACE,
    data: {
      id: 'rnd_01J8ZK4M3Q7X',
      status: 'succeeded',
      output: 'pdf',
      download_url: `https://cdn.formfeed.dev/o/eu/${WORKSPACE}/rnd_01J8ZK4M3Q7X/invoice-2026-0042.pdf?exp=1758189600&sig=0000`,
      page_count: 2,
      units: 1,
      environment: 'live',
      template: { id: 'tpl_01J8ZK4M3Q', slug: 'invoice-de', version: 3, channel: 'published', canary: false },
      error: null,
      meta: { source: 'activepieces' },
      created_at: '2026-09-11T09:59:58Z',
      completed_at: '2026-09-11T10:00:00Z',
    },
  },
});

export const renderFailed = webhookTrigger({
  name: 'render_failed',
  displayName: 'Render Failed',
  description: 'Triggers when a render fails for good, with the problem that stopped it.',
  events: ['render.failed'],
  recent: recentRenders('failed', 'render.failed'),
  sampleData: {
    id: 'evt_7d2e0a8b4f6c4e5a9d3c1b0a9f8e7d6c',
    type: 'render.failed',
    created_at: '2026-09-11T10:05:00Z',
    workspace_id: WORKSPACE,
    data: {
      id: 'rnd_01J8ZK9P2R4T',
      status: 'failed',
      output: 'pdf',
      download_url: null,
      page_count: null,
      units: 0,
      environment: 'live',
      template: { id: 'tpl_01J8ZK4M3Q', slug: 'invoice-de', version: 3, channel: 'published', canary: false },
      error: {
        type: 'https://docs.formfeed.dev/errors/template-runtime',
        title: 'Template runtime error',
        status: 422,
        code: 'template_runtime_error',
        detail: "'invoice' is undefined (line 12)",
      },
      meta: { source: 'activepieces' },
      created_at: '2026-09-11T10:04:59Z',
      completed_at: '2026-09-11T10:05:00Z',
    },
  },
});

export const batchFinished = webhookTrigger({
  name: 'batch_finished',
  displayName: 'Batch Finished',
  description: 'Triggers when a batch finishes, with the URL of its zip and every render.',
  events: ['job.completed', 'job.failed'],
  sampleData: {
    id: 'evt_2a4c6e8f0b1d4f3a8c5e7a9b1d3f5a7c',
    type: 'job.completed',
    created_at: '2026-09-11T11:00:00Z',
    workspace_id: WORKSPACE,
    data: {
      id: 'job_01J8ZK4M3Q',
      status: 'completed',
      total: 2,
      succeeded: 2,
      failed: 0,
      zip_url: `https://cdn.formfeed.dev/o/eu/${WORKSPACE}/job_01J8ZK4M3Q/documents.zip?exp=1758193200&sig=0000`,
      items: [
        { id: 'rnd_01J8ZKA1B2C3', status: 'succeeded', output: 'pdf', page_count: 1, units: 1 },
        { id: 'rnd_01J8ZKA1B2C4', status: 'succeeded', output: 'pdf', page_count: 1, units: 1 },
      ],
      meta: {},
      created_at: '2026-09-11T10:58:00Z',
      completed_at: '2026-09-11T11:00:00Z',
    },
  },
});
