## Issue Description

npm audit identified 2 low severity vulnerabilities related to the `undici` package used by `@vercel/blob`.

## Vulnerability Details

```
undici  <6.23.0
Undici has an unbounded decompression chain in HTTP responses on Node.js Fetch API via Content-Encoding leads to resource exhaustion
- Advisory: https://github.com/advisories/GHSA-g9mf-h72j-4rw9
- Severity: Low
- Affected package: @vercel/blob >=0.0.3
```

## Impact

This vulnerability can lead to resource exhaustion through unbounded decompression chains in HTTP responses. While the severity is low, it should be addressed to improve the overall security posture of the application.

## Recommended Actions

1. Run `npm audit fix --force` to install a breaking change that resolves the vulnerability
2. Verify that the application still works correctly after the update
3. Test file upload functionality specifically, as this uses `@vercel/blob`

## Related Files

- package.json - Dependencies
- src/app/api/upload/route.ts - Uses Vercel Blob for file uploads
