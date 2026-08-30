# Log sanitization boundaries

`src/lib/log-sanitizer.ts` applies the same text sanitization policy to console logs and persisted error-reporting paths. This document records a deliberately conservative boundary that is easy to misread as Drizzle-specific behavior.

## `params:` line handling

`sanitizeErrorText()` treats a line whose first non-whitespace token is `params:` as the start of potentially sensitive bind-parameter output.

The current matcher is equivalent to:

```text
(^|\r?\n)[whitespace]params:[whitespace]...
```

Once that marker is found, the sanitizer replaces everything after `params:` through the end of the string with `[REDACTED]`.

This fail-closed behavior exists because `DrizzleQueryError.message` can contain database bind values after a `params:` line. Bind values themselves can contain newlines or text that looks like stack frames, so the sanitizer must not guess where a parameter list ends from its contents.

## Intentional false-positive boundary

The text sanitizer does not inspect the producer of the string. A non-Drizzle application log is therefore redacted in the same way when it contains a line beginning with `params:`.

For example, diagnostic prose such as:

```text
request rejected
params: harmless-example
extra diagnostic text
```

is intentionally reduced to the prefix plus a redacted `params:` value; the trailing diagnostic text is not preserved.

Do not rely on data after a line-leading `params:` marker remaining visible in logs. If such text is operationally important, avoid emitting it in this ambiguous free-form shape and prefer structured, explicitly named diagnostic fields that comply with the key-based redaction policy.

## Known format dependency

The current safeguard recognizes `params:` only at the start of the string or at the start of a new line, allowing indentation before the marker. A future Drizzle formatting change that flattens the marker into unrelated same-line prose would not match this boundary automatically. Changes to Drizzle error formatting should therefore be reviewed together with the sanitizer contract and its tests.

This is a documentation-only description of the current policy; it does not broaden or relax redaction behavior.
