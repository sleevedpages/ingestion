import { defineConfig } from 'vitest/config';

// Transformer tests are pure TypeScript — no Workers runtime needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
