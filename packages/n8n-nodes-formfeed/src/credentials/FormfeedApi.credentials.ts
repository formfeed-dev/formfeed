import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

/** API key of one Formfeed workspace. Test keys render for free and watermark the output. */
export class FormfeedApi implements ICredentialType {
  name = 'formfeedApi';
  displayName = 'Formfeed API';
  documentationUrl = 'https://docs.formfeed.dev/integrations/n8n';

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      placeholder: 'ff_live_… or ff_test_…',
      description: 'Created in the app under API keys. A test key renders for free with a watermark.',
    },
    {
      displayName: 'Region',
      name: 'region',
      type: 'options',
      default: 'eu',
      options: [
        { name: 'Europe (Frankfurt)', value: 'eu' },
        { name: 'United States (Ashburn)', value: 'us' },
      ],
      description: 'Where documents are rendered and stored. Only the EU region exists at launch.',
    },
    {
      displayName: 'Custom Base URL',
      name: 'baseUrl',
      type: 'string',
      default: '',
      placeholder: 'https://api-eu.formfeed.dev/v1',
      description: 'Overrides the region host, for staging or a self-hosted gateway',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: { Authorization: '=Bearer {{$credentials.apiKey}}' },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL:
        '={{$credentials.baseUrl || ($credentials.region === "us" ? "https://api-us.formfeed.dev/v1" : "https://api-eu.formfeed.dev/v1")}}',
      url: '/account',
    },
  };
}
