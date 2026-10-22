import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const config = readFileSync(join(root, "wrangler.toml"), "utf8");
function section(name: string): string {
  const header = `[${name}]`;
  const start = config.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  return config.slice(start + header.length).split(/^\[/m)[0];
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isCommentOrBlank = (line: string) => line.trim() === "" || line.trimStart().startsWith("#");

// workflow の「キー行より深いインデントが続く範囲」を切り出す。YAML パーサを
// 新規依存に加えず、対象ブロックの要素だけを確認するための最小限の読み取り。
function blockBelow(lines: string[], keyLineIndex: number): string[] {
  const keyIndent = indentOf(lines[keyLineIndex]);
  const body: string[] = [];
  for (const line of lines.slice(keyLineIndex + 1)) {
    if (isCommentOrBlank(line)) continue;
    if (indentOf(line) <= keyIndent) break;
    body.push(line);
  }
  return body;
}

// 「- 'value'」形式のシーケンス項目から値だけを取り出す。並び順には依存しない。
function sequenceValues(block: string[]): string[] {
  return block.flatMap((line) => {
    const match = line.trim().match(/^-\s+(?:'([^']*)'|"([^"]*)"|(\S+))\s*(?:#.*)?$/);
    return match ? [match[1] ?? match[2] ?? match[3]] : [];
  });
}

// 「5.20261022.1」のような workers-types 版を [major, minor, patch] に分解する。
// semver パッケージに依存せず、pin 同士の大小比較だけを行うための最小限の実装。
function versionTuple(version: string): [number, number, number] {
  const parts = version.trim().split(".").map((part) => Number.parseInt(part, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
function compareVersions(left: string, right: string): number {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// dorny/paths-filter の `filters:` ブロックから、指定グループの path 一覧を読む。
function filterGroup(workflow: string, group: string): string[] {
  const lines = workflow.split("\n");
  const filtersLine = lines.findIndex((line) => /^\s*filters:\s*\|\s*$/.test(line));
  expect(filtersLine, "paths-filter の filters 定義が無い").toBeGreaterThanOrEqual(0);
  const block = blockBelow(lines, filtersLine);
  const groupLine = block.findIndex((line) => line.trim() === `${group}:`);
  expect(groupLine, `${group} filter が無い`).toBeGreaterThanOrEqual(0);
  const groupIndent = indentOf(block[groupLine]);
  const entries: string[] = [];
  for (const line of block.slice(groupLine + 1)) {
    if (indentOf(line) <= groupIndent) break;
    entries.push(line);
  }
  return sequenceValues(entries);
}

// planetscale-migrate.yml の `on.push.paths` を読む。
function pushPaths(workflow: string): string[] {
  const lines = workflow.split("\n");
  const pushLine = lines.findIndex((line) => /^ {2}push:\s*$/.test(line));
  expect(pushLine, "on.push が無い").toBeGreaterThanOrEqual(0);
  const pushIndent = indentOf(lines[pushLine]);
  const pathsLine = lines.findIndex(
    (line, index) => index > pushLine && indentOf(line) === pushIndent + 2 && line.trim() === "paths:",
  );
  expect(pathsLine, "on.push.paths が無い").toBeGreaterThanOrEqual(0);
  return sequenceValues(blockBelow(lines, pathsLine));
}

describe("Workers Issues deployment contract", () => {
  it("preserves error monitoring across both regular deployment targets", () => {
    for (const scope of ["observability.issues", "env.preview.observability.issues"]) {
      expect(section(scope)).toMatch(/^enabled\s*=\s*true\s*$/m);
    }
  });
  // wrangler 4.150.0 is the pin chosen to satisfy @opennextjs/cloudflare@1.20.12's
  // `wrangler ^4.148.0` peer (required for Next.js 16.4) while staying
  // >= 4.134.0 (Workers Issues). See scripts/smoke-opennext-worker.sh for the
  // runtime check that guards the Next.js / OpenNext pairing.
  // @cloudflare/workers-types is a peerOptional of every wrangler 4.148+ and its
  // range moves with the CLI line, so the pin has to move together with it:
  // 4.150.0 declares ^5.20261006.1 while 4.151.x declares ^5.20261019.1. Leaving
  // the old pin while the lockfile resolves a newer CLI makes `npm ci` fail with
  // ERESOLVE, so a lockfile regeneration is verified together with the pair.
  // 2026-10-22: raised to 5.20261022.1 after a push regenerated the lockfile
  // against wrangler 4.151.3 and left this pin stale (Refs #1899). The pin stays
  // fully specified (no range) so the pair is always reproducible.
  it("pins a CLI and compatible types that understand the Issues configuration", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const pinnedWrangler = pkg.devDependencies.wrangler;
    expect(lock.packages["node_modules/wrangler"].version).toBe(pinnedWrangler);
    const pinnedTypes = pkg.devDependencies["@cloudflare/workers-types"];
    expect(lock.packages["node_modules/@cloudflare/workers-types"].version).toBe(pinnedTypes);
    // wrangler 4.148+ requires workers-types >= 4; the pin must be at least what
    // the resolved CLI line declares, otherwise `npm ci` breaks with ERESOLVE.
    const minTypes =
      pkg.devDependencies.wrangler === "4.150.0" ? "5.20261006.1" : "5.20261019.1";
    expect(compareVersions(pinnedTypes, minTypes) >= 0).toBe(true);
  });
  it("pins build/CI Node.js to one fully-specified 22.x patch >= 22.23.4", () => {
    // 2026-10-21 の Node.js security release では 22.23.4 が修正版（CVE-2026-106069 の
    // TLS hostname bypass など High 複数を含む。Refs #1914）。ビルド・CI・migration
    // runner の Node 指定は `.node-version` 1 ファイルに正本化している（#1919 で
    // 追跡していた CI 用ピンとの一本化）。
    //
    // 完全指定（major.minor.patch）でなければならない理由:
    // - メジャー（"22"）だけだと actions/setup-node は runner のツールキャッシュにある
    //   旧パッチ（22.23.3）を選び、Cloudflare Workers Builds も自身の把握する 22 系最新
    //   （2026-10-21 時点は 22.23.3）に解決する。いずれも修正版未満のため脆弱性が残る。
    // - 2026-10-21 は完全指定 22.23.4 で Workers Builds のインストールが失敗したため
    //   （build f2aaabd8 / 2a8c9d68 / 6a27ed21）、一時的に CI 用ピンを
    //   `.github/ci-node-version` へ分離していた。#1914 の完了条件は Workers Builds でも
    //   修正版を使うことなので、分離を解消して単一ピンへ戻した。このファイル自体が
    //   setup-node / Workers Builds に版として読まれるため、コメント行は入れられない。
    //
    // 下限（22.23.4 以上）を設けるのは、将来の巻き戻しや誤った downgrade で脆弱な版へ
    // 戻ることを防ぐため。比較は文字列ではなく数値で行う（22.23.10 > 22.23.4）。
    const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim();
    expect(nodeVersion).toMatch(/^22\.\d+\.\d+$/);
    const parse = (v: string) => v.split(".").map(Number);
    const atLeast = (actual: string, minimum: string) => {
      const a = parse(actual);
      const m = parse(minimum);
      for (let i = 0; i < m.length; i++) {
        if (a[i] !== m[i]) return a[i] > m[i];
      }
      return true;
    };
    expect(atLeast(nodeVersion, "22.23.4")).toBe(true);

    // 一時的な CI 用ピン（`.github/ci-node-version`）は廃止済み。残ったまま act して
    // いないと「どちらが正本か」が再び不明になるため、存在しないことを固定する。
    // Workers Builds が再び完全指定に対応できなくなった場合は、このテスト・docs・
    // workflow filter を同時に戻す形で分離を再導入する（手順は docs/cloudflare-workers-builds.md）。
    expect(existsSync(join(root, ".github/ci-node-version"))).toBe(false);

    // actions/setup-node を使う workflow は例外なく `.node-version` を参照し、
    // node-version の直書き（EOL の Node 20 など）を持たないこと。
    // 新しい workflow が追加されても漏れないよう、ファイル一覧は動的に取得する。
    const workflowDir = join(root, ".github/workflows");
    const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      const text = readFileSync(join(workflowDir, workflow), "utf8");
      if (!text.includes("actions/setup-node")) continue;
      expect(text, `${workflow} must use node-version-file`).toContain(
        "node-version-file: .node-version",
      );
      expect(text, `${workflow} must not hardcode node-version`).not.toMatch(/^\s*node-version:/m);
    }
  });
  it("runs CI and the migration runner when only the Node pin changes", () => {
    // #1917: セキュリティリリースで Node の固定版だけを上げる PR でも、新しい Node で
    // test / workers:build / analysis build / 実PG検証 / migration runner を実際に
    // 動かす必要がある。setup-node が読む唯一のピンは `.node-version` なので、これが
    // app / analysis / postgres_fixtures と on.push.paths の要素であることを固定する。
    // 対象が「要素」として存在することだけを確認し、並び順や他の filter との重複には
    // 依存しない。
    const nodePin = ".node-version";
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const migrate = readFileSync(join(root, ".github/workflows/planetscale-migrate.yml"), "utf8");

    // test / supabase-shutdown-build（workers:build）/ lint は
    // `needs.changes.outputs.app` でゲートされる。app filter から外れると、Node だけを
    // 上げる PR で新しい Node が一度も実行されない。
    expect(filterGroup(ci, "app")).toContain(nodePin);

    // analysis job も setup-node で同じピンを読むため、analysis build も新 Node で回す。
    expect(filterGroup(ci, "analysis")).toContain(nodePin);

    // postgres_fixtures は PG17 / integration job を独立にゲートする。既存の対応が
    // 将来の整理で落ちると、Node を上げても実PG検証だけが skip される。
    expect(filterGroup(ci, "postgres_fixtures")).toContain(nodePin);

    // migration runner も setup-node で同じピンを読む。push の paths に無いと、次の
    // migration まで新しい Node で実行されない。apply は pending migration が無ければ
    // no-op（verify のみ）のため、Node 変更時の起動が実DBへ無関係な変更を適用することはない。
    expect(pushPaths(migrate)).toContain(nodePin);
  });
  it("does not enable separately billed tracing or change the runtime date", () => {
    expect(config).not.toMatch(/^\[(?:env\.preview\.)?observability\.traces\]/m);
    expect(config).toMatch(/^compatibility_date\s*=\s*"2024-09-23"$/m);
  });
});
