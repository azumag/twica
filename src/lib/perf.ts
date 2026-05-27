import { logger } from "@/lib/logger";

type PerfContext = Record<string, string | number | boolean | null | undefined>;

export function perfStart(): number {
  return Date.now();
}

export function logPerf(surface: string, operation: string, startedAt: number, context?: PerfContext): void {
  const durationMs = Date.now() - startedAt;
  logger.info(`[Perf] ${surface} ${operation} ${durationMs}ms`, context ?? {});
}

export async function measurePerf<T>(
  surface: string,
  operation: string,
  task: () => Promise<T>,
  context?: PerfContext,
): Promise<T> {
  const startedAt = perfStart();
  try {
    return await task();
  } finally {
    logPerf(surface, operation, startedAt, context);
  }
}
