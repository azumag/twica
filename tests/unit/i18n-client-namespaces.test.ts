import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  COLLECTION_CLIENT_NAMESPACES,
  DASHBOARD_CLIENT_NAMESPACES,
  LIVE_CLIENT_NAMESPACES,
  OVERLAY_CLIENT_NAMESPACES,
  pick,
  ROOT_CLIENT_NAMESPACES,
  TOS_CLIENT_NAMESPACES,
  TRADE_CLIENT_NAMESPACES,
} from "@/i18n/client-namespaces";

/**
 * Static guard for the split client-message lists (src/i18n/client-namespaces.ts).
 *
 * The lists are only useful if every nested provider is self-sufficient: next-intl
 * REPLACES the parent messages when a nested provider receives `messages`, so a
 * namespace that exists in the root list but not in the dashboard list is missing
 * at runtime. This test derives the requirement from source instead of trusting a
 * hand-written inventory:
 *
 * 1. Start from every route file in a provider's segment (page/layout/loading/
 *    error/not-found/template/default; API route handlers are excluded because
 *    they never render client components).
 * 2. Walk relative imports, tsconfig path aliases and literal dynamic import()/
 *    require() calls. Module resolution goes through the TypeScript compiler API,
 *    so the exact `@/components/ChatAnnouncementSettings` alias in tsconfig.json
 *    is followed to ChatAnnouncementSettingsWithDelivery.tsx (without this, the
 *    graph misses MultiDrawChatDeliverySettings and `multiDrawChatDelivery`).
 * 3. Collect literal `useTranslations("...")` namespaces only from files with a
 *    `"use client"` directive, and require their top-level namespace to be in the
 *    provider's list. The top-level entry is enough because `settingsPage.advanced`
 *    lives inside the `settingsPage` object picked as a whole.
 * 4. Fail on `useTranslations()` with no argument or a non-literal argument:
 *    silently skipping it would make this guard unsound exactly where a namespace
 *    is hardest to verify.
 * 5. Fail if a list contains a namespace absent from the merged catalogs
 *    (messages/<locale>.json plus messages/features/<feature>/<locale>.json,
 *    mirroring src/i18n/request.ts).
 *
 * Only the graph result is asserted; expected namespaces are not duplicated here.
 */

const repoRoot = process.cwd();
const srcDir = path.join(repoRoot, "src");
const appDir = path.join(srcDir, "app");

// Parse the real tsconfig so `.tsx` extensions, `moduleResolution: bundler` and
// the two `paths` entries (exact alias first, then `@/*`) behave like Next.js.
const tsconfig = ts.readConfigFile(path.join(repoRoot, "tsconfig.json"), ts.sys.readFile);
if (tsconfig.error) {
  throw new Error(ts.formatDiagnostics([tsconfig.error], {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => "\n",
  }));
}
const parsedTsconfig = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, repoRoot);
if (parsedTsconfig.errors.length > 0) {
  throw new Error(ts.formatDiagnostics(parsedTsconfig.errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => "\n",
  }));
}
const compilerOptions = parsedTsconfig.options;

const ROUTE_FILE_PATTERN =
  /^(?:page|layout|loading|error|not-found|global-error|template|default)\.(?:tsx|ts|jsx|js|mts|cts)$/;
const SOURCE_FILE_PATTERN = /\.(?:tsx|ts|jsx|js|mts|cts)$/;
// Top-level route segments that own a NextIntlClientProvider. The root provider
// must not be asked to cover their client components: a nested provider replaces
// the root messages, so those components never read the root list.
const NESTED_PROVIDER_SEGMENTS = new Set([
  "dashboard",
  "collection",
  "trade",
  "live",
  "tos",
  "overlay",
]);

interface UseTranslationsCall {
  namespace: string;
  file: string;
  line: number;
  column: number;
}

interface UnsoundCall {
  file: string;
  line: number;
  column: number;
  reason: string;
}

interface ModuleInfo {
  isClient: boolean;
  dependencies: string[];
  calls: UseTranslationsCall[];
  unsoundCalls: UnsoundCall[];
}

interface ProviderSite {
  name: string;
  entries: string[];
  namespaces: readonly string[];
}

const moduleInfoCache = new Map<string, ModuleInfo>();

