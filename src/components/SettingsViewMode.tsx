"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";

// 配信設定ページの表示モード切り替え用コンポーネント群。
// Progressive disclosure パターン (Gmail Basic/Standard, Stripe Advanced, GitHub Settings 等の業界標準)
// に倣い、初心者向けの最小構成 ("simple") と全設定を露出する "advanced" を切り替える。
// 詳細モードは sidebar nav パターンで section を一つずつ表示し情報過多を回避する。
// Simple mode = 最小限のクイックセットアップカード。
// Advanced mode = 左 sticky sidebar + 右ペインの単一セクション表示。
// 保存先は localStorage 限定 (DB 変更なし、ブラウザ毎)。

type SettingsViewMode = "simple" | "advanced";

const STORAGE_KEY = "twica.settingsViewMode";
const DEFAULT_MODE: SettingsViewMode = "simple";

// 同一タブ内で localStorage.setItem しても storage イベントは発火しないため、
// 自前の購読者集合を保持し setMode 時に手動通知する。
// モジュールスコープのシングルトンとすることで、Provider 不在/複数でも整合性を保てる。
const storageSubscribers = new Set<() => void>();
let transientMode: SettingsViewMode | null = null;

function notifyStorageSubscribers(): void {
  storageSubscribers.forEach((cb) => cb());
}

// テスト用: 内部購読者集合をクリア。本番コードからは呼ばない。
export function __resetSettingsViewModeSubscribersForTest(): void {
  storageSubscribers.clear();
  transientMode = null;
}

interface SettingsViewModeContextValue {
  mode: SettingsViewMode;
  setMode: (mode: SettingsViewMode) => void;
}

const SettingsViewModeContext = createContext<SettingsViewModeContextValue | null>(null);

function isValidMode(value: unknown): value is SettingsViewMode {
  return value === "simple" || value === "advanced";
}

function subscribeStorage(callback: () => void): () => void {
  storageSubscribers.add(callback);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", callback);
  }
  return () => {
    storageSubscribers.delete(callback);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", callback);
    }
  };
}

function readStoredMode(): SettingsViewMode | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isValidMode(stored) ? stored : null;
  } catch {
    // Safari プライベートモード等で localStorage がアクセス不能な場合は null。
    return null;
  }
}

function readCurrentMode(fallbackMode: SettingsViewMode): SettingsViewMode {
  return transientMode ?? readStoredMode() ?? fallbackMode;
}

export function SettingsViewModeProvider({
  children,
  initialModeHint,
  requestedMode,
}: {
  children: ReactNode;
  initialModeHint?: SettingsViewMode;
  /** URL CTA等、ユーザーが明示した遷移だけlocalStorageより優先して一度適用する。 */
  requestedMode?: SettingsViewMode;
}) {
  const fallbackMode: SettingsViewMode = initialModeHint ?? DEFAULT_MODE;

  const getClientSnapshot = useCallback(
    (): SettingsViewMode => readCurrentMode(fallbackMode),
    [fallbackMode],
  );

  const getServerSnapshot = useCallback(
    (): SettingsViewMode => fallbackMode,
    [fallbackMode],
  );

  const mode = useSyncExternalStore(
    subscribeStorage,
    getClientSnapshot,
    getServerSnapshot,
  );

  const setMode = useCallback((next: SettingsViewMode) => {
    if (typeof window === "undefined") return;
    transientMode = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      notifyStorageSubscribers();
      return;
    }
    notifyStorageSubscribers();
  }, []);

  useEffect(() => {
    if (requestedMode) setMode(requestedMode);
  }, [requestedMode, setMode]);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return (
    <SettingsViewModeContext.Provider value={value}>
      {children}
    </SettingsViewModeContext.Provider>
  );
}

/**
 * Hook for child components to react to the current view mode.
 * Provider 外で呼ばれた場合は安全側に倒し "advanced" を返す
 * (= 全機能を表示する) ことで、テスト / 単体表示時の破損を避ける。
 */
export function useSettingsViewMode(): SettingsViewMode {
  const ctx = useContext(SettingsViewModeContext);
  return ctx?.mode ?? "advanced";
}

/**
 * Hook to imperatively change the view mode (e.g. from an inline CTA link).
 * Provider 外では no-op を返し、安全側に倒す。
 */
export function useSetSettingsViewMode(): (mode: SettingsViewMode) => void {
  const ctx = useContext(SettingsViewModeContext);
  return ctx?.setMode ?? (() => {});
}

function useSettingsViewModeStrict(): SettingsViewModeContextValue {
  const ctx = useContext(SettingsViewModeContext);
  if (!ctx) {
    throw new Error("must be used within SettingsViewModeProvider");
  }
  return ctx;
}

/**
 * View-mode セグメントトグル。
 * "シンプル" と "詳細" は文字数が違うためボタン幅が一致しない。
 * 以前はスライドする absolute なハイライトピルを使っていたが、50% width 計算が
 * 各ボタンの実寸法とズレてはみ出していた (ユーザー報告)。
 * 各ボタンに直接 active 背景を持たせる方式に切替え、位置ズレを根本解消。
 */
