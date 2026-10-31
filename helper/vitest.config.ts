import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // every test spawns the built helper and git
    testTimeout: 30_000,
  },
});
