import type { HelperDefinition, HelperDocEntry } from '../types';
import { codeHelpers } from './codes';
import { collectionHelpers } from './collections';
import { documentHelpers } from './document';
import { formatHelpers } from './format';
import { logicHelpers } from './logic';
import { DefaultHelperRegistry } from './registry';

export { DefaultHelperRegistry } from './registry';
export { escapeHtml, toDate, toNumber } from './format';
export { EPC_MAX_BYTES, epcPayload, ibanChecksum, normaliseIban, qrSvg, svgDataUri, validateEpc } from '../codes';
export type { EpcInput, EpcPayment, EpcProblem, QrOptions } from '../codes';
export { chartMarkup, chartPayload, imageMarkup } from './document';
export { officeUnsupported, officeUnsupportedHelpers } from './office';
export type { ChartSpec, ImageOptions } from './document';

/** Helpers shipped with the product (spec 05 §2), identical in all three engines. */
export const builtinHelpers: HelperDefinition[] = [
  ...formatHelpers,
  ...collectionHelpers,
  ...logicHelpers,
  ...codeHelpers,
  ...documentHelpers,
];

export function createHelperRegistry(
  extra: HelperDefinition[] = [],
): DefaultHelperRegistry {
  return new DefaultHelperRegistry([...builtinHelpers, ...extra]);
}

let shared: DefaultHelperRegistry | undefined;
/** Lazily built default registry, shared by analyze() and the engines when none is supplied. */
export function defaultHelpers(): DefaultHelperRegistry {
  return (shared ??= createHelperRegistry());
}

/** Documentation entries that feed editor hover and completion (spec 05 §2). */
export function helperDocs(registry = defaultHelpers()): HelperDocEntry[] {
  return [...registry.definitions.values()].map((d) => ({
    name: d.name,
    aliases: d.aliases ?? [],
    ...d.doc,
    // derived rather than authored, so the old field cannot drift from `examples`
    example: d.doc.examples.jinja2,
  }));
}
