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
const releaseSummaryScriptPath = join(
  repositoryRoot,
  ".github/scripts/release_summary.py"
);
const releaseSummaryScript = readFileSync(releaseSummaryScriptPath, "utf8");

function extractReleaseSection(source: string): string {
  return execFileSync("python3", [releaseSummaryScriptPath], {
    encoding: "utf8",
    env: { ...process.env, PR_BODY: source },
  });
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

  it("keeps validation and notification on the same shared heading parser contract", () => {
    expect(releaseSummaryScript).toContain("def h2_text(line: str) -> str | None:");
    expect(releaseSummaryScript).toContain(
      'match = re.fullmatch(r"##[ \\t]+(.+?)(?:[ \\t]+#+)?[ \\t]*", line.strip())'
    );
    expect(notifyWorkflow).toContain(
      "python3 .github/scripts/release_summary.py --validate"
    );
    expect(notifyWorkflow).toContain(
      "release_summary.extract_release_text(body)"
    );
  });
});
