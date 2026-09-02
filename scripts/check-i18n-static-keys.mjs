import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Issue #1281 の静的 i18n ガード。
 *
 * next-intl の runtime lookup を全面的に再実装するのではなく、現在コードベースで多い
 * `const t = useTranslations("namespace")` + `t("literal.key")` だけを保守的に検査する。
 * 動的 namespace / 動的 key / `t.rich()` / server-side `getTranslations()` は意図的に
 * 対象外としており、false positive を避ける代わりに一部の false negative を許容する。
 * 対象拡張は Issue #1283 で別途追跡する。
 */
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(rootDir, "src");
const messageFiles = {
  en: path.join(rootDir, "messages", "en.json"),
  ja: path.join(rootDir, "messages", "ja.json"),
};

const messages = Object.fromEntries(
  await Promise.all(
    Object.entries(messageFiles).map(async ([locale, filename]) => [
      locale,
      JSON.parse(await fs.readFile(filename, "utf8")),
    ]),
  ),
);

async function collectSourceFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(filename);
      if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        return [filename];
      }
      return [];
    }),
  );
  return nested.flat().sort();
}

/**
 * Message catalog は通常の JSON object として扱うが、`constructor` 等の継承 property を
 * 翻訳キーと誤認しないよう各 segment を own-property として辿る。
 */
function hasMessage(root, namespace, key) {
  const parts = [...namespace.split("."), ...key.split(".")];
  let value = root;
  for (const part of parts) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.prototype.hasOwnProperty.call(value, part)
    ) {
      return false;
    }
    value = value[part];
  }
  return true;
}

function scriptKindFor(filename) {
  if (filename.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filename.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filename.endsWith(".js") || filename.endsWith(".mjs") || filename.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function stringLiteralValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function bindingNames(name, names = []) {
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return names;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  }
  return names;
}

/**
 * namespace が静的に確定する `useTranslations("...")` だけを追跡する。
 * 引数なし・変数引数・別 helper 経由は、誤った namespace を推測するより未検査に倒す。
 */
function translationNamespace(initializer) {
  if (!initializer || !ts.isCallExpression(initializer)) return null;
  if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== "useTranslations") {
    return null;
  }
  if (initializer.arguments.length !== 1) return null;
  return stringLiteralValue(initializer.arguments[0]);
}

function resolveBinding(scopes, name) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].has(name)) return scopes[index].get(name);
  }
  return null;
}

function inspectSource(filename, sourceText) {
  const sourceFile = ts.createSourceFile(
    filename,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filename),
  );
  const failures = [];

  function visit(node, scopes) {
    let activeScopes = scopes;

    /**
     * この walker は lexical shadowing を最低限再現するため、SourceFile / Block / function
     * ごとに Map を積む。完全な TypeScript binder を再実装する目的ではないため、for/catch
     * など細かな scope 境界は現時点では追跡しない（Issue #1283）。
     */
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      activeScopes = [...scopes, new Map()];
    } else if (ts.isFunctionLike(node)) {
      const functionScope = new Map();
      for (const parameter of node.parameters) {
        // 引数名が外側の翻訳関数と同じ場合は null で shadow し、誤検査を防ぐ。
        for (const name of bindingNames(parameter.name)) functionScope.set(name, null);
      }
      activeScopes = [...scopes, functionScope];
    }

    const currentScope = activeScopes[activeScopes.length - 1];

    if (ts.isVariableDeclaration(node) && currentScope) {
      const namespace = translationNamespace(node.initializer);
      for (const name of bindingNames(node.name)) {
        // 翻訳関数以外の同名変数も null で記録し、外側 binding を誤って参照しない。
        currentScope.set(name, ts.isIdentifier(node.name) ? namespace : null);
      }
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      currentScope
    ) {
      currentScope.set(node.name.text, null);
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length > 0) {
      const namespace = resolveBinding(activeScopes, node.expression.text);
      const key = stringLiteralValue(node.arguments[0]);
      if (namespace && key !== null) {
        for (const [locale, localeMessages] of Object.entries(messages)) {
          if (!hasMessage(localeMessages, namespace, key)) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            failures.push({
              fullKey: `${namespace}.${key}`,
              locale,
              location: `${path.relative(rootDir, filename)}:${line + 1}:${character + 1}`,
            });
          }
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, activeScopes));
  }

  visit(sourceFile, []);
  return failures;
}

const sourceFiles = await collectSourceFiles(srcDir);
const failures = [];
for (const filename of sourceFiles) {
  failures.push(...inspectSource(filename, await fs.readFile(filename, "utf8")));
}

if (failures.length > 0) {
  console.error("Static i18n key check failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure.location} ${failure.locale} missing ${failure.fullKey}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Static i18n key check passed (${sourceFiles.length} source files scanned).`);
}
