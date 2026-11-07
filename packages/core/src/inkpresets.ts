/** Default colour presets per pen (the highlighter's are drawn at HIGHLIGHT_OPACITY). */
export const INK_PALETTES: Record<'pen' | 'highlighter', [string, string][]> = {
  pen: [['#202124', 'Black'], ['#1a73e8', 'Blue'], ['#d93025', 'Red'], ['#188038', 'Green'], ['#f29900', 'Orange'], ['#a142f4', 'Purple']],
  highlighter: [['#fbbc04', 'Yellow'], ['#f29900', 'Orange'], ['#e8467c', 'Pink'], ['#34a853', 'Green'], ['#4285f4', 'Blue'], ['#a142f4', 'Purple']],
};

export const HIGHLIGHT_OPACITY = 0.35;

/**
 * The comment pen's ink (voicecomment.ts): high-visibility orange, drawn with a glow beneath it — a
 * review mark, never the content's colour (the pens' Orange is #f29900).
 */
export const COMMENT_INK = '#ff5c00';
/** its widths (px of a 1280 px slide: 2¼, 3¾, 6 pt) */
export const COMMENT_INK_WIDTHS = [3, 5, 8];
/** the glow beneath it (a CSS filter): a warm inner light, an orange haze — seen on white and on dark slides */
export const COMMENT_GLOW = 'drop-shadow(0 0 1.5px rgba(255, 224, 130, 1)) drop-shadow(0 0 2px rgba(255, 190, 60, 0.9)) drop-shadow(0 0 7px rgba(255, 100, 0, 0.75))';
