# Supabase Mock Utilities

This document describes the Supabase mocking utilities available in `tests/utils/supabase-mock.ts`.

## Overview

The Supabase mock utilities provide a simplified, type-safe way to mock Supabase database operations in tests. They handle the complex method chaining (`.from().select().eq().single()`) and make it easy to define test scenarios.

## Installation

The utilities are automatically available in all test files through the global test setup in `tests/setup.ts`.

## Basic Usage

### Creating a Simple Mock

```typescript
import { createSupabaseMock } from '../utils/supabase-mock'

const mockSupabase = createSupabaseMock()
  .withSingleResponse({ id: 'test-id' })
  .build()
```

### Mocking with the Builder Pattern

The `SupabaseMockBuilder` class provides a fluent API for creating complex mocks:

```typescript
import { createSupabaseMock } from '../utils/supabase-mock'

const mockSupabase = createSupabaseMock()
  .withTable('users')
  .withSingleResponse({ id: 'user-123', name: 'Test User' })
  .build()
```

## API Reference

### Functions

#### `createSupabaseMock()`

Creates a new `SupabaseMockBuilder` instance for building custom mocks.

```typescript
const builder = createSupabaseMock()
```

#### `createMockSupabaseClient()`

Creates a basic mocked Supabase client with default behavior.

```typescript
const client = createMockSupabaseClient()
```

#### `createMockResponse(data, error)`

Creates a standard Supabase response object.

```typescript
const successResponse = createMockResponse({ id: 'test' }, null)
const errorResponse = createMockResponse(null, new Error('Database error'))
```

#### `createMockQueryBuilder()`

Creates a mock query builder that can handle method chaining.

```typescript
const queryBuilder = createMockQueryBuilder()
```

### SupabaseMockBuilder

#### Methods

- `withTable(table: string)`: Specifies the table name (for documentation purposes)
- `withSingleResponse(data, error?)`: Sets the response for `.single()` calls
- `withMaybeSingleResponse(data, error?)`: Sets the response for `.maybeSingle()` calls
- `withCountResponse(count, error?)`: Sets the response for `.count()` calls
- `build()`: Returns a complete mock Supabase client
- `buildFromMock()`: Returns a mock function for `.from()` method
- `getQueryBuilder()`: Returns the raw query builder for advanced customization

## Examples

### Example 1: Mocking a SELECT Query

```typescript
const mockSupabase = createSupabaseMock()
  .withSingleResponse({
    id: 'streamer-123',
    twitch_user_id: 'twitch-user-id'
  })
  .build()

// Mock the getSupabaseAdmin function
vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any)
```

### Example 2: Mocking with Error Response

```typescript
const mockSupabase = createSupabaseMock()
  .withSingleResponse(null, new Error('Not found'))
  .build()

// Test error handling
const response = await POST(request)
expect(response.status).toBe(404)
```

### Example 3: Testing Multiple Scenarios

```typescript
describe('User API', () => {
  it('should return user when found', () => {
    const mockSupabase = createSupabaseMock()
      .withSingleResponse({ id: 'user-1', name: 'Test' })
      .build()
    vi.mocked(getSupabaseClient).mockReturnValue(mockSupabase as any)

    // Test implementation
  })

  it('should return 404 when user not found', () => {
    const mockSupabase = createSupabaseMock()
      .withSingleResponse(null, new Error('Not found'))
      .build()
    vi.mocked(getSupabaseClient).mockReturnValue(mockSupabase as any)

    // Test error handling
  })
})
```

### Example 4: Refactoring Existing Tests

**Before (complex, hard to maintain):**

```typescript
const mockSupabaseAdmin = {
  from: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: 'test' } }),
        }),
      }),
    }),
  }),
  update: vi.fn().mockResolvedValue({ data: {}, error: null }),
}
```

**After (clean, readable):**

```typescript
const mockSupabase = createSupabaseMock()
  .withSingleResponse({ id: 'test' })
  .build()
```

## Type Safety

The utilities use TypeScript generics to ensure type safety:

```typescript
interface User {
  id: string
  name: string
}

const mockSupabase = createSupabaseMock<User>()
  .withSingleResponse({ id: 'user-1', name: 'Test User' })
  .build()
```

## Common Patterns

### Mocking Multiple Tables

```typescript
const mockSupabaseAdmin = createSupabaseMock()
  .withTable('streamers')
  .withSingleResponse({ id: 'streamer-123' })
  .build()
```

### Mocking Async Operations

```typescript
it('should handle async database operations', async () => {
  const mockSupabase = createSupabaseMock()
    .withSingleResponse({ id: 'test' })
    .build()

  // Wait for async operation to complete
  const response = await POST(request)
  expect(response.status).toBe(200)
})
```

## Troubleshooting

### Issue: "No export is defined on mock" Error

This occurs when the module is not properly mocked. Use the async mock pattern:

```typescript
vi.mock('@/lib/supabase/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/admin')>()
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  }
})
```

### Issue: Mock Returns Undefined

Make sure to call `mockReturnValue()` with the built mock:

```typescript
const mockSupabase = createSupabaseMock()
  .withSingleResponse({ id: 'test' })
  .build()

vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any)
```

## Best Practices

1. **Use Builder Pattern**: Always use the builder pattern for creating complex mocks
2. **Be Explicit**: Set clear responses for each test scenario
3. **Type Your Mocks**: Use generics for better type safety and IDE support
4. **Keep It Simple**: Don't create overly complex mock chains - the utilities handle that
5. **Test Both Success and Failure**: Always test both happy path and error cases

## Migration Guide

### From Old Mocks to New Mocks

**Step 1:** Replace manual mock creation with builder:

```typescript
// Old
const mock = {
  from: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: {} }),
      }),
    }),
  }),
}

// New
const mock = createSupabaseMock()
  .withSingleResponse({})
  .build()
```

**Step 2:** Update test assertions if necessary (most will work without changes)

**Step 3:** Run tests to verify

## Related Documentation

- [Vitest Mocking Guide](https://vitest.dev/guide/mocking.html)
- [Testing Guidelines](../README.md#testing-guidelines)
- [Test Structure Documentation](../README.md#testing-structure)