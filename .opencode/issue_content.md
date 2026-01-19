## Issue Description

Two CSRF validation tests are failing in the test suite. These tests verify that the application properly rejects requests with invalid origin and referer headers, but the tests are currently passing when they should fail.

## Failing Tests

1. **test:** should reject invalid origin header
   - **file:** tests/unit/csrf.test.ts:348
   - **expectation:** result.valid should be false
   - **actual:** result.valid is true

2. **test:** should reject invalid referer header when origin is missing
   - **file:** tests/unit/csrf.test.ts:432
   - **expectation:** result.valid should be false
   - **actual:** result.valid is true

## Root Cause Analysis

The issue appears to be related to how the CSRF_CONFIG.ALLOWED_ORIGINS mock is being applied or how the Request object handles headers in the test environment.

The test file attempts to mock CSRF_CONFIG with specific ALLOWED_ORIGINS, but the actual CSRF_CONFIG in src/lib/constants.ts is dynamically generated based on environment variables. This dynamic generation may be causing the mock to not be properly applied, or there may be an issue with how the test environment handles Request objects with custom origin headers.

## Impact

- Security: These tests verify critical CSRF protection functionality
- Test reliability: The test suite currently has a 98.6% pass rate (144/146 tests passing)
- Production: The actual production implementation may be working correctly, but the tests are not properly validating this

## Related Files

- tests/unit/csrf.test.ts - Test file with failing tests
- src/lib/csrf.ts - CSRF validation implementation
- src/lib/constants.ts - Configuration including CSRF_CONFIG
