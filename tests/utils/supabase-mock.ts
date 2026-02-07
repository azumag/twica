/* eslint-disable @typescript-eslint/no-explicit-any */
import { vi } from 'vitest'

export interface MockQueryBuilder<T = unknown> {
  select: (columns?: string) => MockQueryBuilder<T>
  insert: (data: Partial<T> | Partial<T>[]) => MockQueryBuilder<T>
  upsert: (data: Partial<T> | Partial<T>[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) => MockQueryBuilder<T>
  update: (data: Partial<T>) => MockQueryBuilder<T>
  delete: () => MockQueryBuilder<T>
  eq: (column: string, value: unknown) => MockQueryBuilder<T>
  neq: (column: string, value: unknown) => MockQueryBuilder<T>
  gt: (column: string, value: unknown) => MockQueryBuilder<T>
  gte: (column: string, value: unknown) => MockQueryBuilder<T>
  lt: (column: string, value: unknown) => MockQueryBuilder<T>
  lte: (column: string, value: unknown) => MockQueryBuilder<T>
  like: (column: string, pattern: string) => MockQueryBuilder<T>
  ilike: (column: string, pattern: string) => MockQueryBuilder<T>
  in: (column: string, values: unknown[]) => MockQueryBuilder<T>
  is: (column: string, value: unknown) => MockQueryBuilder<T>
  order: (column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => MockQueryBuilder<T>
  limit: (count: number) => MockQueryBuilder<T>
  range: (from: number, to: number) => MockQueryBuilder<T>
  single: () => Promise<{ data: T | null; error: Error | null }>
  maybeSingle: () => Promise<{ data: T | null; error: Error | null }>
  count: (exact?: boolean) => Promise<{ count: number | null; error: Error | null }>
}

export interface MockSupabaseClient {
  from: <T = unknown>(table: string) => MockQueryBuilder<T>
  rpc: (fnname: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>
}

export interface MockSupabaseResponse<T> {
  data: T | null
  error: Error | null
}

export function createMockResponse<T>(data: T | null = null, error: Error | null = null): MockSupabaseResponse<T> {
  return { data, error }
}

export function createMockQueryBuilder<T = unknown>(
  initialData: MockSupabaseResponse<T> | null = null
): MockQueryBuilder<T> {
  const query = {} as MockQueryBuilder<T>

  const chainableMethods = [
    'select', 'insert', 'upsert', 'update', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'like', 'ilike', 'in', 'is',
    'order', 'limit', 'range'
  ]

  chainableMethods.forEach((method) => {
    ;(query as any)[method] = vi.fn().mockReturnValue(query)
  })

  query.single = vi.fn().mockResolvedValue(
    initialData || createMockResponse<T>(null, null)
  )

  query.maybeSingle = vi.fn().mockResolvedValue(
    initialData || createMockResponse<T>(null, null)
  )

  query.count = vi.fn().mockResolvedValue(
    initialData || createMockResponse<number>(null, null)
  )

  return query
}

export function createMockSupabaseClient(): MockSupabaseClient {
  const mockClient: unknown = {
    from: vi.fn(() => createMockQueryBuilder()),
    rpc: vi.fn().mockResolvedValue({
      data: null,
      error: null,
    }),
  }

  return mockClient as MockSupabaseClient
}

export function setupSupabaseMock<T = unknown>(
  mockFn: ReturnType<typeof vi.fn>,
  responses: Record<string, MockSupabaseResponse<T>>
): { queryBuilder: MockQueryBuilder<T>; mockFn: ReturnType<typeof vi.fn> } {
  const queryBuilder = createMockQueryBuilder()

  Object.keys(responses).forEach((method) => {
    if (method === 'single' || method === 'maybeSingle') {
      const response = responses[method]
      if (response) {
        ;(queryBuilder[method] as ReturnType<typeof vi.fn>).mockResolvedValue(response)
      }
    }
  })

  mockFn.mockReturnValue(queryBuilder)

  return { queryBuilder: queryBuilder as MockQueryBuilder<T>, mockFn }
}

export class SupabaseMockBuilder<T = unknown> {
  private queryBuilder: MockQueryBuilder<T>

  constructor() {
    this.queryBuilder = createMockQueryBuilder<T>()
  }

  withTable(): this {
    return this
  }

  withSingleResponse(data: T | null, error: Error | null = null): this {
    ;(this.queryBuilder.single as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockResponse(data, error)
    )
    return this
  }

  withMaybeSingleResponse(data: T | null, error: Error | null = null): this {
    ;(this.queryBuilder.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockResponse(data, error)
    )
    return this
  }

  withCountResponse(count: number): this {
    ;(this.queryBuilder.count as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockResponse(count, null)
    )
    return this
  }

  withSelectResponse(): this {
    return this
  }

  build(): MockSupabaseClient {
    const client = {} as any
    client.from = vi.fn(() => this.queryBuilder)
    return client
  }

  buildFromMock(): ReturnType<typeof vi.fn> {
    return vi.fn(() => this.queryBuilder as any)
  }

  getQueryBuilder(): MockQueryBuilder<T> {
    return this.queryBuilder
  }
}

export function createSupabaseMock(): SupabaseMockBuilder {
  return new SupabaseMockBuilder()
}

export function mockSupabaseQuery<T = unknown>(
  mockFn: ReturnType<typeof vi.fn>,
  responses: {
    select?: MockSupabaseResponse<T[]>
    single?: MockSupabaseResponse<T>
    maybeSingle?: MockSupabaseResponse<T>
    insert?: MockSupabaseResponse<T>
    update?: MockSupabaseResponse<T>
    delete?: MockSupabaseResponse<T>
  }
): MockQueryBuilder<T> {
  const queryBuilder = createMockQueryBuilder<T>()

  if (responses.single) {
    ;(queryBuilder.single as ReturnType<typeof vi.fn>).mockResolvedValue(responses.single)
  }

  if (responses.maybeSingle) {
    ;(queryBuilder.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(responses.maybeSingle)
  }

  mockFn.mockReturnValue(queryBuilder)

  return queryBuilder
}