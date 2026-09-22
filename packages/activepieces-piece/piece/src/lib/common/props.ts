import { DynamicPropsValue, Property } from '@activepieces/pieces-framework';
import { formfeedAuth } from '../auth';
import { formfeedRequest } from './client';
import { schemaFields, versionOptions, type ChannelSummary } from './utils';

interface TemplatePage {
  data?: Array<{ slug: string; name: string; kind: string }>;
  next_cursor?: string | null;
}

/** At most this many templates in the dropdown (ten pages of the API's largest page). */
const MAX_PAGES = 10;

export const templateDropdown = Property.Dropdown({
  auth: formfeedAuth,
  displayName: 'Template',
  description: 'A template of the workspace. It renders its published version unless you choose another.',
  required: true,
  refreshers: [],
  options: async ({ auth }) => {
    if (!auth) return { disabled: true, options: [], placeholder: 'Connect your Formfeed account first' };
    const options: Array<{ label: string; value: string }> = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await formfeedRequest<TemplatePage>({
        auth,
        path: '/templates',
        queryParams: { limit: '100', ...(cursor ? { cursor } : {}) },
      });
      for (const template of result.data ?? []) options.push({ label: `${template.name} (${template.kind})`, value: template.slug });
      cursor = result.next_cursor;
      if (!cursor) break;
    }
    return { disabled: false, options, placeholder: options.length === 0 ? 'No templates in this workspace yet' : undefined };
  },
});

export const versionDropdown = Property.Dropdown({
  auth: formfeedAuth,
  displayName: 'Version',
  description: 'The release channel to render. `published` unless you choose another.',
  required: false,
  refreshers: ['template'],
  options: async ({ auth, template }) => {
    if (!auth || !template) return { disabled: true, options: [], placeholder: 'Choose a template first' };
    const channels = await formfeedRequest<{ data?: ChannelSummary[] }>({
      auth,
      path: `/templates/${encodeURIComponent(String(template))}/channels`,
    }).catch(() => ({ data: [] }));
    const options = versionOptions(channels.data ?? []);
    return { disabled: options.length === 0, options, placeholder: options.length === 0 ? 'published (the template has no other channel)' : undefined };
  },
});

/** One field per value of the template's data schema, so a flow maps named fields. */
export const templateFields = Property.DynamicProperties({
  auth: formfeedAuth,
  displayName: 'Template fields',
  description: "The fields of the template's data schema, or of its sample data when it has none.",
  required: false,
  refreshers: ['template'],
  props: async ({ auth, template }) => {
    if (!auth || !template) return {};
    const schema = await formfeedRequest<unknown>({
      auth,
      path: `/templates/${encodeURIComponent(String(template))}/schema`,
    }).catch(() => null);
    const props: DynamicPropsValue = {};
    for (const field of schemaFields(schema)) {
      const common = { displayName: field.label, description: field.description, required: field.required };
      props[field.key] =
        field.type === 'number'
          ? Property.Number(common)
          : field.type === 'boolean'
            ? Property.Checkbox(common)
            : Property.ShortText(common);
    }
    return props;
  },
});

export const dataJson = Property.Json({
  displayName: 'Data (JSON)',
  description: 'Template data as JSON, merged over the fields above. Use it for line items and other lists.',
  required: false,
});

export const templateOutput = Property.StaticDropdown({
  displayName: 'Output',
  description:
    "Leave empty for the template's own format: PDF, the image format of an image template, or the default output of a Word or PowerPoint template. Word templates render DOCX or PDF, PowerPoint templates PPTX or PDF.",
  required: false,
  options: {
    options: [
      { label: 'PDF', value: 'pdf' },
      { label: 'PNG', value: 'png' },
      { label: 'JPG', value: 'jpg' },
      { label: 'WebP', value: 'webp' },
      { label: 'Word (DOCX)', value: 'docx' },
      { label: 'PowerPoint (PPTX)', value: 'pptx' },
    ],
  },
});

export const pageOutput = Property.StaticDropdown({
  displayName: 'Output',
  description: 'The format of the document.',
  required: false,
  defaultValue: 'pdf',
  options: {
    options: [
      { label: 'PDF', value: 'pdf' },
      { label: 'PNG', value: 'png' },
      { label: 'JPG', value: 'jpg' },
      { label: 'WebP', value: 'webp' },
    ],
  },
});

export const filename = Property.ShortText({
  displayName: 'File name',
  description: 'The document\'s name, for example `invoice-2026-0042.pdf`. May contain template expressions such as `invoice-{{ invoice.number }}.pdf`.',
  required: false,
});

export const settings = Property.Json({
  displayName: 'Settings (JSON)',
  description: 'Paper size, margins, header and footer. See [the documentation](https://docs.formfeed.dev/api/rendering#override-settings-per-request).',
  required: false,
});

export const saveFile = Property.Checkbox({
  displayName: 'Return the file',
  description: 'Download the document so the next step can attach or upload it. When off, the step returns the download URL only.',
  required: false,
  defaultValue: true,
});
