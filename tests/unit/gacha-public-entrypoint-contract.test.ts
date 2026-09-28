import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Issue #1301: GachaService の公開エントリポイント契約。
 *
 * ガチャは課金・付与のクリティカルパスなので、「反復抑制を必ず通る公開経路」と
 * 「テスト専用の低レベル経路」を混同すると、本番から無意識に反復抑制を迂回
 * できてしまう。本テストは次の3層を AST で固定する。
 *
 *   1. 本番コード(src)が呼べる executeGacha* は公開エントリポイントの白名单だけ
 *   2. 低レベル executeGachaWithoutRepeatProtection を呼べるのは
 *      executeGachaWithRepeatProtection と executeGachaDraws だけ
 *   3. executeGachaDraws を呼べるのは
 *      executeGachaForEventSub と executeGachaForRaidEvent だけ
 *
 * 2/3 を満たす経路だけが反復抑制(直前カードの取得、Issue #1296)を必ず通る。
 *
 * AST の PropertyAccess 名で照合するため、コメント・文字列中の同名トークンでは
 * 誤検知しない。単体テストが低レベル経路を直接呼ぶことは禁止しない(RPC bind 値・
 * duplicate/limit_reached/soldOut の安全側分岐は低レベルのまま検証するのが正本)。
 */

/** 本番コードから呼んでよい公開エントリポイント。いずれも反復抑制を通る。 */
const PUBLIC_ENTRYPOINTS = [
  "executeGachaWithRepeatProtection",
  "executeGachaForEventSub",
  "executeGachaForRaidEvent",
] as const;

/** 反復抑制を経由しない経路。本番コード(src)から呼んではならない。 */
const INTERNAL_ONLY_METHODS = [
  "executeGachaWithoutRepeatProtection",
  "executeGachaDraws",
] as const;

/** 低レベル抽選を呼んでよい方法(GachaService 内部)。 */
const ALLOWED_LOW_LEVEL_CALLERS: Record<string, readonly string[]> = {
  executeGachaWithoutRepeatProtection: [
    "executeGachaWithRepeatProtection",
    "executeGachaDraws",
  ],
  executeGachaDraws: ["executeGachaForEventSub", "executeGachaForRaidEvent"],
};

interface CallSite {
  file: string;
  line: number;
  name: string;
}

function collectTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function parseFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** `X.executeGacha*(...)` 形式の呼び出しを、対象プレフィックスだけ収集する。 */
function findPrefixedCalls(path: string, prefixes: readonly string[]): CallSite[] {
  const sourceFile = parseFile(path);
  const calls: CallSite[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name
    ) {
      const name = node.expression.name.text;
      if (prefixes.some((prefix) => name.startsWith(prefix))) {
        const pos = sourceFile.getLineAndCharacterOfPosition(
          node.expression.name.getStart(sourceFile),
        );
        calls.push({ file: relative(process.cwd(), path), line: pos.line + 1, name });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return calls;
}

/**
 * `<任意のレシーバ>.<callee>(...)` を含む呼び出しを、直近のメソッド定義
 * (=呼び出し元)へ紐付けて列挙する。
 *
 * - 「メソッド単位で走査して呼び出し先を集める」実装だと、メソッドの外
 *   (モジュールレベルのヘルパ、クラス属性の矢印関数など)からの呼び出しが
 *   グラフから抜け落ち、検査がすり抜ける。そこで親ノードを辿って呼び出し元を
 *   その場で解決し、呼び出し元が取得できないケース(null)も違反として扱う。
 * - `this.` に限定しないのは、gacha.ts 内で別の GachaService インスタンス経由
 *   (`svc.executeGacha*`) のようにレシーバを変えての迂回を塞ぐため。
 *   テスト1が gacha.ts 自身を対象外にしており、ここが唯一の検知経路になる。
 */
function findInternalCalls(
  path: string,
  callees: readonly string[],
): Array<{ caller: string | null; callee: string }> {
  const sourceFile = parseFile(path);
  const parents = new Map<ts.Node, ts.Node>();
  (function index(node: ts.Node) {
    ts.forEachChild(node, (child) => {
      parents.set(child, node);
      index(child);
    });
  })(sourceFile);

  const results: Array<{ caller: string | null; callee: string }> = [];

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      callees.includes(node.expression.name.text)
    ) {
      let current: ts.Node | undefined = node;
      let caller: string | null = null;
      while (current) {
        if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
          caller = current.name.text;
          break;
        }
        current = parents.get(current);
      }
      results.push({ caller, callee: node.expression.name.text });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

describe("GachaService production entrypoints (#1301)", () => {
  const srcRoot = resolve(process.cwd(), "src");
  const servicePath = resolve(srcRoot, "lib/services/gacha.ts");

  it("本番コードが呼ぶ executeGacha* は公開エントリポイントの白名单だけである", () => {
    // サービス自身は内部構成のために自由に呼べるため除外する。
    const calls = collectTypeScriptFiles(srcRoot)
      .filter((path) => path !== servicePath)
      .flatMap((path) => findPrefixedCalls(path, ["executeGacha"]));

    const unexpected = calls.filter(
      (call) =>
        !(PUBLIC_ENTRYPOINTS as readonly string[]).includes(call.name),
    );

    expect(
      unexpected.map((call) => `${call.file}:${call.line} ${call.name}`),
    ).toEqual([]);
    // 白名单が空だと検査が自明に通ってしまうため、少なくとも本番呼び出しを1件は
    // 見つかっていること(=テストが実際に動いていること)も固定する。
    expect(calls.length).toBeGreaterThan(0);
  });

  it("低レベル抽選は反復抑制つき単発とN連ループからのみ呼ばれる", () => {
    const calls = findInternalCalls(servicePath, Object.keys(ALLOWED_LOW_LEVEL_CALLERS));
    const violations: string[] = [];

    for (const { caller, callee } of calls) {
      const allowedCallers = ALLOWED_LOW_LEVEL_CALLERS[callee];
      // 呼び出し元がメソッドとして解決できない(=クラス外の文脈)のも違反にする。
      if (!caller || !allowedCallers.includes(caller)) {
        violations.push(`${caller ?? "<non-method>"} -> ${callee}`);
      }
    }

    expect(violations).toEqual([]);
    // 呼び出しが1件も見つからない(=対象メソッドの実在確認に失敗)と検査が
    // 自明に通ってしまうため、各低レベル経路について許可呼び出し元が
    // 実際に存在することも固定する。
    for (const [method, allowedCallers] of Object.entries(ALLOWED_LOW_LEVEL_CALLERS)) {
      const found = calls.some((call) => call.callee === method && allowedCallers.includes(call.caller ?? ""));
      expect(found, `${method} が許可された呼び出し元から呼ばれていること`).toBe(true);
    }
  });

  it("本番コードが反復抑制を経由しない低レベル経路を直接呼ばない", () => {
    // 上記ホワイトリストとは独立に、禁止メソッドの直接呼び出しを明示的に数えると、
    // 白名单の更新漏れ(=新しい bypass 経路の追加)が別断言でも検出される。
    const calls = collectTypeScriptFiles(srcRoot)
      .filter((path) => path !== servicePath)
      .flatMap((path) => findPrefixedCalls(path, INTERNAL_ONLY_METHODS));

    expect(calls.map((call) => `${call.file}:${call.line} ${call.name}`)).toEqual([]);
  });
});
