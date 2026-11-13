import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './local', timeout: 30000, workers: 1, use: { headless: true, viewport: { width: 1440, height: 900 } } });
