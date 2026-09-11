import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readContractSource(relativePath: string, contractName: string): string {
  try {
    return readFileSync(join(repositoryRoot, relativePath), "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // These files are loaded during Vitest collection, so include the logical contract
    // name in the thrown error instead of leaving reviewers with a bare ENOENT path.
    throw new Error(
      `Failed to load release contract source "${contractName}" (${relativePath}): ${detail}`
    );
  }
}

const releaseTemplate = readContractSource(
  ".github/PULL_REQUEST_TEMPLATE/release.md",
  "release PR template"
);
const qaDocument = readContractSource("docs/QA.md", "preview promotion QA");
const notifyWorkflow = readContractSource(
  ".github/workflows/notify-discord-main-merge.yml",
  "Discord promotion notification workflow"
);

const REQUIRED_TEMPLATE_HEADINGS = [
  "## このリリースで変わること",
  "## 対象PRと固定SHA",
  "## 累積release-unit一覧",
  "## 確認済み",
  "## main昇格条件",
] as const;

const REQUIRED_CONFIRMATION_LABELS = [
  "レビュー",
  "CI",
  "previewデプロイ",
  "ブラウザー／実経路の確認",
] as const;
const BROWSER_CONFIRMATION_HINT = "<!-- 対象外の場合は理由を記載 -->";

function headingScanLines(source: string): string[] {
  // The promotion workflow removes complete HTML comments before heading extraction.
  // Preserve their newline count here so scan-line indexes still map to the
  // original source used by the rest of the contract assertions. A stray opener
  // drops only the delimiter so later release text/headings are not swallowed.
  const withoutClosedHtmlComments = source.replace(
    /<!--[\s\S]*?-->/g,
    (comment) => comment.replace(/[^\r\n]/g, "")
  );
  const withoutStrayOpeners = withoutClosedHtmlComments.replace(/<!--/g, "");
  return withoutStrayOpeners.split(/\r?\n/);
}

function normalizedHeading(line: string): string {
  // Match the workflow's Python line.strip() comparison for H2 detection only.
  return line.trim();
}

function h2Headings(source: string): string[] {
  return headingScanLines(source)
    .map(normalizedHeading)
    .filter((line) => line.startsWith("## "));
}

function h2Section(source: string, heading: string): string {
  const sourceLines = source.split(/\r?\n/);
  const scanLines = headingScanLines(source);
  const start = scanLines.findIndex((line) => normalizedHeading(line) === heading);
  if (start === -1) return "";

  const next = scanLines.findIndex(
    (line, index) => index > start && normalizedHeading(line).startsWith("## ")
  );
  return sourceLines.slice(start, next === -1 ? undefined : next).join("\n");
}

const qaReleaseContract = h2Section(
  qaDocument,
  "## Preview→main昇格PRのタイトル・本文契約"
);

describe("preview -> main release PR template contract", () => {
  // 最初のH2を利用者向け要約に固定し、技術的な証跡より先に「何が変わるか」を
  // レビュー・通知の読み手が確認できるという QA.md の本文契約を守る。
  it("keeps the user-facing release summary as the first H2 heading", () => {
    expect(h2Headings(releaseTemplate)[0]).toBe(REQUIRED_TEMPLATE_HEADINGS[0]);
  });

  it("mirrors the promotion workflow's HTML-comment and heading whitespace normalization", () => {
    const source = [
      "<!--",
      "## hidden guidance heading",
      "-->",
      "  ## visible heading  ",
      "  release text <!-- keep this in the returned contract section -->",
      "   ## next heading   ",
    ].join("\n");

    expect(h2Headings(source)).toEqual([
      "## visible heading",
      "## next heading",
    ]);
    expect(h2Section(source, "## visible heading")).toBe(
      "  ## visible heading  \n  release text <!-- keep this in the returned contract section -->"
    );
  });

  it("does not swallow later headings after an unmatched HTML comment opener", () => {
    const source = [
      "<!-- literal opener used in explanatory text",
      "## visible heading",
      "release text",
      "## next heading",
    ].join("\n");

    expect(h2Headings(source)).toEqual([
      "## visible heading",
      "## next heading",
    ]);
  });

  it("keeps both promotion workflow paths on bounded HTML-comment sanitization", () => {
    const boundedCommentSanitizer =
      'body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)';
    const strayOpenerSanitizer = 'body = body.replace("<!--", "")';

    expect(notifyWorkflow.split(boundedCommentSanitizer)).toHaveLength(3);
    expect(notifyWorkflow.split(strayOpenerSanitizer)).toHaveLength(3);
    expect(notifyWorkflow).not.toContain('r"<!--.*?(?:-->|$)"');
  });

  it("reports the logical contract name when a source file is missing", () => {
    expect(() =>
      readContractSource(
        "tests/unit/__missing_release_contract_source__",
        "missing-source diagnostic"
      )
    ).toThrow(
      'Failed to load release contract source "missing-source diagnostic"'
    );
  });

  it("keeps the Discord promotion consumer on the same summary heading", () => {
    const sectionHeadings = Array.from(
      notifyWorkflow.matchAll(/section_heading = "([^"]+)"/g),
      (match) => match[1]
    );

    expect(sectionHeadings).toEqual([
      REQUIRED_TEMPLATE_HEADINGS[0],
      REQUIRED_TEMPLATE_HEADINGS[0],
    ]);
  });

  it("keeps the required release sections in the documented order", () => {
    const headings = h2Headings(releaseTemplate);
    const requiredHeadings = headings.filter((heading) =>
      REQUIRED_TEMPLATE_HEADINGS.includes(
        heading as (typeof REQUIRED_TEMPLATE_HEADINGS)[number]
      )
    );

    expect(requiredHeadings).toEqual([...REQUIRED_TEMPLATE_HEADINGS]);
  });

  it("keeps required confirmation labels as top-level rows in documented order", () => {
    const confirmationRows = h2Section(releaseTemplate, "## 確認済み")
      .split(/\r?\n/)
      // Do not trim indentation here: these evidence slots are top-level rows,
      // while their value text and HTML hints are intentionally not part of the label contract.
      .filter((line) => line.startsWith("- "));

    let previousIndex = -1;
    for (const label of REQUIRED_CONFIRMATION_LABELS) {
      const rowPrefix = `- ${label}:`;
      const currentIndex = confirmationRows.findIndex((line) =>
        line.startsWith(rowPrefix)
      );
      expect(currentIndex).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }

    const browserRow = confirmationRows.find((line) =>
      line.startsWith(`- ${REQUIRED_CONFIRMATION_LABELS[3]}:`)
    );
    // The browser/real-path slot keeps its operator hint, but the contract no longer
    // freezes the complete row value so future guidance can evolve independently.
    expect(browserRow).toContain(BROWSER_CONFIRMATION_HINT);
  });

  it("keeps docs/QA.md aligned with the template responsibilities", () => {
    expect(qaReleaseContract).not.toBe("");
    expect(qaReleaseContract).toContain("`## このリリースで変わること`");
    expect(qaReleaseContract).toContain(
      ".github/PULL_REQUEST_TEMPLATE/release.md"
    );

    const requiredTerms = [
      "対象PRと固定SHA",
      "累積release-unit一覧",
      "レビュー",
      "CI",
      "previewデプロイ",
      "ブラウザー／実経路の確認",
      "main昇格条件",
    ];

    // Keep the contract tied to the documented responsibility list. Searching
    // only this bullet prevents unrelated mentions elsewhere in QA.md from
    // making a missing or reordered responsibility pass.
    const responsibilityLines = qaReleaseContract
      .split(/\r?\n/)
      .filter(
        (line) => line.startsWith("- ") && line.includes("対象PRと固定SHA")
      );
    expect(responsibilityLines).toHaveLength(1);
    const responsibilityLine = responsibilityLines[0] ?? "";

    let previousIndex = -1;
    for (const requiredTerm of requiredTerms) {
      const currentIndex = responsibilityLine.indexOf(requiredTerm);
      expect(currentIndex).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }
  });
});
