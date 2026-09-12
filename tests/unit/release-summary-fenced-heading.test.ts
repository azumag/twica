import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const notifyWorkflow = readFileSync(
  join(repositoryRoot, ".github/workflows/notify-discord-main-merge.yml"),
  "utf8"
);
const releaseHeading = "## このリリースで変わること";

function extractReleaseSection(source: string): string {
  const body = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--/g, "");
  const lines = body.split(/\r\n?|\n/);
  const start = lines.findIndex((line) => line.trim() === releaseHeading);
  if (start === -1) return "";

  const releaseLines: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLength = 0;

  for (const line of lines.slice(start + 1)) {
    const stripped = line.trimStart();
    const fenceMatch = stripped.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fenceChar === null) {
        fenceChar = marker[0] as "`" | "~";
        fenceLength = marker.length;
      } else if (
        marker[0] === fenceChar &&
        marker.length >= fenceLength &&
        stripped.slice(marker.length).trim() === ""
      ) {
        fenceChar = null;
        fenceLength = 0;
      }
      releaseLines.push(line);
      continue;
    }

    if (fenceChar === null && line.trim().startsWith("## ")) break;
    releaseLines.push(line);
  }

  return releaseLines.join("\n").trim();
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

  it("keeps both embedded Python paths on the same fence-aware boundary contract", () => {
    const fenceMatcher = 'fence_match = re.match(r"^(`{3,}|~{3,})", stripped)';
    const boundaryCheck =
      'if fence_char is None and line.strip().startswith("## "):';
    const closeLengthCheck = "and len(marker) >= fence_len";

    expect(notifyWorkflow.split(fenceMatcher)).toHaveLength(3);
    expect(notifyWorkflow.split(boundaryCheck)).toHaveLength(3);
    expect(notifyWorkflow.split(closeLengthCheck)).toHaveLength(3);
  });
});
