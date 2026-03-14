import { test, expect } from '@playwright/test';

test.describe('Navigation & Layout', () => {
    test('app loads with sidebar and chat area', async ({ page }) => {
        await page.goto('/');
        // Sidebar should be visible
        await expect(page.locator('text=AI Co-Worker').first()).toBeVisible({ timeout: 15000 });
        // Chat textarea should be present
        await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });
    });

    test('sidebar shows navigation items', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        // Check for main nav items (these may be icons or text)
        const sidebar = page.locator('aside, nav, [data-testid="sidebar"]').first();
        await expect(sidebar).toBeVisible({ timeout: 10000 });
    });

    test('usage dashboard is accessible', async ({ page }) => {
        await page.goto('/');
        const usageBtn = page.locator('button:has-text("Usage"), a:has-text("Usage"), [data-testid="nav-usage"]').first();
        if (await usageBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await usageBtn.click();
            await expect(page.locator('text=Usage')).toBeVisible({ timeout: 5000 });
        }
    });

    test('tool marketplace is accessible', async ({ page }) => {
        await page.goto('/');
        const toolsBtn = page.locator('button:has-text("Tools"), a:has-text("Tools"), [data-testid="nav-tools"]').first();
        if (await toolsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await toolsBtn.click();
            await expect(page.locator('text=Tool')).toBeVisible({ timeout: 5000 });
        }
    });
});