function scriptKindFor(filename: string): ts.ScriptKind {
  if (filename.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filename.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(filename)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * A `"use client"` directive is only a directive at the start of the file.
 * Comments are not statements in the TypeScript AST, so this accepts the usual
 * comment banner followed by `'use client';` without a fragile text regex.
 */
function hasUseClientDirective(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) {
      if (statement.expression.text === "use client") return true;
      // Other directive prologue entries ("use strict", etc.) may precede it.
      continue;
    }
    break;
  }
  return false;
}

/**
 * Track the local name of `useTranslations` imports (including aliases) so the
 * scan does not treat an unrelated local function with the same name as the hook.
 * Namespace imports are tracked too, for `nextIntl.useTranslations("...")`.
 */
function collectUseTranslationsImports(sourceFile: ts.SourceFile): {
  namedBindings: Set<string>;
  namespaceBindings: Set<string>;
} {
  const namedBindings = new Set<string>();
  const namespaceBindings = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "next-intl") continue;
    if (!statement.importClause || statement.importClause.isTypeOnly) continue;

    const bindings = statement.importClause.namedBindings;
    if (!bindings) continue;

    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === "useTranslations") namedBindings.add(element.name.text);
      }
    } else if (ts.isNamespaceImport(bindings)) {
      namespaceBindings.add(bindings.name.text);
    }
  }

  return { namedBindings, namespaceBindings };
}

function isUseTranslationsCallee(
  callee: ts.Expression,
  imports: { namedBindings: Set<string>; namespaceBindings: Set<string> },
): boolean {
  if (ts.isIdentifier(callee)) {
    // The literal name is accepted as well so a missed/re-exported import still
    // fails loudly instead of silently dropping a namespace from the graph.
    return callee.text === "useTranslations" || imports.namedBindings.has(callee.text);
  }

  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "useTranslations" &&
    ts.isIdentifier(callee.expression) &&
    imports.namespaceBindings.has(callee.expression.text)
  );
}

function staticString(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * Collect every literal module specifier in the file:
 * - static imports / re-exports (type-only imports are erased by the compiler)
 * - dynamic `import("...")` (the dashboard lazy-loads SettingsLayout panels this way)
 * - CommonJS `require("...")` for completeness
 */
function collectDependencies(sourceFile: ts.SourceFile): string[] {
  const dependencies = new Set<string>();

  function add(specifier: ts.Node | undefined) {
    const value = staticString(specifier);
    if (value !== null) dependencies.add(value);
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause?.isTypeOnly) add(statement.moduleSpecifier);
    } else if (ts.isExportDeclaration(statement)) {
      if (!statement.isTypeOnly) add(statement.moduleSpecifier);
    }
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0]);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...dependencies];
}

/**
 * Resolve a specifier exactly as TypeScript (and therefore Next.js) would.
 * Results outside src/ are intentionally ignored: following node_modules would
 * scan third-party code and could pick up unrelated `useTranslations` calls.
 */
function resolveSourceModule(specifier: string, containingFile: string): string | null {
  const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys)
    .resolvedModule;
  if (!resolved) return null;

  const filename = path.resolve(resolved.resolvedFileName);
  if (!filename.startsWith(srcDir + path.sep)) return null;
  if (filename.endsWith(".d.ts") || !SOURCE_FILE_PATTERN.test(filename)) return null;
  return filename;
}

