import { test, expect } from './fixtures/auth';

test.describe('Image Upload E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
  });

  test('should show upload form when adding new card', async ({ page }) => {
    await page.click('text=新規カード追加');

    await expect(page.locator('form')).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeVisible();
    await expect(page.locator('text=画像 (ファイルまたはURL)')).toBeVisible();
  });

  test('should validate file size limit', async ({ page }) => {
    await page.click('text=新規カード追加');

    const largeFile = Buffer.alloc(3 * 1024 * 1024);
    await page.setInputFiles('input[type="file"]', {
      name: 'large-image.jpg',
      mimeType: 'image/jpeg',
      buffer: largeFile,
    });

    await page.fill('input[name="name"]', 'Test Card');

    page.on('dialog', async dialog => {
      expect(dialog.message()).toContain('Failed to upload');
      await dialog.accept();
    });

    await page.click('button[type="submit"]');
  });

  test('should reject invalid file types', async ({ page }) => {
    await page.click('text=新規カード追加');

    await page.setInputFiles('input[type="file"]', {
      name: 'test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('This is not an image'),
    });

    await page.fill('input[name="name"]', 'Test Card');

    page.on('dialog', async dialog => {
      expect(dialog.message()).toContain('Failed to upload');
      await dialog.accept();
    });

    await page.click('button[type="submit"]');
  });

  test('should successfully upload a JPEG image', async ({ page }) => {
    await page.click('text=新規カード追加');

    const cardName = `E2E JPEG Card ${Date.now()}`;
    const jpegBuffer = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
      0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
      0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C,
      0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
      0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D,
      0x1A, 0x1C, 0x1C, 0x2A, 0x29, 0x2C, 0x35, 0x34,
      0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
      0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xD9
    ]);

    await page.setInputFiles('input[type="file"]', {
      name: 'test-image.jpg',
      mimeType: 'image/jpeg',
      buffer: jpegBuffer,
    });

    await page.fill('input[name="name"]', cardName);
    await page.fill('textarea[name="description"]', 'JPEG test card');
    await page.selectOption('select[name="rarity"]', 'common');

    await page.click('button[type="submit"]');

    await expect(page.locator('form')).not.toBeVisible();
    await expect(page.locator(`text=${cardName}`)).toBeVisible();
  });

  test('should successfully upload a PNG image', async ({ page }) => {
    await page.click('text=新規カード追加');

    const cardName = `E2E PNG Card ${Date.now()}`;
    const pngBuffer = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
      0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
      0x42, 0x60, 0x82
    ]);

    await page.setInputFiles('input[type="file"]', {
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: pngBuffer,
    });

    await page.fill('input[name="name"]', cardName);
    await page.fill('textarea[name="description"]', 'PNG test card');
    await page.selectOption('select[name="rarity"]', 'rare');

    await page.click('button[type="submit"]');

    await expect(page.locator('form')).not.toBeVisible();
    await expect(page.locator(`text=${cardName}`)).toBeVisible();
  });

  test('should successfully upload a GIF image', async ({ page }) => {
    await page.click('text=新規カード追加');

    const cardName = `E2E GIF Card ${Date.now()}`;
    const gifBuffer = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
      0x01, 0x00, 0x00, 0x00, 0x00, 0x21, 0xF9, 0x04,
      0x01, 0x0A, 0x00, 0x01, 0x00, 0x2C, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02,
      0x02, 0x4C, 0x01, 0x00, 0x3B
    ]);

    await page.setInputFiles('input[type="file"]', {
      name: 'test-image.gif',
      mimeType: 'image/gif',
      buffer: gifBuffer,
    });

    await page.fill('input[name="name"]', cardName);
    await page.fill('textarea[name="description"]', 'GIF test card');
    await page.selectOption('select[name="rarity"]', 'epic');

    await page.click('button[type="submit"]');

    await expect(page.locator('form')).not.toBeVisible();
    await expect(page.locator(`text=${cardName}`)).toBeVisible();
  });

  test('should successfully upload a WebP image', async ({ page }) => {
    await page.click('text=新規カード追加');

    const cardName = `E2E WebP Card ${Date.now()}`;
    const webpBuffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x1E, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4C,
      0x10, 0x00, 0x00, 0x00, 0x2F, 0x00, 0x00, 0x00,
      0x10, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);
    
    await page.setInputFiles('input[type="file"]', {
      name: 'test-image.webp',
      mimeType: 'image/webp',
      buffer: webpBuffer,
    });

    await page.fill('input[name="name"]', cardName);
    await page.fill('textarea[name="description"]', 'WebP test card');
    await page.selectOption('select[name="rarity"]', 'legendary');

    await page.click('button[type="submit"]');

    await expect(page.locator('form')).not.toBeVisible();
    await expect(page.locator(`text=${cardName}`)).toBeVisible();
  });

  test('should update existing card with new image', async ({ page }) => {
    const cardName = `Card to Edit ${Date.now()}`;
    await page.click('text=新規カード追加');

    const jpegBuffer = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
      0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
      0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C,
      0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
      0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D,
      0x1A, 0x1C, 0x1C, 0x2A, 0x29, 0x2C, 0x35, 0x34,
      0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
      0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xD9
    ]);

    await page.setInputFiles('input[type="file"]', {
      name: 'original-image.jpg',
      mimeType: 'image/jpeg',
      buffer: jpegBuffer,
    });

    await page.fill('input[name="name"]', cardName);
    await page.click('button[type="submit"]');

    await expect(page.locator(`text=${cardName}`)).toBeVisible();

    await page.hover(`text=${cardName}`);
    await page.click('button:has-text("編集")');

    const newJpegBuffer = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
      0x00, 0x01, 0x00, 0x01, 0xFF, 0xDB, 0x00, 0x43,
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
      0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C,
      0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
      0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D,
      0x1A, 0x1C, 0x1C, 0x2A, 0x29, 0x2C, 0x35, 0x34,
      0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
      0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xD9
    ]);

    await page.setInputFiles('input[type="file"]', {
      name: 'updated-image.jpg',
      mimeType: 'image/jpeg',
      buffer: newJpegBuffer,
    });

    await page.click('button[type="submit"]');

    await expect(page.locator('form')).not.toBeVisible();
    await expect(page.locator(`text=${cardName}`)).toBeVisible();
  });

  test('should create card without image', async ({ page }) => {
    const cardName = `No Image Card ${Date.now()}`;
    await page.click('text=新規カード追加');

    await page.fill('input[name="name"]', cardName);
    await page.fill('textarea[name="description"]', 'Card without image');
    await page.selectOption('select[name="rarity"]', 'common');

    await page.click('button[type="submit"]');

    await expect(page.locator('form')).not.toBeVisible();
    await expect(page.locator(`text=${cardName}`)).toBeVisible();
  });

  test('should handle upload errors gracefully', async ({ page }) => {
    await page.route('**/api/upload', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal server error' }),
      });
    });

    await page.click('text=新規カード追加');
    
    const jpegBuffer = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
      0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9
    ]);
    
    await page.setInputFiles('input[type="file"]', {
      name: 'test-image.jpg',
      mimeType: 'image/jpeg',
      buffer: jpegBuffer,
    });

    await page.fill('input[name="name"]', 'Test Card');
    await page.click('button[type="submit"]');
    
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });
  });

  test('should show loading state during upload', async ({ page }) => {
    await page.click('text=新規カード追加');
    
    const jpegBuffer = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
      0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9
    ]);
    
    await page.setInputFiles('input[type="file"]', {
      name: 'test-image.jpg',
      mimeType: 'image/jpeg',
      buffer: jpegBuffer,
    });

    await page.fill('input[name="name"]', 'Test Card');
    
    await page.route('**/api/upload', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'http://example.com/image.jpg' }),
      });
    });

    const submitPromise = page.click('button[type="submit"]');
    await expect(page.locator('button:has-text("保存中...")')).toBeVisible();
    await submitPromise;
  });

  test('should cancel card creation', async ({ page }) => {
    await page.click('text=新規カード追加');
    
    const jpegBuffer = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
      0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9
    ]);
    
    await page.setInputFiles('input[type="file"]', {
      name: 'test-image.jpg',
      mimeType: 'image/jpeg',
      buffer: jpegBuffer,
    });

    await page.fill('input[name="name"]', 'Cancelled Card');
    
    await page.click('button:has-text("キャンセル")');
    
    await expect(page.locator('form')).not.toBeVisible();
    await expect(page.locator('text=Cancelled Card')).not.toBeVisible();
  });

  test('should handle boundary file size (exactly 2MB)', async ({ page }) => {
    await page.click('text=新規カード追加');
    
    const boundaryFile = Buffer.alloc(2 * 1024 * 1024);
    await page.setInputFiles('input[type="file"]', {
      name: 'boundary-image.jpg',
      mimeType: 'image/jpeg',
      buffer: boundaryFile,
    });

    await page.fill('input[name="name"]', 'Boundary Size Card');
    await page.click('button[type="submit"]');
    
    await expect(page.locator('form')).not.toBeVisible({ timeout: 15000 });
  });
});