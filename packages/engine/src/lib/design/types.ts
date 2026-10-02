/**
 * A visual design (plan 16 §4.1): the layer model the editor's canvas edits, stored as
 * `settings.design` and turned into the template's body and CSS by `emitDesign`. Renders never read
 * it; the emitted HTML is the template. Coordinates are CSS pixels of the image, whose size stays in
 * `settings.image`.
 */

export const DESIGN_VERSION = 1;

/** A colour: a literal, or a brand kit colour by name with the literal it falls back to. */
export type Paint = { color: string } | { brand: string; fallback: string };

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  color: string;
}

export interface Stroke {
  width: number;
  paint: Paint;
}

/** A font: a family by source, or one of the brand kit's two. */
export type FontChoice =
  | { family: string; source: 'google' | 'organisation' | 'system' }
  | { brand: 'heading' | 'body' };

/** How a data value is shown: through one of the helpers every engine has. */
export type TextFormat =
  | { helper: 'upper' | 'lower' | 'title' | 'money' }
  | { helper: 'number'; decimals: number }
  | { helper: 'date'; pattern: string }
  | { helper: 'truncate'; length: number }
  | { helper: 'default'; value: string };

/** Text of a text layer: literal text, a data path (a chip in the editor), a line break. */
export type TextItem =
  { text: string } | { path: string; format?: TextFormat } | { break: true };

export interface TextStyle {
  font: FontChoice;
  weight: number;
  size: number;
  lineHeight: number;
  letterSpacing: number;
  color: Paint;
  align: 'left' | 'center' | 'right' | 'justify';
  italic?: boolean;
  uppercase?: boolean;
  underline?: boolean;
}

/** Where an image comes from; an empty `url`, `asset` or `path` is one not chosen yet (`imageIsEmpty`). */
export type ImageSource =
  | { url: string }
  | { asset: string }
  | { path: string }
  | { brandLogo: 'primary' | 'inverse' | 'mark' };

/** What a code encodes: literal text or a data path. */
export type Binding = { text: string } | { path: string };

export type BarcodeSymbology =
  'code128' | 'ean13' | 'ean8' | 'upca' | 'itf14' | 'code39';

export interface LayerBase {
  /** Stable, `[a-z][a-z0-9-]{0,31}`: the class `l-<id>` and `data-ff-layer`. Never renamed. */
  id: string;
  /** What the layers panel shows. */
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise like CSS. */
  rotation: number;
  opacity: number;
  /** False: the layer is not emitted at all. */
  visible: boolean;
  /** Editor only. */
  locked?: boolean;
  /** Emitted inside an if block: shown only when the data path has a value. */
  showWhen?: { path: string } | null;
  radius?: number;
  shadow?: Shadow | null;
  stroke?: Stroke | null;
}

export interface TextLayer extends LayerBase {
  type: 'text';
  content: TextItem[];
  style: TextStyle;
  /** `fixed` clips, `shrink` makes the text smaller until it fits (`data-ff-fit`), `grow` lets the box grow. */
  sizing: 'fixed' | 'shrink' | 'grow';
  minFontSize?: number;
  maxLines?: number;
  valign: 'top' | 'middle' | 'bottom';
  fill?: Paint | null;
  padding?: number;
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  source: ImageSource;
  fit: 'cover' | 'contain' | 'fill';
  /** Which point stays in view when `cover` crops, in percent. */
  focus?: { x: number; y: number };
}

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: 'rectangle' | 'ellipse' | 'line';
  fill: Paint | null;
}

export interface QrLayer extends LayerBase {
  type: 'qr';
  value: Binding;
  ecc: 'L' | 'M' | 'Q' | 'H';
  color: Paint;
  background: Paint | null;
}

export interface BarcodeLayer extends LayerBase {
  type: 'barcode';
  value: Binding;
  symbology: BarcodeSymbology;
  showText: boolean;
}

export type DesignLayer =
  TextLayer | ImageLayer | ShapeLayer | QrLayer | BarcodeLayer;
export type LayerType = DesignLayer['type'];

export interface DesignDocument {
  version: typeof DESIGN_VERSION;
  /** Hash of the body and CSS the emitter last wrote (`designOutputHash`); other code means it was edited. */
  output: string;
  /** The canvas colour; null is transparent, which only shows when `settings.image.transparent` is set. */
  background: Paint | null;
  /** Bottom to top: the stacking order is the order in the HTML. */
  layers: DesignLayer[];
  guides?: { x: number[]; y: number[] };
}

/** The image a design is drawn on, from `settings.image`. */
export interface CanvasSize {
  width: number;
  height: number;
}
