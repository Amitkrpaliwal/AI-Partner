import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Local AI Co-Worker/);
});

test('can send message', async ({ page }) => {
    await page.goto('/');

    // Wait for connection/load by checking if textarea is visible
    // The app loads 'ChatArea' which has a textarea
    await expect(page.locator('textarea')).toBeVisible({ timeout: 15000 });

    // Type message
    await page.fill('textarea', 'Hello E2E');

    // Click send (can target by loop-up or class)
    // Our button has <ArrowUp /> inside.
    // Or type Enter
    await page.keyboard.press('Enter');

    // Check unique message bubble appears
    // Note: Local execution might be slow or just optimistic update
    await expect(page.locator('text=Hello E2E')).toBeVisible({ timeout: 5000 });
});