export function SettingsViewToggle() {
  const t = useTranslations("settingsPage.viewMode");
  const { mode, setMode } = useSettingsViewModeStrict();

  const baseClass =
    "relative z-10 rounded-full px-4 py-1.5 text-xs font-medium tracking-wide transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300";
  const activeClass =
    "bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-900/40";
  const inactiveClass = "text-gray-400 hover:text-gray-200";

  return (
    <div
      role="group"
      aria-label={t("ariaLabel")}
      className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-gray-900/60 p-1 shadow-inner shadow-black/40 backdrop-blur"
    >
      <button
        type="button"
        aria-pressed={mode === "simple"}
        onClick={() => setMode("simple")}
        className={`${baseClass} ${mode === "simple" ? activeClass : inactiveClass}`}
      >
        {t("simple")}
      </button>
      <button
        type="button"
        aria-pressed={mode === "advanced"}
        onClick={() => setMode("advanced")}
        className={`${baseClass} ${mode === "advanced" ? activeClass : inactiveClass}`}
      >
        {t("advanced")}
      </button>
    </div>
  );
}

/**
 * 詳細設定ラッパー (互換性のため残す)。
 * mode === "advanced" のときだけ children を表示。
 * 非表示時は `hidden` 属性 + DOM 保持で内部状態 (入力中の値など) を失わない。
 */
export function AdvancedSettings({ children }: { children: ReactNode }) {
  const mode = useSettingsViewMode();
  const isAdvanced = mode === "advanced";
  return (
    <div
      data-testid="advanced-settings"
      aria-hidden={isAdvanced ? undefined : true}
      hidden={!isAdvanced}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advanced mode: sidebar navigation
// ---------------------------------------------------------------------------

export interface SettingsSection {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  /** active/configured/empty/attention — controls the right-side status marker */
  status?: "active" | "configured" | "empty" | "attention";
  /** 色に依存せずattention等の意味を伝える、短い可視ラベル。 */
  statusLabel?: string;
  content: ReactNode;
}

const STATUS_DOT_CLASS: Record<NonNullable<SettingsSection["status"]>, string> = {
  active: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.65)]",
  configured: "bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.55)]",
  empty: "bg-gray-600",
  attention: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.65)]",
};

/**
 * AdvancedSettingsLayout
 *
 * sticky 左サイドバー + 右コンテンツの 2 カラムレイアウト。
 * 一度に 1 セクションだけ表示することで、情報過多を解消する。
 * モバイル (lg 未満) では横スクロールするピル型タブとして折り畳まれる。
 */
export function AdvancedSettingsLayout({
  sections,
  initialSectionId,
}: {
  sections: SettingsSection[];
  initialSectionId?: string;
}) {
  const t = useTranslations("settingsPage.advanced");
  // URL由来の値を直接stateへ入れず、実際に渡されたsectionとの一致を確認する。
  // allowlist外の任意文字列で空ペインを作らず、従来の先頭sectionへ安全に戻す。
  const requestedInitialActiveId = sections.find(
    (section) => section.id === initialSectionId,
  )?.id;
  const initialActiveId = requestedInitialActiveId ?? sections[0]?.id ?? "";
  const [activeId, setActiveId] = useState<string>(initialActiveId);
  const [visitedIds, setVisitedIds] = useState<Set<string>>(
    () => new Set(initialActiveId ? [initialActiveId] : [])
  );
  const active = sections.find((s) => s.id === activeId) ?? sections[0];

  if (!active) return null;

  const selectSection = (sectionId: string) => {
    setActiveId(sectionId);
    setVisitedIds((prev) => {
      if (prev.has(sectionId)) return prev;
      const next = new Set(prev);
      next.add(sectionId);
      return next;
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* Sidebar — desktop = vertical sticky list, mobile = horizontal scroll */}
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <nav
          aria-label={t("navAria")}
          className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-2 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0"
        >
          {sections.map((section) => {
            const isActive = section.id === active.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => selectSection(section.id)}
                aria-current={isActive ? "true" : undefined}
                className={`group flex shrink-0 items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 lg:w-full lg:shrink ${
                  isActive
                    ? "border-violet-500/40 bg-gradient-to-br from-violet-500/15 to-indigo-500/5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                    : "border-transparent text-gray-400 hover:border-white/5 hover:bg-white/5 hover:text-gray-200"
                }`}
              >
                {section.icon && (
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                      isActive
                        ? "bg-violet-500/20 text-violet-200"
                        : "bg-white/5 text-gray-500 group-hover:text-gray-300"
                    }`}
                  >
                    {section.icon}
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 font-medium">
                    <span className="truncate">{section.label}</span>
                    {section.status && (
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[section.status]}`}
                      />
                    )}
                    {section.statusLabel && (
                      <span className="shrink-0 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                        {section.statusLabel}
                      </span>
                    )}
                  </span>
                  {section.description && (
                    <span className="hidden truncate text-xs text-gray-500 lg:block">
                      {section.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Content pane */}
      <div className="min-w-0">
        {/* 訪問済みセクションだけを DOM に保持する。
            初期表示では非表示セクションの fetch を発火させず、訪問後は入力状態を保つ。 */}
        {sections.map((section) => (
          visitedIds.has(section.id) ? (
            <div key={section.id} hidden={section.id !== active.id} aria-hidden={section.id !== active.id ? true : undefined}>
              {section.content}
            </div>
          ) : null
        ))}
      </div>
    </div>
  );
}
