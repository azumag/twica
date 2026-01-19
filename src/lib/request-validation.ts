import { NextRequest, NextResponse } from 'next/server'
import { ERROR_MESSAGES } from './constants'

/**
 * Validates that the request has the correct Content-Type header.
 * This is a critical security check to prevent XSS attacks and ensure proper request handling.
 *
 * @param request - The Next.js request object
 * @param expectedType - The expected content type (e.g., 'application/json')
 * @returns NextResponse with error if validation fails, null if validation passes
 */
export function validateContentType(
  request: NextRequest,
  expectedType: string
): NextResponse | null {
  const contentType = request.headers.get('content-type')

  // Content-Type header is required
  if (!contentType) {
    return createUnsupportedMediaTypeResponse(
      ERROR_MESSAGES.CONTENT_TYPE_MISSING
    )
  }

  // Check for exact match of the expected content type
  // We trim to handle any whitespace, and use case-insensitive comparison
  const normalizedContentType = contentType.trim().toLowerCase()
  const normalizedExpectedType = expectedType.toLowerCase()

  if (normalizedContentType !== normalizedExpectedType) {
    return createUnsupportedMediaTypeResponse(
      ERROR_MESSAGES.CONTENT_TYPE_INVALID.replace(
        '{expected}',
        expectedType
      ).replace('{received}', contentType)
    )
  }

  // Validation passed
  return null
}

/**
 * Creates a standardized 415 Unsupported Media Type response.
 *
 * @param message - The error message to include in the response
 * @returns NextResponse with 415 status code and error message
 */
export function createUnsupportedMediaTypeResponse(
  message: string
): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 415 }
  )
}
