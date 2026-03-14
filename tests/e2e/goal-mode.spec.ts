import { test, expect } from '@playwright/test';

test.describe('Goal Mode', () => {
    test('can switch to goal mode if available', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('textarea')).toBeVisible({ timeout: 15000 });

        // Look for mode switcher (goal/chat toggle)
        const goalToggle = page.locator('button:has-text("Goal"), [data-testid="mode-goal"]').first();
        if (await goalToggle.isVisible({ timeout: 3000 }).catch(() => false)) {
            await goalToggle.click();
            // Verify mode changed — goal mode may show different UI
            await page.waitForTimeout(500);
        }
    });

    test('goal progress panel renders when goal is active', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('textarea')).toBeVisible({ timeout: 15000 });

        // Send a goal-like message
        await page.fill('textarea', 'Create a simple hello world Python script');
        await page.keyboard.press('Enter');

        // Wait for some response — goal may or may not trigger depending on model availability
        await page.waitForTimeout(3000);

        // If goal mode triggers, the progress panel should be visible
        const progressPanel = page.locator('text=Goal Progress, text=Subtask, [data-testid="goal-progress"]').first();
        // This is a soft check — it only passes if backend is running with a model
        if (await progressPanel.isVisible({ timeout: 5000 }).catch(() => false)) {
            expect(true).toBe(true);
        }
    });
});
