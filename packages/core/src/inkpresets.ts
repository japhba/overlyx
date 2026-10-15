/** Default colour presets per pen (the highlighter's are drawn at HIGHLIGHT_OPACITY). */
export const INK_PALETTES: Record<'pen' | 'highlighter', [string, string][]> = {
  pen: [['#202124', 'Black'], ['#1a73e8', 'Blue'], ['#d93025', 'Red'], ['#188038', 'Green'], ['#f29900', 'Orange'], ['#a142f4', 'Purple']],
  highlighter: [['#fbbc04', 'Yellow'], ['#f29900', 'Orange'], ['#e8467c', 'Pink'], ['#34a853', 'Green'], ['#4285f4', 'Blue'], ['#a142f4', 'Purple']],
};

export const HIGHLIGHT_OPACITY = 0.35;
