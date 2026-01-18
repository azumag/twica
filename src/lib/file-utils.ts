import { UPLOAD_CONFIG } from '@/lib/constants';

export function getFileTypeFromBuffer(buffer: Buffer): string {
  if (buffer.length < 2) {
    return 'application/octet-stream';
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];

  if (firstByte === 0xFF && secondByte === 0xD8) {
    return 'image/jpeg';
  }

  if (buffer.length >= 8 &&
      firstByte === 0x89 && secondByte === 0x50 &&
      buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A &&
      buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return 'image/png';
  }

  if (buffer.length >= 6 &&
      firstByte === 0x47 && secondByte === 0x49 &&
      buffer[2] === 0x46 && buffer[3] === 0x38 &&
      buffer[4] === 0x37 && buffer[5] === 0x61) {
    return 'image/gif';
  }

  if (buffer.length >= 12 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 &&
      buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  return 'application/octet-stream';
}

export function isValidExtension(ext: string): ext is typeof UPLOAD_CONFIG.ALLOWED_EXTENSIONS[number] {
  return UPLOAD_CONFIG.ALLOWED_EXTENSIONS.includes(ext as typeof UPLOAD_CONFIG.ALLOWED_EXTENSIONS[number]);
}

export function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf('.');
  return lastDotIndex > -1 ? fileName.slice(lastDotIndex + 1).toLowerCase() : '';
}
