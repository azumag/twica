export const UPLOAD_CONFIG = {
  MAX_FILE_SIZE: 1 * 1024 * 1024,
  ALLOWED_TYPES: ['image/jpeg', 'image/png'] as const,
}

const TYPE_TO_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
};

function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf('.');
  return lastDotIndex > -1 ? fileName.slice(lastDotIndex + 1).toLowerCase() : '';
}

function validateFileType(mimeType: string, extension: string): boolean {
  const allowedExts = TYPE_TO_EXTENSIONS[mimeType];
  if (!allowedExts) return false;
  return allowedExts.includes(extension);
}

export type UploadValidationError = 
  | 'FILE_TOO_LARGE'
  | 'INVALID_FILE_TYPE'
  | 'NO_FILE'

interface ValidationResult {
  valid: boolean
  error?: UploadValidationError
  maxSize?: number
  allowedTypes?: string[]
}

export function validateUpload(
  file: File | null | undefined
): ValidationResult {
  if (!file) {
    return { valid: false, error: 'NO_FILE' }
  }

  if (file.size > UPLOAD_CONFIG.MAX_FILE_SIZE) {
    return {
      valid: false,
      error: 'FILE_TOO_LARGE',
      maxSize: UPLOAD_CONFIG.MAX_FILE_SIZE,
      allowedTypes: [...UPLOAD_CONFIG.ALLOWED_TYPES],
    }
  }

  const mimeType = file.type as typeof UPLOAD_CONFIG.ALLOWED_TYPES[number];
  if (!UPLOAD_CONFIG.ALLOWED_TYPES.includes(mimeType)) {
    return {
      valid: false,
      error: 'INVALID_FILE_TYPE',
      maxSize: UPLOAD_CONFIG.MAX_FILE_SIZE,
      allowedTypes: [...UPLOAD_CONFIG.ALLOWED_TYPES],
    }
  }

  const extension = getFileExtension(file.name);
  if (!validateFileType(mimeType, extension)) {
    return {
      valid: false,
      error: 'INVALID_FILE_TYPE',
      maxSize: UPLOAD_CONFIG.MAX_FILE_SIZE,
      allowedTypes: [...UPLOAD_CONFIG.ALLOWED_TYPES],
    }
  }

  return { valid: true }
}

export function getUploadErrorMessage(error: UploadValidationError, maxSize?: number): string {
  switch (error) {
    case 'FILE_TOO_LARGE':
      const sizeInMB = maxSize ? (maxSize / (1024 * 1024)).toFixed(1) : '1'
      return `ファイルサイズは${sizeInMB}MB以下にしてください`
    case 'INVALID_FILE_TYPE':
      return '画像ファイル（JPEG, PNG）のみ対応しています'
    case 'NO_FILE':
      return 'ファイルが選択されていません'
    default:
      return 'アップロードできません'
  }
}
