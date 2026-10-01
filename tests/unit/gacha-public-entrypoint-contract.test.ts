import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Issue #1301 / #1723: GachaService の公開エントリポイント契約。
 *
 * ガチャは課金・付与のクリティカルパスなので、「反復抑制を必ず通る公開経路」と
 * 「テスト専用の低レベル経路」を混同すると、本番から無意識に反復抑制を迂回
 * できてしまう。本テストは次の4層を AST で固定する。
 *
 *   1. 本番コード(src)が呼べる executeGacha* は公開エントリポイントの白名单だけ
 *   2. 低レベル executeGachaWithoutRepeatProtection を呼べるのは
 *      executeGachaWithRepeatProtection と executeGachaDraws だけ
 *   3. executeGachaDraws を呼べるのは
 *      executeGachaForEventSub と executeGachaForRaidEvent だけ
 *   4. executeGacha* を .call/.apply/.bind 経由、または識別子の単体参照
 *      (エイリアス代入・分割代入) で取得しない(#1723)
 *
 * 2/3 を満たす経路だけが反復抑制(直前カードの取得、Issue #1296)を必ず通る。
 * 4 は 1〜3 の検査が「呼び出し」という1形態しか見ていないことで生じる抜け道を
 * 塞ぐ層で、メソッドへの参照を取得しただけで実行できる形をすべて
 * 違反として扱う。
 *
 * メンバーキーの照合はドット記法と文字列リテラルのブラケット記法の両方を
 * 吸収する。両者は AST 上の格納先が別(Identifier.name / StringLiteral)なので、
 * 一方だけを見ると `svc['executeGachaX'](...)` の書き方ひとつで検査をすり抜ける。
 * 同リポジトリの eslint.config.mjs にある XSS シンク規則(memberKey)と同じ考え方。
 * コメント・文字列中の同名トークンでは誤検知しない。
 *
 * 単体テストが低レベル経路を直接呼ぶことは禁止しない(RPC bind 値・
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

/**
 * メソッドを「this を詰め替えずに」呼ぶためのアクセサ。
 * `f.call(f, args)` / `f.apply(f, args)` / `const g = f.bind(f)` は、
 * 呼び出し点として現れないため 1〜3 の「呼び出し」検出を素通りする。
 * 取得の形態そのものを違反として扱う。
 */
const INDIRECT_INVOKERS = new Set(["call", "apply", "bind"]);

/** executeGacha* メソッドの参照がどの形態で現れたか。 */
type MemberUseKind =
  /** `x.m(...)` / `x['m'](...)` の直接呼び出し。 */
  | "direct-call"
  /** `x.m.call(...)` / `x.m.apply(...)` / `x.m.bind(...)` 経由。 */
  | "indirect-call"
  /** 呼び出し以外の全参照(代入・分割代入・戻り値・引数など)。 */
  | "reference";

interface MemberUse {
  file: string;
  line: number;
  name: string;
  kind: MemberUseKind;
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
  return parseSource(path, readFileSync(path, "utf8"));
}

/**
 * 実ファイルだけでなく検査用の文字列も同一の走査に載せるために、
 * 「fileName + ソース文字列」から SourceFile を作る1箇所へ集約する。
 */
function parseSource(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function indexParents(sourceFile: ts.SourceFile): Map<ts.Node, ts.Node> {
  const parents = new Map<ts.Node, ts.Node>();
  (function index(node: ts.Node) {
    ts.forEachChild(node, (child) => {
      parents.set(child, node);
      index(child);
    });
  })(sourceFile);
  return parents;
}

/**
 * `x.foo` / `x['foo']` からメンバーキーを取り出す。
 * ドット記法と文字列リテラルのブラケット記法は AST 上の格納先が別なので、両方を
 * 吸収しないと書き方ひとつで検査をすり抜ける。動的添字(`x[key]`)は特定できない
 * ため対象外とする(検出できるのは静的キーのみ)。
 */
function memberKey(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

/** `const { executeGachaFoo: alias } = x` の分割代入から元メソッド名を取り出す。 */
function bindingPropertyKey(node: ts.BindingElement): string | null {
  const target = node.propertyName ?? node.name;
  if (ts.isIdentifier(target) || ts.isStringLiteralLike(target)) return target.text;
  return null;
}

/**
 * 対象メソッド名の「参照」を全件集め、どう参照されたかを分類する。
 *
 * 分類は親ノードだけから判定するため、呼び出しとして現れない書き方
 * (.call/.apply/.bind 経由、エイリアス代入、分割代入)も missing なく拾える。
 */
function collectMemberUses(
  sourceFile: ts.SourceFile,
  file: string,
  matches: (name: string) => boolean,
): MemberUse[] {
  const parents = indexParents(sourceFile);
  const uses: MemberUse[] = [];

  const record = (node: ts.Node, name: string) => {
    const parent = parents.get(node);
    let kind: MemberUseKind;
    if (parent && ts.isCallExpression(parent) && parent.expression === node) {
      kind = "direct-call";
    } else if (
      parent &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      INDIRECT_INVOKERS.has(parent.name.text)
    ) {
      kind = "indirect-call";
    } else {
      kind = "reference";
    }
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    uses.push({ file, line: pos.line + 1, name, kind });
  };

  function visit(node: ts.Node) {
    const key = memberKey(node);
    if (key !== null && matches(key)) record(node, key);
    if (ts.isBindingElement(node)) {
      const bindingKey = bindingPropertyKey(node);
      if (bindingKey !== null && matches(bindingKey)) record(node, bindingKey);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return uses;
}

/** `x.executeGacha*(...)` / `x['executeGacha*'](...)` 形式の直接呼び出しを列挙する。 */
function findPrefixedCalls(sourceFile: ts.SourceFile, file: string, prefixes: readonly string[]): MemberUse[] {
  return collectMemberUses(
    sourceFile,
    file,
    (name) => prefixes.some((prefix) => name.startsWith(prefix)),
  ).filter((use) => use.kind === "direct-call");
}

/**
 * `<任意のレシーバ>.<callee>(...)` の直接呼び出しを、直近のメソッド定義
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
  sourceFile: ts.SourceFile,
  callees: readonly string[],
): Array<{ caller: string | null; callee: string }> {
  const parents = indexParents(sourceFile);
  const results: Array<{ caller: string | null; callee: string }> = [];

  function visit(node: ts.Node) {
    const name = memberKey(node);
    if (name !== null && callees.includes(name)) {
      const call = parents.get(node);
      if (call && ts.isCallExpression(call) && call.expression === node) {
        let current: ts.Node | undefined = node;
        let caller: string | null = null;
        while (current) {
          if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
            caller = current.name.text;
            break;
          }
          current = parents.get(current);
        }
        results.push({ caller, callee: name });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

describe("GachaService production entrypoints (#1301, #1723)", () => {
  const srcRoot = resolve(process.cwd(), "src");
  const servicePath = resolve(srcRoot, "lib/services/gacha.ts");

  it("本番コードが呼ぶ executeGacha* は公開エントリポイントの白名单だけである", () => {
    // サービス自身は内部構成のために自由に呼べるため除外する。
    const calls = collectTypeScriptFiles(srcRoot)
      .filter((path) => path !== servicePath)
      .flatMap((path) => {
        const file = relative(process.cwd(), path);
        return findPrefixedCalls(parseFile(path), file, ["executeGacha"]);
      });

    const unexpected = calls.filter(
      (call) => !(PUBLIC_ENTRYPOINTS as readonly string[]).includes(call.name),
    );

    expect(unexpected.map((call) => `${call.file}:${call.line} ${call.name}`)).toEqual([]);
    // 白名单が空だと検査が自明に通ってしまうため、少なくとも本番呼び出しを1件は
    // 見つかっていること(=テストが実際に動いていること)も固定する。
    expect(calls.length).toBeGreaterThan(0);
  });

  it("低レベル抽選は反復抑制つき単発とN連ループからのみ呼ばれる", () => {
    const calls = findInternalCalls(parseFile(servicePath), Object.keys(ALLOWED_LOW_LEVEL_CALLERS));
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
    // 実際に存在することも固定する。`some` で「許可呼び出し元のいずれか1件」だけを
    // 見ると 片方の許可呼び出し元だけ経路から外れても通ってしまうため、
    // 許可呼び出し元を1件ずつ確認する。
    for (const [method, allowedCallers] of Object.entries(ALLOWED_LOW_LEVEL_CALLERS)) {
      for (const caller of allowedCallers) {
        const found = calls.some((call) => call.callee === method && call.caller === caller);
        expect(found, `${method} が ${caller} から呼ばれること`).toBe(true);
      }
    }
  });

  it("本番コードが反復抑制を経由しない低レベル経路を直接呼ばない", () => {
    // 上記ホワイトリストとは独立に、禁止メソッドの直接呼び出しを明示的に数えると、
    // 白名单の更新漏れ(=新しい bypass 経路の追加)が別断言でも検出される。
    const calls = collectTypeScriptFiles(srcRoot)
      .filter((path) => path !== servicePath)
      .flatMap((path) => {
        const file = relative(process.cwd(), path);
        return findPrefixedCalls(parseFile(path), file, INTERNAL_ONLY_METHODS);
      });

    expect(calls.map((call) => `${call.file}:${call.line} ${call.name}`)).toEqual([]);
  });

  it("本番コードが executeGacha* を .call/.apply/.bind 経由や識別子の単体参照で取得しない", () => {
    // #1723: 上記3層は「呼び出し」しか見ていないため、`svc.executeGachaX.call(svc, …)` や
    // `const low = svc.executeGachaX` のような「メソッドapturedまま使う」書き方で
    // 素通りしていた。ここでは executeGacha* 参照のうち呼び出し以外のものを
    // すべて違反として数える(実行可能なら許可しない、という安全側判定)。
    const uses = collectTypeScriptFiles(srcRoot)
      .filter((path) => path !== servicePath)
      .flatMap((path) => {
        const file = relative(process.cwd(), path);
        return collectMemberUses(parseFile(path), file, (name) => name.startsWith("executeGacha"));
      })
      .filter((use) => use.kind !== "direct-call");

    expect(
      uses.map((use) => `${use.file}:${use.line} ${use.name} (${use.kind})`),
    ).toEqual([]);
  });
});

describe("契約テスト自身の検出能力 (#1723)", () => {
  /**
   * 「違反を混ぜたソース」で走査が実際に違反を見つけることを固定する。
   * これがないとDetector の実装が退化しても本番コードを走査するテストだけが残り、
   * 「検査が空振りしない」ことが誰にも保証されなくなる。
   */
  const bypassFixture = `
    const low = service.executeGachaWithoutRepeatProtection; // reference
    const { executeGachaDraws: drawAlias } = service;         // reference (分割代入)
    const bracketed = service['executeGachaDraws'];            // reference (ブラケット記法)
    service.executeGachaWithoutRepeatProtection.call(service, args);  // indirect-call
    service.executeGachaDraws.apply(service, args);                  // indirect-call
    const bound = service.executeGachaDraws.bind(service);            // indirect-call
    // executeGachaDraws はコメント中の同名トークンなので誤検知しない
    const message = "executeGachaWithoutRepeatProtection";
  `;

  it(".call/.apply/.bind 経由と識別子の単体参照を迂回として検出する", () => {
    const uses = collectMemberUses(parseSource("<fixture>.ts", bypassFixture), "<fixture>", (name) =>
      name.startsWith("executeGacha"),
    );

    expect(uses.map((use) => `${use.name}:${use.kind}`).sort()).toEqual(
      [
        "executeGachaDraws:indirect-call",
        "executeGachaDraws:indirect-call",
        "executeGachaDraws:reference",
        "executeGachaDraws:reference",
        "executeGachaWithoutRepeatProtection:indirect-call",
        "executeGachaWithoutRepeatProtection:reference",
      ].sort(),
    );
    // 直接呼び出しでないものが1件も見つからないと、このテスト自体が空振りする。
    expect(uses.every((use) => use.kind !== "direct-call")).toBe(true);
  });

  it("直接呼び出しは迂回として数えない(誤検知の否定例)", () => {
    const fixture = `
      await service.executeGachaForEventSub({ event, eventId });
      await service['executeGachaWithRepeatProtection'](params);
    `;
    const uses = collectMemberUses(parseSource("<fixture>.ts", fixture), "<fixture>", (name) =>
      name.startsWith("executeGacha"),
    );

    expect(uses.map((use) => `${use.name}:${use.kind}`).sort()).toEqual([
      "executeGachaForEventSub:direct-call",
      "executeGachaWithRepeatProtection:direct-call",
    ]);
  });

  it("コメントと文字列リテラルの同名トークンは誤検知しない", () => {
    const fixture = `
      // executeGachaWithoutRepeatProtection を直接呼んではいけない
      const label = "executeGachaDraws";
      const object = { executeGachaWithRepeatProtection: vi.fn() };
      export { label, object };
    `;
    const uses = collectMemberUses(parseSource("<fixture>.ts", fixture), "<fixture>", (name) =>
      name.startsWith("executeGacha"),
    );

    expect(uses).toEqual([]);
  });
});
