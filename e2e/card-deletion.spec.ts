import { test, expect } from './fixtures/auth';

test.describe('Card Deletion E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/streamer/dashboard');
  });

  test('should delete card with confirmation', async ({ page }) => {
    // Add a test card first
    await page.click('text=新規カード追加');
    await page.fill('input[placeholder="カード名"]', 'Delete Test Card');
    await page.click('button:has-text("追加")');
    
    // Wait for the card to appear
    await expect(page.locator('text=Delete Test Card')).toBeVisible();
    
    // Find and click delete button
    const cardElement = page.locator(':has-text("Delete Test Card")').first();
    await cardElement.hover();
    
    // Handle confirmation dialog
    page.on('dialog', async dialog => {
      expect(dialog.message()).toContain('削除');
      await dialog.accept();
    });
    
    // Click delete button
    await page.click('button:has-text("削除")');
    
    // Verify card is removed from UI
    await expect(page.locator('text=Delete Test Card')).not.toBeVisible();
  });

  test('should show error when deletion fails', async ({ page }) => {
    // Add a test card
    await page.click('text=新規カード追加');
    await page.fill('input[placeholder="カード名"]', 'Error Test Card');
    await page.click('button:has-text("追加")');
    
    // Wait for card
    await expect(page.locator('text=Error Test Card')).toBeVisible();
    
    // Mock failed API response
    await page.route('**/api/cards/*', route => {
      route.abort('failed');
    });
    
    // Try to delete
    const cardElement = page.locator(':has-text("Error Test Card")').first();
    await cardElement.hover();
    
    page.on('dialog', async dialog => {
      if (dialog.message().includes('削除')) {
        await dialog.accept();
      } else if (dialog.message().includes('ネットワーク')) {
        expect(dialog.message()).toContain('ネットワークエラー');
        await dialog.accept();
      }
    });
    
    await page.click('button:has-text("削除")');
    
    // Card should still be visible after failed deletion
    await expect(page.locator('text=Error Test Card')).toBeVisible();
  });

  test('should not delete card if user cancels confirmation', async ({ page }) => {
    // Add a test card
    await page.click('text=新規カード追加');
    await page.fill('input[placeholder="カード名"]', 'Cancel Test Card');
    await page.click('button:has-text("追加")');
    
    // Wait for card
    await expect(page.locator('text=Cancel Test Card')).toBeVisible();
    
    // Handle confirmation - cancel it
    page.on('dialog', async dialog => {
      expect(dialog.message()).toContain('削除');
      await dialog.dismiss();
    });
    
    // Click delete button
    const cardElement = page.locator(':has-text("Cancel Test Card")').first();
    await cardElement.hover();
    await page.click('button:has-text("削除")');
    
    // Card should still be visible
    await expect(page.locator('text=Cancel Test Card')).toBeVisible();
  });
});
