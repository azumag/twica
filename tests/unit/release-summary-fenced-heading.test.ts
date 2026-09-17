import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const notifyWorkflow = readFileSync(
  join(repositoryRoot, ".github/workflows/notify-discord-main-merge.yml"),
  "utf8"
);
const releaseSummaryScript = join(
  repositoryRoot,
  ".github/scripts/release_summary.py"
);
const releaseHeading = "## このリリースで変わること";

function extractReleaseSection(source: string): string {
  return execFileSync("python3", [releaseSummaryScript], {
    encoding: "utf8",
    env: { ...process.env, PR_BODY: source },
  });
}

describe("promotion summary fenced heading contract", () => {
  it("keeps H2-looking lines inside backtick fences and stops at the next real H2", () => {
    const body = [
      releaseHeading,
      "利用者向け説明",
      "```text",
      "## これはコード例の見出し",
      "value=1",
      "```",
      "続きの説明",
      "## 対象PRと固定SHA",
      "- #123",
    ].join("\n");

    expect(extractReleaseSection(body)).toBe(
      [
        "利用者向け説明",
        "```text",
        "## これはコード例の見出し",
        "value=1",
        "```",
        "続きの説明",
      ].join("\n")
    );
  });

  it("supports tilde fences and a longer matching closing fence", () => {
    const body = [
      releaseHeading,
      "~~~~text",
      "## fenced",
      "~~~~~",
      "after fence",
      "## 確認済み",
    ].join("\n");

    expect(extractReleaseSection(body)).toContain("## fenced");
    expect(extractReleaseSection(body)).toContain("after fence");
    expect(extractReleaseSection(body)).not.toContain("## 確認済み");
  });

  it("uses the shared helper from validation and notification instead of duplicating the parser", () => {
    expect(notifyWorkflow).toContain(
      "python3 .github/scripts/release_summary.py --validate"
    );
    expect(notifyWorkflow).toContain('sys.path.insert(0, ".github/scripts")');
    expect(notifyWorkflow).toContain(
      "release_summary.extract_release_text(body)"
    );
    expect(notifyWorkflow).not.toContain(
      'fence_match = re.match(r"^(`{3,}|~{3,})", stripped)'
    );
  });
});
