# Implementation Tasks for CSRF Protection Review Fixes

## Overview
This directory contains task specifications for implementing the fixes identified in the review (docs/REVIEW.md) based on the design document (docs/ARCHITECTURE.md).

## Priority Order

### Priority 1: SameSite属性の修正
**File**: tasks/priority-1-samesite-fix.md
- Change CSRF token cookie sameSite attribute from 'strict' to 'lax'
- **Impact**: Small
- **Risk**: None
- **Expected Time**: 5-10 minutes

### Priority 2: HttpOnly Cookieパターンへの移行
**File**: tasks/priority-2-httponly-cookie-migration.md
- Move CSRF token to httpOnly cookie
- Remove X-CSRF-Token header requirement
- **Impact**: Medium
- **Risk**: Medium
- **Expected Time**: 30-45 minutes

### Priority 3: 楽観的ロックの実装
**File**: tasks/priority-3-optimistic-locking.md
- Add version number to session
- Implement optimistic locking in token generation
- **Impact**: Small
- **Risk**: Low
- **Expected Time**: 20-30 minutes

### Priority 4: エラーハンドリングの改善
**File**: tasks/priority-4-error-handling.md
- Use different log levels (INFO/WARN/ERROR) based on error type
- **Impact**: Small
- **Risk**: None
- **Expected Time**: 10-15 minutes

## Instructions for Implementation Agents

### For Each Task:
1. Read the task specification file
2. Refer to the design document (docs/ARCHITECTURE.md) for full context
3. Implement the changes according to the specification
4. **IMPORTANT**: Do not add any comments to the code
5. Follow the existing codebase style and conventions
6. Test the implementation if possible

### After Completing All Tasks:
1. Document the work in docs/IMPLEMENTED.md
2. Format:
   ```markdown
   # Implementation Summary

   ## Priority 1: SameSite属性の修正
   - Status: [Completed/Skipped]
   - Files modified: src/lib/csrf.ts
   - Changes: Changed sameSite from 'strict' to 'lax'

   ## Priority 2: HttpOnly Cookieパターンへの移行
   - Status: [Completed/Skipped]
   - Files modified: src/lib/csrf.ts, src/lib/client/csrf.ts
   - Changes: ...

   ## Priority 3: 楽観的ロックの実装
   - Status: [Completed/Skipped]
   - Files modified: src/lib/session.ts, src/lib/csrf.ts
   - Changes: ...

   ## Priority 4: エラーハンドリングの改善
   - Status: [Completed/Skipped]
   - Files modified: src/lib/csrf.ts
   - Changes: ...
   ```

## Important Notes

- All changes must be based on docs/ARCHITECTURE.md
- No comments should be added to the code
- Code style should match existing codebase
- After completion, create/update docs/IMPLEMENTED.md with the work done
