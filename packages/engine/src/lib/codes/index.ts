/**
 * Codes without the engine: QR rendering and the EPC (GiroCode) payload with its validation, for a
 * caller that wants them in a browser and nothing else. `@formfeed/engine/codes` in this workspace;
 * the published package exposes the same functions from its single entry.
 */
export {
  EPC_MAX_BYTES,
  epcPayload,
  ibanChecksum,
  normaliseIban,
  validateEpc,
  type EpcInput,
  type EpcPayment,
  type EpcProblem,
} from './epc';
export { qrSvg, svgDataUri, type QrOptions } from './qr';
