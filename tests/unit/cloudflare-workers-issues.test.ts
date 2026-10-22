import { readdirSync, readFileSync } from "node:fs";
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
  it("pins Node.js to a fully specified 22.x patch in the unified .node-version", () => {
    // 2026-10-21 の Node.js security release では 22.23.4 が修正版（Refs #1914）。
    // メジャー（"22"）だけだと actions/setup-node は runner のツールキャッシュにある
    // 旧パッチ（22.23.3）を選び、修正版が適用されないため、常に semver 完全指定とする。
    // このファイルは setup-node と Workers Builds が版として読むので、コメントは入れられない。
    //
    // 2026-10-21 時点では Cloudflare Workers Builds が完全指定（22.23.4）のインストールに
    // 失敗したため、CI 用ピン（.github/ci-node-version）と Workers Builds 用 .node-version
    // （メジャーのみ）を暫定的に別ファイルへ分けていた。2026-10-23 の preview build b3f09460 で
    // `Installing nodejs 22.23.4` が成功することを確認したため、単一の .node-version へ
    // 一本化した（Refs #1919）。
    //
    // 下限（22.23.4 以上）を設けるのは、将来の巻き戻しや誤った downgrade で
    // 脆弱な版へ戻ることを防ぐため。比較は文字列ではなく数値で行う（22.23.10 > 22.23.4）。
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
    // #1917: セキュリティリリースで Node の固定版だけを上げる PR / push でも、
    // 新しい Node で test / workers:build / analysis build / 実PG検証 / migration runner
    // を実際に動かす必要がある。#1919 の一本化で setup-node が読むのは .node-version
    // だけになったため、ci.yml の app / analysis / postgres_fixtures filter と
    // planetscale-migrate.yml の on.push.paths がすべてこれを含むことを固定する。
    // 対象が「要素」として存在することだけを確認し、並び順や他の filter との重複には
    // 依存しない。
    const nodePin = ".node-version";
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const migrate = readFileSync(join(root, ".github/workflows/planetscale-migrate.yml"), "utf8");

    // test / supabase-shutdown-build（workers:build）/ lint は
    // `needs.changes.outputs.app` でゲートされる。app filter から外れると、Node だけを
    // 上げる PR で新しい Node が一度も実行されない。
    expect(filterGroup(ci, "app")).toContain(nodePin);

    // analysis job も setup-node で同じ pin を読むため、analysis の typecheck / build も
    // 新 Node で回す。
    expect(filterGroup(ci, "analysis")).toContain(nodePin);

    // postgres_fixtures は PG17 / integration job を独立にゲートする。Node を上げる PR で
    // 実PG検証だけが skip されないよう含める。
    expect(filterGroup(ci, "postgres_fixtures")).toContain(nodePin);

    // migration runner も setup-node で .node-version を読む。push の paths に無いと、
    // 次の migration まで新しい Node で実行されない。
    expect(pushPaths(migrate)).toContain(nodePin);
  });
  it("does not enable separately billed tracing or change the runtime date", () => {
    expect(config).not.toMatch(/^\[(?:env\.preview\.)?observability\.traces\]/m);
    expect(config).toMatch(/^compatibility_date\s*=\s*"2024-09-23"$/m);
  });
});
