/** Machine-readable render_page measurements. Boxes are CSS px from the slide's top left
 * (the document's top left for web pages), before screenshot scaling. */
export interface LayoutBox { x: number; y: number; w: number; h: number }
export interface RenderedFont { familyName: string; postScriptName: string; isCustomFont: boolean; glyphCount: number }
export interface LayoutObject {
  /** Selector in the rendered DOM; id is also supplied when the object has one. */
  selector: string;
  id?: string;
  tag: string;
  box: LayoutBox;
  text?: {
    lineCount: number;
    /** More visual lines than with soft wrapping disabled; explicit breaks do not count. */
    wraps: boolean;
    overflow: { x: boolean; y: boolean };
    fontFamily: string;
    /** Chromium's actual fonts, including fallback faces; null when unavailable.
     * SVG path formulas use no platform text font and may have an empty array. */
    fonts: RenderedFont[] | null;
  };
  formulas: { box: LayoutBox; marks: { classes: string[]; id?: string; box: LayoutBox }[] }[];
}
export interface PageLayout { index: number; width: number; height: number; objects: LayoutObject[] }
export interface DeliverableLayout { units: 'css-px'; pages: PageLayout[] }
