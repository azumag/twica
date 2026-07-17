export type ErrorSignals = {
  codes: Set<string>;
  text: string;
};

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  details?: unknown;
  hint?: unknown;
  query?: unknown;
  cause?: unknown;
};

/**
 * DrizzleQueryError などのラッパーを含む cause チェーンから、判定に必要な
 * PostgreSQL/PostgREST のコードとテキストを収集する。自己参照・相互参照は
 * visited で停止し、無限ループを防ぐ。
 */
export function collectErrorSignals(error: unknown): ErrorSignals {
  const codes = new Set<string>();
  const textParts: string[] = [];
  const visited = new Set<object>();
  let current: unknown = error;

  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const err = current as ErrorLike;

    if (typeof err.code === "string") codes.add(err.code);
    for (const value of [err.message, err.detail, err.details, err.hint, err.query]) {
      if (value !== undefined && value !== null) textParts.push(String(value));
    }

    current = err.cause;
  }

  return { codes, text: textParts.join(" ") };
}
