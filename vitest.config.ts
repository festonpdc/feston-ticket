import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  // Unit tests execute server code in Node; production retains the Next.js guard.
  resolve: { alias: { 'server-only': fileURLToPath(new URL('./tests/support/server-only.ts', import.meta.url)) } },
  test: {
  environment: 'node', include: ['tests/**/*.test.ts'],
  testTimeout: 30_000, hookTimeout: 120_000,
  fileParallelism: false
} });
