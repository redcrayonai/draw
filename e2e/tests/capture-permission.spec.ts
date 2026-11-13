import { test, expect } from '@playwright/test';
import { requestCaptureApproval } from '../../helper/src/capture-permission';

for (const choice of ['Deny', 'Allow once']) {
  test(`source approval requires a deliberate ${choice} form submission`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const cancel = new AbortController();
    let open!: (url: string) => void;
    const url = new Promise<string>(resolve => { open = resolve; });
    // This form has no capture callback: browser testing cannot read or upload source.
    const decision = requestCaptureApproval('TEST ONLY: example.ts; no source capture is executed.', open, 10_000, cancel.signal);
    try {
      await page.goto(await url);
      await expect(page.getByRole('heading', { name: 'Read and upload source code?' })).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeFocused();
      const response = page.waitForResponse(response => response.request().method() === 'POST');
      await page.getByRole('button', { name: choice, exact: true }).click();
      expect((await response).status()).toBe(200);
      expect(await decision).toBe(choice === 'Allow once');
      expect(errors).toEqual([]);
    } finally { cancel.abort(); await decision; }
  });
}
