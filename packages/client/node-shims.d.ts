// The core's parser reads `process.env.LYX_LAYOUT_DIR` (latex/layouts.ts); in the browser vite.config.ts defines it.
declare const process: { env: Record<string, string | undefined> };
