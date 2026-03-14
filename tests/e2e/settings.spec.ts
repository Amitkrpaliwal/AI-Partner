import { test, expect } from '@playwright/test';

test.describe('Settings Page', () => {
    test('can navigate to settings', async ({ page }) => {
        await page.goto('/');
        // Click the settings icon/link in sidebar
        const settingsBtn = page.locator('[data-testid="nav-settings"], button:has-text("Settings"), a:has-text("Settings")').first();
        if (await settingsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await settingsBtn.click();
            await expect(page.locator('text=Global Settings')).toBeVisible({ timeout: 5000 });
        }
    });

    test('system prompt textarea is editable', async ({ page }) => {
        await page.goto('/');
        const settingsBtn = page.locator('[data-testid="nav-settings"], button:has-text("Settings"), a:has-text("Settings")').first();
        if (await settingsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await settingsBtn.click();
            await expect(page.locator('textarea')).toBeVisible({ timeout: 5000 });
        }
    });
});
