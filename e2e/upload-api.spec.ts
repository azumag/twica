import { test, expect } from '@playwright/test';

const createTestSessionCookie = () => {
  const session = {
    twitchUserId: '123456789',
    twitchUsername: 'teststreamer',
    twitchDisplayName: 'TestStreamer',
    twitchProfileImageUrl: 'https://example.com/avatar.png',
    broadcasterType: 'affiliate',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600000,
  };
  return encodeURIComponent(JSON.stringify(session));
};

test.describe('Image Upload API Tests', () => {
  const API_URL = '/api/upload';

  test('should reject upload without authentication', async ({ request }) => {
    const response = await request.post(API_URL, {
      multipart: {
        file: {
          name: 'test.jpg',
          mimeType: 'image/jpeg',
          buffer: Buffer.from('test'),
        },
      },
    });

    expect(response.status()).toBe(401);
    const responseBody = await response.json();
    expect(responseBody.error).toBe('Not authenticated');
  });

  test('should reject upload without file', async ({ request }) => {
    const sessionCookie = createTestSessionCookie();
    const response = await request.post(API_URL, {
      headers: {
        'Cookie': `twica_session=${sessionCookie}`,
      },
      form: {},
    });

    expect(response.status()).toBe(400);
    const responseBody = await response.json();
    expect(responseBody.error).toBe('No file provided');
  });

  test('should reject upload with invalid file type', async ({ request }) => {
    const sessionCookie = createTestSessionCookie();
    const response = await request.post(API_URL, {
      headers: {
        'Cookie': `twica_session=${sessionCookie}`,
      },
      multipart: {
        file: {
          name: 'test.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('This is not an image'),
        },
      },
    });

    expect(response.status()).toBe(400);
    const responseBody = await response.json();
    expect(responseBody.error).toBe('画像ファイル（JPEG, PNG, GIF, WebP）のみ対応しています');
  });

  test('should reject upload with oversized file', async ({ request }) => {
    const sessionCookie = createTestSessionCookie();
    const largeFile = Buffer.alloc(3 * 1024 * 1024);

    const response = await request.post(API_URL, {
      headers: {
        'Cookie': `twica_session=${sessionCookie}`,
      },
      multipart: {
        file: {
          name: 'large.jpg',
          mimeType: 'image/jpeg',
          buffer: largeFile,
        },
      },
    });

    expect(response.status()).toBe(400);
    const responseBody = await response.json();
    expect(responseBody.error).toBe('ファイルサイズは2MB以下にしてください');
  });

  test('should successfully upload valid JPEG', async ({ request }) => {
    const sessionCookie = createTestSessionCookie();
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

    const response = await request.post(API_URL, {
      headers: {
        'Cookie': `twica_session=${sessionCookie}`,
      },
      multipart: {
        file: {
          name: 'test-image.jpg',
          mimeType: 'image/jpeg',
          buffer: jpegBuffer,
        },
      },
    });

    expect(response.status()).toBe(200);
    const responseBody = await response.json();
    expect(responseBody.url).toBeDefined();
    expect(responseBody.url).toMatch(/^https?:\/\/.+/);
  });

  test('should successfully upload valid PNG', async ({ request }) => {
    const sessionCookie = createTestSessionCookie();
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

    const response = await request.post(API_URL, {
      headers: {
        'Cookie': `twica_session=${sessionCookie}`,
      },
      multipart: {
        file: {
          name: 'test-image.png',
          mimeType: 'image/png',
          buffer: pngBuffer,
        },
      },
    });

    expect(response.status()).toBe(200);
    const responseBody = await response.json();
    expect(responseBody.url).toBeDefined();
  });

  test('should successfully upload valid GIF', async ({ request }) => {
    const sessionCookie = createTestSessionCookie();
    const gifBuffer = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
      0x01, 0x00, 0x00, 0x00, 0x00, 0x21, 0xF9, 0x04,
      0x01, 0x0A, 0x00, 0x01, 0x00, 0x2C, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02,
      0x02, 0x4C, 0x01, 0x00, 0x3B
    ]);

    const response = await request.post(API_URL, {
      headers: {
        'Cookie': `twica_session=${sessionCookie}`,
      },
      multipart: {
        file: {
          name: 'test-image.gif',
          mimeType: 'image/gif',
          buffer: gifBuffer,
        },
      },
    });

    expect(response.status()).toBe(200);
    const responseBody = await response.json();
    expect(responseBody.url).toBeDefined();
  });

  test('should successfully upload valid WebP', async ({ request }) => {
    const sessionCookie = createTestSessionCookie();
    const webpBuffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x1E, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4C,
      0x10, 0x00, 0x00, 0x00, 0x2F, 0x00, 0x00, 0x00,
      0x10, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);

    const response = await request.post(API_URL, {
      headers: {
        'Cookie': `twica_session=${sessionCookie}`,
      },
      multipart: {
        file: {
          name: 'test-image.webp',
          mimeType: 'image/webp',
          buffer: webpBuffer,
        },
      },
    });

    expect(response.status()).toBe(200);
    const responseBody = await response.json();
    expect(responseBody.url).toBeDefined();
  });

  test('should accept boundary file size (exactly 2MB)', async ({ request }) => {
    const sessionCookie = createTestSessionCookie();
    const boundaryFile = Buffer.alloc(2 * 1024 * 1024);

    const response = await request.post(API_URL, {
      headers: {
        'Cookie': `twica_session=${sessionCookie}`,
      },
      multipart: {
        file: {
          name: 'boundary-image.jpg',
          mimeType: 'image/jpeg',
          buffer: boundaryFile,
        },
      },
    });

    expect(response.status()).toBe(200);
    const responseBody = await response.json();
    expect(responseBody.url).toBeDefined();
  });

  test('should reject file with 1 byte over limit', async ({ request }) => {
    const sessionCookie = createTestSessionCookie();
    const largeFile = Buffer.alloc(2 * 1024 * 1024 + 1);

    const response = await request.post(API_URL, {
      headers: {
        'Cookie': `twica_session=${sessionCookie}`,
      },
      multipart: {
        file: {
          name: 'oversized.jpg',
          mimeType: 'image/jpeg',
          buffer: largeFile,
        },
      },
    });

    expect(response.status()).toBe(400);
    const responseBody = await response.json();
    expect(responseBody.error).toBe('ファイルサイズは2MB以下にしてください');
  });

  // Note: MIME type header validation is not currently implemented
  // The API validates file.type which is set from the Content-Type header
  // Security: The file content should be validated separately if needed

  test('should reject upload with expired session', async ({ request }) => {
    const expiredSession = {
      twitchUserId: '123456789',
      twitchUsername: 'teststreamer',
      twitchDisplayName: 'TestStreamer',
      twitchProfileImageUrl: 'https://example.com/avatar.png',
      broadcasterType: 'affiliate',
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() - 1000,
    };
    const sessionCookie = encodeURIComponent(JSON.stringify(expiredSession));

    const jpegBuffer = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
      0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9
    ]);

    const response = await request.post(API_URL, {
      headers: {
        'Cookie': `twica_session=${sessionCookie}`,
      },
      multipart: {
        file: {
          name: 'test-image.jpg',
          mimeType: 'image/jpeg',
          buffer: jpegBuffer,
        },
      },
    });

    expect(response.status()).toBe(401);
    const responseBody = await response.json();
    expect(responseBody.error).toBe('Not authenticated');
  });
});