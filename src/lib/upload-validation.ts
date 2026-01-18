import { UPLOAD_CONFIG } from '@/lib/constants';

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