function getModuleInfo(filename: string): ModuleInfo {
  const cached = moduleInfoCache.get(filename);
  if (cached) return cached;

  const sourceText = readFileSync(filename, "utf8");
  const sourceFile = ts.createSourceFile(
    filename,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filename),
  );
  const imports = collectUseTranslationsImports(sourceFile);
  const calls: UseTranslationsCall[] = [];
  const unsoundCalls: UnsoundCall[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && isUseTranslationsCallee(node.expression, imports)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      const location = { file: filename, line: line + 1, column: character + 1 };
      const argument = node.arguments[0];
      const namespace = node.arguments.length === 1 ? staticString(argument) : null;

      if (namespace === null || namespace.trim() === "") {
        unsoundCalls.push({
          ...location,
          reason:
            namespace === null
              ? "useTranslations must be called with exactly one literal namespace argument"
              : "useTranslations must not use an empty namespace",
        });
      } else {
        calls.push({ namespace, ...location });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const info: ModuleInfo = {
    isClient: hasUseClientDirective(sourceFile),
    dependencies: collectDependencies(sourceFile),
    calls,
    unsoundCalls,
  };
  moduleInfoCache.set(filename, info);
  return info;
}

function collectReachableFiles(entryFiles: readonly string[]): Set<string> {
  const visited = new Set<string>();
  const stack = [...entryFiles];

  while (stack.length > 0) {
    const filename = stack.pop();
    if (!filename || visited.has(filename)) continue;
    visited.add(filename);

    for (const specifier of getModuleInfo(filename).dependencies) {
      const dependency = resolveSourceModule(specifier, filename);
      if (dependency && !visited.has(dependency)) stack.push(dependency);
    }
  }

  return visited;
}

/**
 * Enumerate route UI files below a directory. `api` route handlers are skipped:
 * they do not render client components and following them would only pull server
 * DB code into the graph.
 */
function collectRouteFiles(
  directory: string,
  options: { skipTopLevelDirectories?: Set<string> } = {},
): string[] {
  const files: string[] = [];

  function walk(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "api") continue;
        if (
          current === appDir &&
          options.skipTopLevelDirectories?.has(entry.name)
        ) {
          continue;
        }
        walk(fullPath);
      } else if (ROUTE_FILE_PATTERN.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  walk(directory);
  return files.sort();
}

/**
 * Merge the base catalog with every feature catalog exactly like
 * src/i18n/request.ts::loadMessages. Enumerating features instead of hard-coding
 * "multi-draw-chat" keeps this guard correct when another feature catalog is
 * added to the request loader.
 */
function loadMergedMessages(locale: string): Record<string, unknown> {
  const baseFilename = path.join(repoRoot, "messages", `${locale}.json`);
  const merged = JSON.parse(readFileSync(baseFilename, "utf8")) as Record<string, unknown>;
  const featuresDir = path.join(repoRoot, "messages", "features");
  if (!existsSync(featuresDir)) return merged;

  const featureDirectories = readdirSync(featuresDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of featureDirectories) {
    const featureFilename = path.join(featuresDir, entry.name, `${locale}.json`);
    if (!existsSync(featureFilename)) continue;
    Object.assign(merged, JSON.parse(readFileSync(featureFilename, "utf8")));
  }

  return merged;
}

const messages = loadMergedMessages("ja");

const rootEntries = collectRouteFiles(appDir, {
  skipTopLevelDirectories: NESTED_PROVIDER_SEGMENTS,
});

const providerSites: ProviderSite[] = [
  {
    name: "root",
    entries: rootEntries,
    namespaces: ROOT_CLIENT_NAMESPACES,
  },
  {
    name: "dashboard",
    entries: collectRouteFiles(path.join(appDir, "dashboard")),
    namespaces: DASHBOARD_CLIENT_NAMESPACES,
  },
  {
    name: "collection",
    entries: collectRouteFiles(path.join(appDir, "collection")),
    namespaces: COLLECTION_CLIENT_NAMESPACES,
  },
  {
    name: "trade",
    entries: collectRouteFiles(path.join(appDir, "trade")),
    namespaces: TRADE_CLIENT_NAMESPACES,
  },
  {
    name: "live",
    entries: collectRouteFiles(path.join(appDir, "live")),
    namespaces: LIVE_CLIENT_NAMESPACES,
  },
  {
    name: "tos",
    entries: collectRouteFiles(path.join(appDir, "tos")),
    namespaces: TOS_CLIENT_NAMESPACES,
  },
  {
    // /overlay is not one of the five feature segments, but it owns an empty
    // provider so its zero-namespace contract is checked like every other site.
    name: "overlay",
    entries: collectRouteFiles(path.join(appDir, "overlay")),
    namespaces: OVERLAY_CLIENT_NAMESPACES,
  },
];

interface ProviderAnalysis {
  used: Map<string, UseTranslationsCall[]>;
  unsoundCalls: UnsoundCall[];
}

const analysisCache = new Map<string, ProviderAnalysis>();

function analyzeProvider(provider: ProviderSite): ProviderAnalysis {
  const cached = analysisCache.get(provider.name);
  if (cached) return cached;

  const reachableFiles = collectReachableFiles(provider.entries);
  const used = new Map<string, UseTranslationsCall[]>();
  const unsoundCalls: UnsoundCall[] = [];

  for (const filename of [...reachableFiles].sort()) {
    const info = getModuleInfo(filename);
    if (!info.isClient) continue;
    unsoundCalls.push(...info.unsoundCalls);

    for (const call of info.calls) {
      // The provider picks top-level namespaces; `settingsPage.advanced` and
      // `collection.album` are available through their top-level object.
      const topLevel = call.namespace.split(".")[0];
      const existing = used.get(topLevel);
      if (existing) {
        existing.push(call);
      } else {
        used.set(topLevel, [call]);
      }
    }
  }

  const analysis: ProviderAnalysis = { used, unsoundCalls };
  analysisCache.set(provider.name, analysis);
  return analysis;
}

function relative(filename: string): string {
  return path.relative(repoRoot, filename);
}

function formatLocation(call: { file: string; line: number; column: number }): string {
  return `${relative(call.file)}:${call.line}:${call.column}`;
}

describe("client i18n namespace lists", () => {
  it("has at least one route entry for every provider site", () => {
    // A renamed/moved segment directory would otherwise produce an empty graph
    // and make every namespace assertion below pass vacuously.
    const emptyProviders = providerSites
      .filter((provider) => provider.entries.length === 0)
      .map((provider) => provider.name);

    expect(emptyProviders, emptyProviders.join("\n")).toEqual([]);
  });

  it("contains only namespaces that exist in the merged ja catalog", () => {
    const failures: string[] = [];

    for (const provider of providerSites) {
      if (new Set(provider.namespaces).size !== provider.namespaces.length) {
        failures.push(`${provider.name}: duplicate namespace in list`);
      }

      for (const namespace of provider.namespaces) {
        if (!Object.prototype.hasOwnProperty.call(messages, namespace)) {
          failures.push(
            `${provider.name}: "${namespace}" is not a top-level namespace in messages/ja.json (or a merged feature catalog)`,
          );
        }
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("covers every literal useTranslations namespace reachable from each provider", () => {
    const failures: string[] = [];

    for (const provider of providerSites) {
      const analysis = analyzeProvider(provider);
      const allowed = new Set(provider.namespaces);

      for (const [namespace, calls] of [...analysis.used.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (allowed.has(namespace)) continue;
        failures.push(
          `${provider.name}: missing namespace "${namespace}" used by ${calls
            .map(formatLocation)
            .join(", ")}`,
        );
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("rejects useTranslations calls without a literal namespace in reachable client files", () => {
    const failures = providerSites.flatMap((provider) =>
      analyzeProvider(provider).unsoundCalls.map(
        (call) => `${provider.name}: ${formatLocation(call)} ${call.reason}`,
      ),
    );

    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("follows the exact ChatAnnouncementSettings alias to the delivery wrapper", () => {
    // Regression sentinel for the tsconfig path override. If the graph silently
    // stopped at a non-existent ChatAnnouncementSettings.tsx (or missed the
    // dynamic import), the dashboard list would still pass because this test
    // only asserts collected ⊆ list. This focused assertion makes the alias
    // resolution itself fail loudly.
    const containingFile = path.join(srcDir, "components", "SettingsLayout.tsx");
    const resolved = resolveSourceModule("@/components/ChatAnnouncementSettings", containingFile);

    expect(resolved).toBe(
      path.join(srcDir, "components", "ChatAnnouncementSettingsWithDelivery.tsx"),
    );

    const dashboard = analyzeProvider(
      providerSites.find((provider) => provider.name === "dashboard")!,
    );
    const calls = dashboard.used.get("multiDrawChatDelivery") ?? [];

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((call) => call.file.endsWith("MultiDrawChatDeliverySettings.tsx"))).toBe(
      true,
    );
  });
});

describe("pick", () => {
  it("keeps requested present namespaces and skips absent ones", () => {
    // The root layout test mocks getMessages() as {}; a missing namespace must
    // not be copied as `undefined`, otherwise next-intl treats it as configured.
    const source = {
      common: { hello: "hi" },
      auth: { login: "login" },
    };

    const picked = pick(source, ["common", "missing"]);

    expect(picked).toEqual({ common: { hello: "hi" } });
    expect(Object.prototype.hasOwnProperty.call(picked, "missing")).toBe(false);
    // pick must not mutate the shared request catalog.
    expect(source).toEqual({ common: { hello: "hi" }, auth: { login: "login" } });
  });
});
