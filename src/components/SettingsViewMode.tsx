"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";

// 配信設定ページの表示モード切り替え用コンポーネント群。
// Progressive disclosure パターン (Gmail Basic/Standard, Stripe Advanced 等の業界標準) に倣い、
// 初心者向けの最小構成 ("simple") と全設定を露出する "advanced" を切り替える。
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
// Exported for tests only — production code should not depend on this.
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

// useSyncExternalStore に渡す subscribe 関数。
// React docs: https://react.dev/reference/react/useSyncExternalStore
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
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isValidMode(stored) ? stored : null;
  } catch {
    // Safari プライベートモード等で localStorage がアクセス不能な場合は null (=未保存扱い)。
    return null;
  }
}

function readCurrentMode(fallbackMode: SettingsViewMode): SettingsViewMode {
  return transientMode ?? readStoredMode() ?? fallbackMode;
}

/**
 * Provider — Context + localStorage 永続化。
 * useSyncExternalStore で localStorage を購読し、SSR/CSR の整合性を保つ。
 *
 * initialModeHint:
 *   サーバー側でユーザーの既存設定状況から推奨初期モードを判断し渡す。
 *   localStorage に明示的保存がない場合のフォールバックとして使用される。
 *   既存ユーザーが詳細機能を有効化済みなら "advanced" を渡すことで、
 *   トグル導入時に設定が消えたように見える混乱を回避できる。
 */
export function SettingsViewModeProvider({
  children,
  initialModeHint,
}: {
  children: ReactNode;
  initialModeHint?: SettingsViewMode;
}) {
  // SSR snapshot は initialModeHint または DEFAULT_MODE 固定。
  // ハイドレーション不整合を避けるためサーバとクライアントの初期描画で同じ値を返す。
  const fallbackMode: SettingsViewMode = initialModeHint ?? DEFAULT_MODE;

  const getClientSnapshot = useCallback((): SettingsViewMode => {
    return readCurrentMode(fallbackMode);
  }, [fallbackMode]);

  const getServerSnapshot = useCallback((): SettingsViewMode => {
    return fallbackMode;
  }, [fallbackMode]);

  const mode = useSyncExternalStore(
    subscribeStorage,
    getClientSnapshot,
    getServerSnapshot,
  );

  const setMode = useCallback((next: SettingsViewMode) => {
    if (typeof window === "undefined") {
      // SSR で誤って呼ばれた場合は no-op (本来到達しない)。
      return;
    }
    transientMode = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      notifyStorageSubscribers();
      return;
    }
    notifyStorageSubscribers();
  }, []);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return (
    <SettingsViewModeContext.Provider value={value}>
      {children}
    </SettingsViewModeContext.Provider>
  );
}

function useSettingsViewMode(): SettingsViewModeContextValue {
  const ctx = useContext(SettingsViewModeContext);
  if (!ctx) {
    throw new Error(
      "useSettingsViewMode must be used within SettingsViewModeProvider",
    );
  }
  return ctx;
}

/**
 * 表示モード切替トグル UI (2 つのセグメントボタン)。
 * 視覚的に現在モードがハイライトされ、クリックでもう片方へ切替。
 */
export function SettingsViewToggle() {
  const t = useTranslations("settingsPage.viewMode");
  const { mode, setMode } = useSettingsViewMode();

  // 共通の trigger スタイル。aria-pressed で選択状態を伝える。
  const baseClass =
    "px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400";
  const activeClass = "bg-purple-600 text-white";
  const inactiveClass = "bg-gray-800 text-gray-300 hover:bg-gray-700";

  return (
    <div
      role="group"
      aria-label={t("ariaLabel")}
      className="inline-flex overflow-hidden rounded-lg border border-gray-700"
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
 * 詳細設定ラッパー。mode === "advanced" のときだけ children を表示。
 * 非表示時は `hidden` 属性を付け、DOM ノードは保持して内部状態 (入力中の値など) を失わない。
 *
 * aria-hidden は true のときだけ明示。false 明示は WAI-ARIA 仕様上意味が曖昧で
 * 一部支援技術で誤動作する可能性があるため、undefined にすることで属性自体を除外する。
 */
export function AdvancedSettings({ children }: { children: ReactNode }) {
  const { mode } = useSettingsViewMode();
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
