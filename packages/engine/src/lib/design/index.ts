/**
 * `@formfeed/engine/design`: visual designs without the template engines (plan 16 §4), for hosts that
 * read or write designs but never render — the MCP server, the gateway's checks, tools. Free of
 * Nunjucks, LiquidJS, Handlebars, bwip-js and date-fns; the main entry exports the same.
 */
export * from './types';
export {
  DESIGN_LIMITS,
  dataPathPattern,
  designBytes,
  layerIdPattern,
  parseDesign,
  type ParsedDesign,
} from './parse';
export { emitDesign, type EmittedDesign } from './emit';
export { designOutputHash } from './hash';
export {
  genericFamily,
  googleFont,
  googleFonts,
  googleFontsUrl,
  nearestWeight,
  type GoogleFont,
} from './fonts';
export { defaultLayer, emptyDesign, nextLayerId } from './layers';
export { designStarters, type DesignStarter } from './starters';
