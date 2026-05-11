import { UPLOAD_CONFIG } from '@/lib/constants';
import { isAllowedCardUploadFile } from '@/lib/card-upload-mode';

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

/**
 * ファイルのバリデーション
 * @param file - アップロード対象ファイル
 * @param maxFileSize - オプショナル: プラン別の最大ファイルサイズ（未指定時はUPLOAD_CONFIG.MAX_FILE_SIZE）
 */
export function validateUpload(
  file: File | null | undefined,
  maxFileSize?: number
): ValidationResult {
  if (!file) {
    return { valid: false, error: 'NO_FILE' }
  }

  const effectiveMaxSize = maxFileSize ?? UPLOAD_CONFIG.MAX_FILE_SIZE;
  if (file.size > effectiveMaxSize) {
    return {
      valid: false,
      error: 'FILE_TOO_LARGE',
      maxSize: effectiveMaxSize,
      allowedTypes: [...UPLOAD_CONFIG.ALLOWED_TYPES],
    }
  }

  if (!isAllowedCardUploadFile(file)) {
    return {
      valid: false,
      error: 'INVALID_FILE_TYPE',
      maxSize: effectiveMaxSize,
      allowedTypes: [...UPLOAD_CONFIG.ALLOWED_TYPES],
    }
  }

  return { valid: true }
}

import { ERROR_MESSAGES } from '@/lib/constants'

export function getUploadErrorMessage(error: UploadValidationError): string {
  switch (error) {
    case 'FILE_TOO_LARGE':
      return ERROR_MESSAGES.FILE_SIZE_EXCEEDED
    case 'INVALID_FILE_TYPE':
      return ERROR_MESSAGES.INVALID_FILE_TYPE
    case 'NO_FILE':
      return ERROR_MESSAGES.NO_FILE_SELECTED
    default:
      return ERROR_MESSAGES.UNABLE_TO_UPLOAD
  }
}
