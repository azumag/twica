import http from 'http';
import fs from 'fs';
import path from 'path';
const SESSION_COOKIE_PLACEHOLDER = '// TODO: Add valid session cookie here';

async function runTests() {
  console.log('Starting API upload tests...\n');

  const testResults = [];

  // Test 1: 認証なしでのアップロード拒否
  console.log('Test 1: Testing upload without authentication...');
  try {
    const result = await testWithoutAuth();
    testResults.push({ name: 'Authentication required', passed: result.passed, message: result.message });
    console.log(result.message);
  } catch (error) {
    testResults.push({ name: 'Authentication required', passed: false, message: `Error: ${error.message}` });
    console.log(`Test Failed: ${error.message}`);
  }
  console.log('');

  // Test 2: ファイルなしでのアップロード拒否
  console.log('Test 2: Testing upload without file...');
  try {
    const result = await testWithoutFile();
    testResults.push({ name: 'File required', passed: result.passed, message: result.message });
    console.log(result.message);
  } catch (error) {
    testResults.push({ name: 'File required', passed: false, message: `Error: ${error.message}` });
    console.log(`Test Failed: ${error.message}`);
  }
  console.log('');

  // Test 3: 2MB超ファイルのアップロード拒否
  console.log('Test 3: Testing upload with file exceeding 2MB...');
  try {
    const result = await testWithLargeFile();
    testResults.push({ name: 'File size limit', passed: result.passed, message: result.message });
    console.log(result.message);
  } catch (error) {
    testResults.push({ name: 'File size limit', passed: false, message: `Error: ${error.message}` });
    console.log(`Test Failed: ${error.message}`);
  }
  console.log('');

  // Test 4: 不正なファイルタイプの拒否
  console.log('Test 4: Testing upload with invalid file type...');
  try {
    const result = await testWithInvalidFileType();
    testResults.push({ name: 'File type validation', passed: result.passed, message: result.message });
    console.log(result.message);
  } catch (error) {
    testResults.push({ name: 'File type validation', passed: false, message: `Error: ${error.message}` });
    console.log(`Test Failed: ${error.message}`);
  }
  console.log('');

  // Test 5: 正常な画像のアップロード成功
  console.log('Test 5: Testing successful image upload...');
  try {
    const result = await testWithValidImage();
    testResults.push({ name: 'Successful upload', passed: result.passed, message: result.message });
    console.log(result.message);
  } catch (error) {
    testResults.push({ name: 'Successful upload', passed: false, message: `Error: ${error.message}` });
    console.log(`Test Failed: ${error.message}`);
  }
  console.log('');

  // Summary
  console.log('='.repeat(50));
  console.log('Test Summary:');
  console.log('='.repeat(50));
  testResults.forEach(result => {
    const status = result.passed ? '✓ PASSED' : '✗ FAILED';
    console.log(`${status}: ${result.name}`);
  });
  const passed = testResults.filter(r => r.passed).length;
  const total = testResults.length;
  console.log('='.repeat(50));
  console.log(`${passed}/${total} tests passed`);

  // Cleanup temp files
  cleanupTempFiles();
}

function getValidSessionCookie() {
  const cookie = SESSION_COOKIE_PLACEHOLDER;
  if (cookie.startsWith('// TODO')) {
    return null;
  }
  return cookie;
}

async function testWithoutAuth() {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2);
  const formData = createFormDataWithFile(boundary, Buffer.from('test'), 'test.jpg', 'image/jpeg');

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': formData.length
    }
  };

  const response = await makeRequest(options, formData);

  if (response.statusCode === 401 && response.body.error === 'Not authenticated') {
    return { passed: true, message: 'Test Passed: Unauthenticated request rejected correctly' };
  } else {
    return { passed: false, message: `Test Failed: Expected 401 with "Not authenticated", got ${response.statusCode}: ${JSON.stringify(response.body)}` };
  }
}

async function testWithoutFile() {
  const sessionCookie = getValidSessionCookie();
  if (!sessionCookie) {
    return { passed: false, message: 'Test Skipped: Valid session cookie not set (add it to SESSION_COOKIE placeholder)' };
  }

  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2);
  const formData = createFormDataWithoutFile(boundary);

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': formData.length,
      'Cookie': `twica_session=${sessionCookie}`
    }
  };

  const response = await makeRequest(options, formData);

  if (response.statusCode === 400 && response.body.error === 'No file provided') {
    return { passed: true, message: 'Test Passed: Request without file rejected correctly' };
  } else {
    return { passed: false, message: `Test Failed: Expected 400 with "No file provided", got ${response.statusCode}: ${JSON.stringify(response.body)}` };
  }
}

