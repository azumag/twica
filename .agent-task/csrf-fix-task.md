# CSRF Protection Review Fixes

## Overview
Implement fixes for security and code quality issues identified in the code review.

## Critical Issues (Priority 1)

### 1. CSRF_TOKEN Cookie httpOnly Setting Inconsistency
**Problem:**
- Comment in `src/lib/csrf.ts:107` says "httpOnly cookie (XSS対策)" but the setting is `httpOnly: false`
- Design document has inconsistent explanations about httpOnly settings
- XSS + CSRF combined attack scenario not clearly documented

**Required Changes:**
1. Fix comment in `src/lib/csrf.ts:107` to accurately describe the non-httpOnly setting
2. Update `docs/ARCHITECTURE.md` to clearly document:
   - Why `httpOnly: false` is required for JavaScript access
   - XSS + CSRF combined attack scenario
   - How hash comparison provides protection even if token is stolen
3. Update error handling in `src/lib/csrf.ts:194-207` to limit detailed error information in production

### 2. Constant Reference Inconsistency
**Problem:**
- Mix of `CSRF_CONFIG`, `COOKIE_NAMES`, and hardcoded strings
- Inconsistent constant usage across files

**Required Changes:**
1. Add `HTTP_METHODS` constant to `src/lib/constants.ts`:
   ```typescript
   export const HTTP_METHODS = {
     POST: 'POST',
     PUT: 'PUT',
     DELETE: 'DELETE',
   } as const
   ```
2. Update `src/lib/middleware/csrf.ts` to use `HTTP_METHODS.POST`, `HTTP_METHODS.PUT`, `HTTP_METHODS.DELETE` instead of hardcoded strings
3. Ensure all cookie names use `COOKIE_NAMES` constant

## Major Issues (Priority 2)

### 3. Session Update Race Condition
**Status:** Already implemented with optimistic locking
- Version field added to Session interface (src/lib/session.ts:13)
- Optimistic locking implemented in setCSRFToken (src/lib/csrf.ts:64-90)
- Retry logic implemented (src/lib/csrf.ts:71-90)

**Required Changes:**
1. Update `docs/ARCHITECTURE.md` to document that this is already implemented

### 4. Error Handling Information Leakage
**Problem:**
- Error logs may contain sensitive information (error.stack)
- Debug mode not used for detailed error output

**Required Changes:**
1. Create `DEBUG_MODE` constant in `src/lib/constants.ts`:
   ```typescript
   export const DEBUG_MODE = process.env.NODE_ENV !== 'production'
   ```
2. Update error handling in `src/lib/csrf.ts:194-207`:
   - In production: Log minimal information (only error type)
   - In debug mode: Log full error details (error.message, error.stack)

## Medium Issues (Priority 3)

### 5. Magic Numbers and Hardcoded Values
**Problem:**
- HTTP methods are hardcoded strings
- Cookie names sometimes hardcoded

**Required Changes:**
1. Ensure all HTTP methods use `HTTP_METHODS` constant
2. Ensure all cookie names use `COOKIE_NAMES` constant
3. Verify no other magic numbers exist in CSRF-related code

## Implementation Steps

1. Update `src/lib/constants.ts`:
   - Add `HTTP_METHODS` constant
   - Add `DEBUG_MODE` constant

2. Update `src/lib/csrf.ts`:
   - Fix comment about httpOnly (line 107)
   - Update error handling to use DEBUG_MODE (lines 194-207)

3. Update `src/lib/middleware/csrf.ts`:
   - Use `HTTP_METHODS` constants instead of hardcoded strings

4. Update `docs/ARCHITECTURE.md`:
   - Document XSS + CSRF combined attack scenario
   - Explain why httpOnly: false is required
   - Document that race condition protection is already implemented
   - Clarify all security considerations

5. Create `docs/IMPLEMENTED.md` with:
   - List of modified files
   - Details of each change
   - Security improvement points

## Testing Requirements

After implementing changes, verify:
1. All constants are used consistently
2. Error logs in production don't contain sensitive information
3. Documentation accurately reflects implementation
4. No hardcoded strings remain for HTTP methods and cookie names

## Output Requirements

Create `docs/IMPLEMENTED.md` with:
1. List of modified files
2. Details of each modification
3. Security improvement points

---
**Task created:** 2026-01-19
**Reference:** docs/REVIEW.md
