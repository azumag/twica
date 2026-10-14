import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #837（陳腐化したリポジトリ資産の整理）の再混入防止ガード。
 *
 * PR #1794 で `gh pr create --body-file` の素材だった `pr-body.md` /
 * `pr-preview.md` がリポジトリ root へ誤って commit された。いずれも実装コード・
 * ワークフロー・ドキュメントからの参照は 0 件で、PR の作業が終わった時点で価値を
 * 失う scratch 資産である。削除だけでなく、同じ事故が再発しないことを検証する。
 */

const PR_DRAFT_FILES = ["pr-body.md", "pr-preview.md"];

const gitignoreLines = readFileSync(join(process.cwd(), ".gitignore"), "utf8")
  .split("\n")
  .map((line) => line.trim());

describe("repository PR draft scratch guard (#837)", () => {
  it.each(PR_DRAFT_FILES)("does not track %s in the repository", (filename) => {
    // 追跡対象のファイルは checkout 後の作業ツリーに存在するため、ファイルの不在が
    // 「tracked でない」ことを確認できる。.gitignore のみでは git add -f を防げない。
    expect(existsSync(join(process.cwd(), filename))).toBe(false);
  });

  it.each(PR_DRAFT_FILES)(
    "ignores %s at the repository root so it cannot be re-committed",
    (filename) => {
      // ルート限定（先頭 `/`）で無視する。サブディレクトリの同名ファイルまで
      // 巻き込まない。
      expect(gitignoreLines).toContain(`/${filename}`);
    }
  );
});
