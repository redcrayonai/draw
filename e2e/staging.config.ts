import { defineConfig } from '@playwright/test';
import local from './playwright.config';

if (!process.env.E2E_BASE_URL) throw new Error('E2E_BASE_URL is required for deployed staging journeys');
const baseURL = new URL(process.env.E2E_BASE_URL).href;

export default defineConfig({
  ...local,
  testIgnore: [],
  testMatch: '**/staging.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: './test-results/staging',
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report/staging' }]],
  // A trace records request headers: none when an access service token is sent (tests/staging.spec.ts).
  use: { ...local.use, baseURL, ...(process.env.CF_ACCESS_CLIENT_SECRET ? { trace: 'off' as const } : {}) },
});
