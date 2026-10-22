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
  it("pins CI Node.js to a fixed 22.x patch and keeps Workers Builds on the 22 major", () => {
    // 2026-10-21 の Node.js security release では 22.23.4 が修正版（Refs #1914）。
    // CI（GitHub Actions）は `.github/ci-node-version` で修正版へ完全固定する。メジャー（"22"）だけだと
    // actions/setup-node は runner のツールキャッシュにある旧パッチ（22.23.3）を選び、修正版が
    // 適用されないため。このファイルは setup-node が版として読むので、コメントは入れられない。
    //
    // 一方 Cloudflare Workers Builds は、完全指定の `.node-version`（22.23.4）では
    // `Installing nodejs 22.23.4` の直後に "Failed: error occurred while installing tools or
    // dependencies" となり全ビルドが失敗した（2026-10-21 実測。build f2aaabd8 / 2a8c9d68 / 6a27ed21。
    // 末尾改行の有無は無関係だった）。`.node-version` = `22` なら Workers Builds が自身の把握する
    // 22 系最新（同日時点は 22.23.3）に解決して成功する。
    // そこで CI 用ピンと Workers Builds 用 `.node-version` を暫定的に別ファイルへ分けている。
    // Workers Builds が 22.23.4 に対応した時点で一本化する（Refs #1914, #1919）。
    //
    // CI 側の下限（22.23.4 以上）を設けるのは、将来の巻き戻しや誤った downgrade で
    // 脆弱な版へ戻ることを防ぐため。比較は文字列ではなく数値で行う（22.23.10 > 22.23.4）。
    const ciVersion = readFileSync(join(root, ".github/ci-node-version"), "utf8").trim();
    expect(ciVersion).toMatch(/^22\.\d+\.\d+$/);
    const parse = (v: string) => v.split(".").map(Number);
    const atLeast = (actual: string, minimum: string) => {
      const a = parse(actual);
      const m = parse(minimum);
      for (let i = 0; i < m.length; i++) {
        if (a[i] !== m[i]) return a[i] > m[i];
      }
      return true;
    };
    expect(atLeast(ciVersion, "22.23.4")).toBe(true);

    // Workers Builds 用。完全指定にするとインストールに失敗するため、暫定でメジャーのみ（#1919 で一本化）。
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toBe("22");

    // actions/setup-node を使う workflow は例外なく `.github/ci-node-version` を参照し、
    // node-version の直書き（EOL の Node 20 など）を持たないこと。
    // 新しい workflow が追加されても漏れないよう、ファイル一覧は動的に取得する。
    const workflowDir = join(root, ".github/workflows");
    const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      const text = readFileSync(join(workflowDir, workflow), "utf8");
      if (!text.includes("actions/setup-node")) continue;
      expect(text, `${workflow} must use node-version-file`).toContain(
        "node-version-file: .github/ci-node-version",
      );
      expect(text, `${workflow} must not hardcode node-version`).not.toMatch(/^\s*node-version:/m);
    }
  });
  it("runs CI and the migration runner when only the Node pin changes", () => {
    // #1917: セキュリティリリースで Node の固定版だけを上げる PR でも、新しい Node で
    // test / workers:build / migration runner を実際に動かす必要がある。
    // setup-node が読み runner も使うのは `.github/ci-node-version` なので、これが
    // app / analysis / postgres_fixtures と on.push.paths の要素であることを固定する。
    // `.node-version` は Workers Builds 専用で CI の Node を変えないが、値と filter の
    // 対応を守るため app 側には含める。一方 migration runner は読まないので push paths
    // には含めない（含めると無関係な push で本番DBへ接続する）。
    // 対象が「要素」として存在することだけを確認し、並び順や他の filter との重複には
    // 依存しない。
    const ciPin = ".github/ci-node-version";
    const workersBuildsPin = ".node-version";
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const migrate = readFileSync(join(root, ".github/workflows/planetscale-migrate.yml"), "utf8");

    // test / supabase-shutdown-build（workers:build）/ lint は
    // `needs.changes.outputs.app` でゲートされる。app filter から外れると、Node だけを
    // 上げる PR で新しい Node が一度も実行されない。
    expect(filterGroup(ci, "app")).toEqual(
      expect.arrayContaining([ciPin, workersBuildsPin]),
    );

    // analysis job も setup-node で同じ pin を読むため、analysis build も新 Node で回す。
    // こちらは契約テストを実行しないので `.node-version` は含めない。
    const analysis = filterGroup(ci, "analysis");
    expect(analysis).toContain(ciPin);
    expect(analysis).not.toContain(workersBuildsPin);

    // postgres_fixtures は PG17 / integration job を独立にゲートする。既存の対応が
    // 将来の整理で落ちると、Node を上げても実PG検証だけが skip される。
    expect(filterGroup(ci, "postgres_fixtures")).toEqual(
      expect.arrayContaining([ciPin, workersBuildsPin]),
    );

    // migration runner は push の paths に無いと、次の migration まで新しい Node で
    // 実行されない。
    expect(pushPaths(migrate)).toContain(ciPin);
    // `.node-version` は runner が読まない。含めると本番 Environment の実DBへ無関係な
    // 接続と pending migration の適用を招くため、意図的に含めていないことを固定する。
    expect(pushPaths(migrate)).not.toContain(workersBuildsPin);
  });
  it("does not enable separately billed tracing or change the runtime date", () => {
    expect(config).not.toMatch(/^\[(?:env\.preview\.)?observability\.traces\]/m);
    expect(config).toMatch(/^compatibility_date\s*=\s*"2024-09-23"$/m);
  });
});
