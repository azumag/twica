import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

// 作業ツリーの存在ではなく Git index の追跡状態を確認する。無視されたローカル
// 下書きは許可し、git add -f で追跡された下書きは作業ツリーに無くても検出する。
// -z の NUL 区切りでファイル名をそのまま扱い、root の完全一致だけを判定する。
function readTrackedDraftFiles(
  readIndex = () =>
    execFileSync("git", ["ls-files", "-z", "--cached", "--", ...PR_DRAFT_FILES], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
) {
  return new Set(readIndex().split("\0"));
}

const trackedFiles = readTrackedDraftFiles();

const gitignoreLines = readFileSync(join(process.cwd(), ".gitignore"), "utf8")
  .split("\n")
  .map((line) => line.trim());


describe("PR draft tracked-path regression", () => {
  it.each(PR_DRAFT_FILES)(
    "allows ignored local %s when the tracked-path list is empty",
    (filename) => {
      // ローカルの下書きがあっても index が空なら許可する。作業ツリーは参照しない。
      expect(readTrackedDraftFiles(() => "").has(filename)).toBe(false);
    }
  );

  it.each(PR_DRAFT_FILES)(
    "detects tracked %s even when it is absent from the worktree",
    (filename) => {
      // 作業ツリーに無い下書きでも index の NUL レコードから検出する。
      expect(readTrackedDraftFiles(() => `${filename}\0`).has(filename)).toBe(true);
    }
  );
});

describe("repository PR draft scratch guard (#837)", () => {
  it.each(PR_DRAFT_FILES)("does not track %s in the repository", (filename) => {
    expect(trackedFiles.has(filename)).toBe(false);
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
