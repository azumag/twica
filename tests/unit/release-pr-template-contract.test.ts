import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const releaseTemplate = readFileSync(
  join(repositoryRoot, ".github/PULL_REQUEST_TEMPLATE/release.md"),
  "utf8"
);
const qaDocument = readFileSync(join(repositoryRoot, "docs/QA.md"), "utf8");

const REQUIRED_TEMPLATE_HEADINGS = [
  "## このリリースで変わること",
  "## 対象PRと固定SHA",
  "## 累積release-unit一覧",
  "## 確認済み",
  "## main昇格条件",
] as const;

function h2Headings(source: string): string[] {
  return source.split(/\r?\n/).filter((line) => line.startsWith("## "));
}

function h2Section(source: string, heading: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === heading);
  if (start === -1) return "";

  const next = lines.findIndex(
    (line, index) => index > start && line.startsWith("## ")
  );
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

const qaReleaseContract = h2Section(
  qaDocument,
  "## Preview→main昇格PRのタイトル・本文契約"
);

describe("preview -> main release PR template contract", () => {
  it("keeps the user-facing release summary as the first H2 heading", () => {
    expect(h2Headings(releaseTemplate)[0]).toBe(REQUIRED_TEMPLATE_HEADINGS[0]);
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

  it("keeps docs/QA.md aligned with the template responsibilities", () => {
    expect(qaReleaseContract).not.toBe("");
    expect(qaReleaseContract).toContain("`## このリリースで変わること`");
    expect(qaReleaseContract).toContain(
      ".github/PULL_REQUEST_TEMPLATE/release.md"
    );

    for (const requiredTerm of [
      "対象PRと固定SHA",
      "累積release-unit一覧",
      "レビュー",
      "CI",
      "previewデプロイ",
      "ブラウザー／実経路の確認",
      "main昇格条件",
    ]) {
      expect(qaReleaseContract).toContain(requiredTerm);
    }
  });
});
