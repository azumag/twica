import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const notifyWorkflow = readFileSync(
  join(repositoryRoot, ".github/workflows/notify-discord-main-merge.yml"),
  "utf8"
);
const releaseHeadingText = "このリリースで変わること";

function h2Text(line: string): string | null {
  const match = line
    .trim()
    .match(/^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
  return match?.[1]?.trim() ?? null;
}

function extractReleaseSection(source: string): string {
  const lines = source.split(/\r\n?|\n/);
  const start = lines.findIndex((line) => h2Text(line) === releaseHeadingText);
  if (start === -1) return "";

  const releaseLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (h2Text(line) !== null) break;
    releaseLines.push(line);
  }
  return releaseLines.join("\n").trim();
}

describe("promotion summary heading normalization", () => {
  it("accepts canonical and equivalent ATX H2 notation", () => {
    const canonical = [
      "## このリリースで変わること",
      "canonical body",
      "## 確認済み",
    ].join("\n");
    const normalized = [
      "##\tこのリリースで変わること ##",
      "normalized body",
      "##\t確認済み ###",
      "must not leak",
    ].join("\n");

    expect(extractReleaseSection(canonical)).toBe("canonical body");
    expect(extractReleaseSection(normalized)).toBe("normalized body");
  });

  it("does not confuse H3 or an attached hash suffix with the release H2", () => {
    expect(
      extractReleaseSection("### このリリースで変わること\nbody")
    ).toBe("");
    expect(
      extractReleaseSection("## このリリースで変わること##\nbody")
    ).toBe("");
  });

  it("keeps validation and notification on the same heading parser contract", () => {
    const headingParser = "def h2_text(line):";
    const headingMatcher =
      'match = re.fullmatch(r"##[ \\t]+(.+?)(?:[ \\t]+#+)?[ \\t]*", line.strip())';
    const startCheck = "if h2_text(line) == section_heading_text:";
    const boundaryCheck = "if fence_char is None and h2_text(line) is not None:";

    expect(notifyWorkflow.split(headingParser)).toHaveLength(3);
    expect(notifyWorkflow.split(headingMatcher)).toHaveLength(3);
    expect(notifyWorkflow.split(startCheck)).toHaveLength(3);
    expect(notifyWorkflow.split(boundaryCheck)).toHaveLength(3);
  });
});
