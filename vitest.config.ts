import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    // DB tests each build a throwaway database and some load the embedding model; with every
    // file in parallel the 5s default is a harness limit, not a signal.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    exclude: ['**/node_modules/**', '**/.next/**'],
  },
});
