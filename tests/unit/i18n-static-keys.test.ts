import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runStaticKeyCheck(cwd = process.cwd()) {
  const result = spawnSync(process.execPath, ["scripts/check-i18n-static-keys.mjs"], {
    cwd,
    encoding: "utf8",
  });
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return { result, details };
}

describe("static i18n keys", () => {
  it("keeps literal useTranslations keys present in both message catalogs", () => {
    const { result, details } = runStaticKeyCheck();

    expect(result.status, details || "static i18n key check did not exit cleanly").toBe(0);
    expect(details).toMatch(/Static i18n key check passed \(([1-9]\d*) source files scanned\)\./);
  });

  it("fails when a scanned source references a missing literal key", async () => {
    // Keep the fixture under the repository so the copied checker can resolve the repository's
    // `typescript` package through normal Node module lookup. The prefix is ignored because a
    // force-killed test process cannot run the cleanup below.
    const tempRoot = await mkdtemp(path.join(process.cwd(), ".tmp-i18n-static-keys-"));

    try {
      await Promise.all([
        mkdir(path.join(tempRoot, "scripts"), { recursive: true }),
        mkdir(path.join(tempRoot, "src"), { recursive: true }),
        mkdir(path.join(tempRoot, "messages"), { recursive: true }),
      ]);
      await Promise.all([
        copyFile(
          path.join(process.cwd(), "scripts", "check-i18n-static-keys.mjs"),
          path.join(tempRoot, "scripts", "check-i18n-static-keys.mjs"),
        ),
        copyFile(path.join(process.cwd(), "messages", "en.json"), path.join(tempRoot, "messages", "en.json")),
        copyFile(path.join(process.cwd(), "messages", "ja.json"), path.join(tempRoot, "messages", "ja.json")),
        writeFile(
          path.join(tempRoot, "src", "missing-key.ts"),
          [
            'declare const useTranslations: (namespace: string) => (key: string) => string;',
            'const t = useTranslations("__i18nStaticKeysFixture");',
            'export const missing = t("definitelyMissing");',
            "",
          ].join("\n"),
          "utf8",
        ),
      ]);

      const { result, details } = runStaticKeyCheck(tempRoot);

      expect(result.status, details || "static i18n key check unexpectedly succeeded").toBe(1);
      expect(details).toContain("__i18nStaticKeysFixture.definitelyMissing");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