async function testWithLargeFile() {
  const sessionCookie = getValidSessionCookie();
  if (!sessionCookie) {
    return { passed: false, message: 'Test Skipped: Valid session cookie not set (add it to SESSION_COOKIE placeholder)' };
  }

  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2);
  const largeFileSize = 2 * 1024 * 1024 + 1; // 2MB + 1 byte
  const largeFile = Buffer.alloc(largeFileSize, 0);
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempFilePath = path.join(tempDir, 'large_test_file.jpg');
  fs.writeFileSync(tempFilePath, largeFile);

  const formData = createFormDataWithFile(boundary, largeFile, 'large.jpg', 'image/jpeg');

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': formData.length,
      'Cookie': `twica_session=${sessionCookie}`
    }
  };

  const response = await makeRequest(options, formData);

  if (response.statusCode === 400 && response.body.error === 'ファイルサイズは2MB以下にしてください') {
    return { passed: true, message: 'Test Passed: Large file (>2MB) rejected correctly' };
  } else {
    return { passed: false, message: `Test Failed: Expected 400 with size error, got ${response.statusCode}: ${JSON.stringify(response.body)}` };
  }
}

async function testWithInvalidFileType() {
  const sessionCookie = getValidSessionCookie();
  if (!sessionCookie) {
    return { passed: false, message: 'Test Skipped: Valid session cookie not set (add it to SESSION_COOKIE placeholder)' };
  }

  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2);
  const textContent = Buffer.from('This is a text file, not an image');
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempFilePath = path.join(tempDir, 'test.txt');
  fs.writeFileSync(tempFilePath, textContent);

  const formData = createFormDataWithFile(boundary, textContent, 'test.txt', 'text/plain');

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': formData.length,
      'Cookie': `twica_session=${sessionCookie}`
    }
  };

  const response = await makeRequest(options, formData);

  if (response.statusCode === 400 && response.body.error === '画像ファイル（JPEG, PNG, GIF, WebP）のみ対応しています') {
    return { passed: true, message: 'Test Passed: Invalid file type rejected correctly' };
  } else {
    return { passed: false, message: `Test Failed: Expected 400 with file type error, got ${response.statusCode}: ${JSON.stringify(response.body)}` };
  }
}

async function testWithValidImage() {
  const sessionCookie = getValidSessionCookie();
  if (!sessionCookie) {
    return { passed: false, message: 'Test Skipped: Valid session cookie not set (add it to SESSION_COOKIE placeholder)' };
  }

  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2);
  const validJpeg = createMinimalJpeg();
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempFilePath = path.join(tempDir, 'valid.jpg');
  fs.writeFileSync(tempFilePath, validJpeg);

  const formData = createFormDataWithFile(boundary, validJpeg, 'valid.jpg', 'image/jpeg');

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': formData.length,
      'Cookie': `twica_session=${sessionCookie}`
    }
  };

  const response = await makeRequest(options, formData);

  if (response.statusCode === 200 && response.body.url && isValidUrl(response.body.url)) {
    return { passed: true, message: `Test Passed: Valid image uploaded successfully, URL: ${response.body.url}` };
  } else {
    return { passed: false, message: `Test Failed: Expected 200 with URL, got ${response.statusCode}: ${JSON.stringify(response.body)}` };
  }
}

function createMinimalJpeg() {
  const jpegHeader = Buffer.from([
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
  return jpegHeader;
}

function createFormDataWithFile(boundary, fileBuffer, fileName, mimeType) {
  const formDataParts = [];
  formDataParts.push(`--${boundary}`);
  formDataParts.push(`Content-Disposition: form-data; name="file"; filename="${fileName}"`);
  formDataParts.push(`Content-Type: ${mimeType}`);
  formDataParts.push('');
  formDataParts.push(fileBuffer);
  formDataParts.push(`--${boundary}--`);
  return Buffer.concat(formDataParts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8')));
}

function createFormDataWithoutFile(boundary) {
  const formDataParts = [];
  formDataParts.push(`--${boundary}`);
  formDataParts.push(`Content-Disposition: form-data; name="file"; filename=""`);
  formDataParts.push(`Content-Type: application/octet-stream`);
  formDataParts.push('');
  formDataParts.push(`--${boundary}--`);
  return Buffer.concat(formDataParts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8')));
}

function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsedBody = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsedBody });
        } catch {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(body);
    req.end();
  });
}

function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanupTempFiles() {
  const tempDir = path.join(__dirname, 'temp');
  if (fs.existsSync(tempDir)) {
    fs.readdirSync(tempDir).forEach((file) => {
      const filePath = path.join(tempDir, file);
      fs.unlinkSync(filePath);
    });
    fs.rmdirSync(tempDir);
  }
}

runTests().catch(console.error);
