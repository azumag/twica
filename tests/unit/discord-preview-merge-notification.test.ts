import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(
  join(repositoryRoot, ".github/workflows/notify-discord-main-merge.yml"),
  "utf8"
);

// The notification text is rendered by an inline Python heredoc inside the
// workflow. These tests execute that exact snippet, so the shipped wording and
// fallbacks are covered instead of being re-implemented in the test.
function notificationSnippet(source: string): string {
  const match = source.match(
    /content=\$\(python3 - <<'PY'\n([\s\S]*?)\n\s+PY\n\s+\)/
  );
  if (!match) {
    throw new Error(
      "Failed to locate the Discord notification snippet in notify-discord-main-merge.yml"
    );
  }
  return match[1];
}

const pythonRunner = [
  "import sys, textwrap",
  "source = sys.stdin.read()",
  // The snippet is indented inside the workflow YAML block scalar; dedenting
  // restores the exact source that GitHub Actions executes.
  'exec(compile(textwrap.dedent(source), "discord-notify", "exec"), {"__name__": "__main__"})',
].join("\n");

// `spawnSync` (instead of `execFileSync`) keeps the snippet's stderr out of the
// CI log unless the snippet fails. The step's `::warning::` output is a GitHub
// Actions workflow command, so echoing it from a passing test would add a
// misleading CI annotation.
function runNotification(env: Record<string, string>): {
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("python3", ["-c", pythonRunner], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: notificationSnippet(workflow),
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Discord notification snippet exited with status ${result.status}: ${result.stderr}`
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function renderNotification(env: Record<string, string>): string {
  return runNotification(env).stdout;
}

// Discord measures message content in UTF-16 code units, mirroring
// release_summary.utf16_length.
function utf16Length(value: string): number {
  return Buffer.byteLength(value, "utf16le") / 2;
}

const notifyEnv = {
  REPOSITORY_NAME: "twica",
  PR_TITLE: "fix(trade): トレード一覧の更新失敗通知を改善する",
  PR_BODY: "## 概要\n\n実装の説明",
  PR_URL: "https://github.com/azumag/twica/pull/1801",
  PR_AUTHOR: "azumag",
  HEAD_REF: "agent/trade-refresh",
  HEAD_REPOSITORY: "azumag/twica",
  GITHUB_REPOSITORY: "azumag/twica",
};

describe("Discord merge notification target wording", () => {
  it("reads the target branch from the trusted base context", () => {
    // Removing or re-pointing this env entry would silently disable the
    // promotion-only failure marker below, so pin the trusted source here.
    expect(workflow).toContain(
      "BASE_REF: ${{ github.event.pull_request.base.ref }}"
    );
  });

  it("notifies a preview merge with the preview wording and the PR title", () => {
    const { stdout: content, stderr } = runNotification({
      ...notifyEnv,
      BASE_REF: "preview",
    });

    expect(content).toContain("🧪 **twica (preview) が更新されました**");
    expect(content).toContain(`\`${notifyEnv.HEAD_REF}\` → preview`);
    expect(content).toContain(notifyEnv.PR_TITLE);
    // A feature PR body without the release section must not leak into the
    // notification; the sanitized PR title is the agreed preview content source.
    expect(content).not.toContain("実装の説明");
    expect(content).toContain("🔗 [更新内容を見る]");
    expect(content).not.toContain("→ main");
    // A preview merge is not a promotion, so the promotion-only warning and the
    // post-delivery job failure must not trigger for it.
    expect(stderr).not.toContain("::warning::");
  });

  it("uses a preview PR body that carries the release summary section", () => {
    // The shared extraction path is deliberately kept for preview merges: a body
    // with the promotion heading is used verbatim instead of the title, and that
    // conditional behavior is pinned here so the docs and code stay aligned.
    const { stdout: content } = runNotification({
      ...notifyEnv,
      BASE_REF: "preview",
      PR_BODY: "## このリリースで変わること\n\n本文の要約\n",
    });

    expect(content).toContain("🧪 **twica (preview) が更新されました**");
    expect(content).toContain("本文の要約");
    expect(content).not.toContain(notifyEnv.PR_TITLE);
  });

  it("keeps the preview wording when the base ref is not main", () => {
    // Production wording requires an explicit `main` base, so a missing env entry
    // or a future extra trigger branch can never announce an unreleased deploy as
    // a shipped release.
    for (const baseRef of ["", "staging"]) {
      const content = renderNotification({ ...notifyEnv, BASE_REF: baseRef });

      expect(content).toContain("🧪 **twica (preview) が更新されました**");
      expect(content).toContain("→ preview");
      expect(content).not.toContain("→ main");
    }
  });

  it("keeps the production wording for a preview -> main promotion", () => {
    const content = renderNotification({
      ...notifyEnv,
      BASE_REF: "main",
      HEAD_REF: "preview",
      PR_BODY: "## このリリースで変わること\n\n利用者向けの説明\n",
    });

    expect(content).toContain("🚀 **twica が更新されました**");
    expect(content).toContain("利用者向けの説明");
    expect(content).toContain("`preview` → main");
    expect(content).toContain("🔗 [リリース内容を見る]");
    expect(content).not.toContain("(preview)");
  });

  it("falls back to the sanitized title for a direct main merge", () => {
    const { stdout: content, stderr } = runNotification({
      ...notifyEnv,
      BASE_REF: "main",
    });

    expect(content).toContain("🚀 **twica が更新されました**");
    expect(content).toContain(notifyEnv.PR_TITLE);
    expect(content).toContain("→ main");
    // Only the canonical preview -> main promotion may warn/fail on a missing
    // summary, so a direct main merge must stay a silent title fallback.
    expect(stderr).not.toContain("::warning::");
  });

  it("does not use a fork PR body for preview merges", () => {
    const content = renderNotification({
      ...notifyEnv,
      BASE_REF: "preview",
      HEAD_REPOSITORY: "someone/twica",
      PR_BODY: "## 概要\n\nfork からの本文",
    });

    expect(content).toContain(notifyEnv.PR_TITLE);
    expect(content).not.toContain("fork からの本文");
  });

  it("keeps the promotion-only failure marker for a promotion with no summary", () => {
    // The promotion contract must survive the preview-scope change: a
    // preview -> main promotion without a release summary still has to fall back
    // to the title and record PROMOTION_SUMMARY_MISSING for the post-delivery fail.
    const workDir = mkdtempSync(join(tmpdir(), "discord-notify-"));
    const envFile = join(workDir, "github_env");
    try {
      writeFileSync(envFile, "");
      const { stdout: content, stderr } = runNotification({
        ...notifyEnv,
        BASE_REF: "main",
        HEAD_REF: "preview",
        PR_BODY: "<!-- 要約なし -->",
        GITHUB_ENV: envFile,
      });

      expect(stderr).toContain("::warning::Promotion PR summary missing");
      expect(content).toContain(notifyEnv.PR_TITLE);
      expect(readFileSync(envFile, "utf8")).toContain(
        "PROMOTION_SUMMARY_MISSING=true"
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps preview notifications inside Discord's 2000 UTF-16 unit limit", () => {
    // GitHub caps PR titles far below the Discord limit, so this exercises the
    // shared trimming fail-safe rather than a reachable production input.
    const content = renderNotification({
      ...notifyEnv,
      BASE_REF: "preview",
      PR_TITLE: "あ".repeat(3000),
    });

    expect(utf16Length(content)).toBeLessThanOrEqual(2000);
    expect(content).toContain("🧪 **twica (preview) が更新されました**");
    expect(content).toContain("…");
  });
});
