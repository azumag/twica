import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function collectTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function findExecuteGachaCalls(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const calls: string[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "executeGacha"
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.expression.name.getStart(sourceFile));
      calls.push(`${relative(process.cwd(), path)}:${position.line + 1}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return calls;
}

describe("GachaService production entrypoints (#1301)", () => {
  it("does not call the low-level executeGacha method outside GachaService", () => {
    const srcRoot = resolve(process.cwd(), "src");
    const servicePath = resolve(srcRoot, "lib/services/gacha.ts");
    const directCallSites = collectTypeScriptFiles(srcRoot)
      .filter((path) => path !== servicePath)
      .flatMap(findExecuteGachaCalls);

    expect(directCallSites).toEqual([]);
  });
});
