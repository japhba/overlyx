import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: [
    { find: /^@overlyx\/core$/, replacement: new URL('./packages/core/src/index.ts', import.meta.url).pathname },
    { find: /^@overlyx\/core\/(.*)$/, replacement: new URL('./packages/core/src/', import.meta.url).pathname + '$1' },
  ] },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60000 },
});
