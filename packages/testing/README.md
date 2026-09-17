# @formfeed/testing

Vitest and Jest matchers for [Formfeed](https://formfeed.dev) HTML templates kept in your repository.
The offline matchers render with the same engine the API uses, so they need no account. Word and
PowerPoint templates are tested with `formfeed test`, which compares their filled XML with approved
snapshots.

```bash
npm install -D @formfeed/testing
```

Register the matchers once: add `@formfeed/testing/vitest` to Vitest's `setupFiles`, or
`@formfeed/testing/jest` to Jest's `setupFilesAfterEnv`.

```ts
import { loadTemplate } from '@formfeed/testing';
import invoice from '../templates/invoice-de/data/default.json';

const tpl = await loadTemplate('templates/invoice-de');

test('compiles and uses only known variables', async () => {
  await expect(tpl).toRenderWithoutErrors(invoice);
  await expect(tpl).toUseOnlyKnownVariables(invoice);
});

test('html snapshot', async () => {
  expect(await tpl.render(invoice)).toMatchSnapshot();
});

test('two pages for forty lines', async () => {
  await expect(tpl).toHavePageCount(2, invoice); // a true render through the API
});
```

| Matcher | Needs the API | Checks |
|---|---|---|
| `toRenderWithoutErrors(data)` | no | Compiles and renders without engine errors |
| `toUseOnlyKnownVariables(data)` | no | Every variable the template reads exists in the data |
| `toContainText(text, data)` | no | The rendered HTML contains the text |
| `toHavePageCount(n, data)` | yes | Page count of the true render |

API-backed matchers read `FORMFEED_API_KEY` (a test key is enough) and skip with a warning without
one; set `FORMFEED_REQUIRE_API=1` in CI to make them fail instead. For another test runner, pass
`matchers` to its `expect.extend`.

## Documentation

- [Testing templates](https://docs.formfeed.dev/devkit/testing)

## Licence

MIT
