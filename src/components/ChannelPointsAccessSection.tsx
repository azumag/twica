"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import { CHANNEL_POINT_SCOPES } from "@/lib/twitch/scopes";
import { logger } from "@/lib/logger";

interface ChannelPointsAccessSectionProps {
  broadcasterType: string;
  initialEnabled: boolean;
}

type Capability = "available" | "unavailable" | "reauth_required" | "unknown";

/**
 * このセクションへ直接リンクするためのアンカーID。
 * /dashboard/account 内でこのセクションは4番目（言語設定・支援・サブスク確認の後）で
 * 初期表示に収まらないため、ダッシュボードの非配信者向け枠からは
 * /dashboard/account#channel-points で参照する。
 *
 * loading / fetchFailed の早期returnにも同じIDを付ける（同時に描画されるのは常に1つ
 * なのでDOM上で重複はしない）。ただし**ID があってもブラウザ標準のハッシュスクロールは
 * 効かない**ことを preview 実機で確認済み: #channel-points 付きで開いても
 * window.scrollY は 0 のままで、対象要素の rect.top は 1225px（viewport 841px）と
 * 画面外に留まった。そのため下の useAnchorScroll で明示的にスクロールさせる。
 */
const SECTION_ANCHOR_ID = "channel-points";
const sectionShellClass = "scroll-mt-8 rounded-xl bg-gray-800 p-6";

/**
 * URL のハッシュがこのセクションを指している場合に、自前でスクロールさせる。
 *
 * ブラウザ／App Router のハッシュスクロールに任せられないことは preview 実機で確認済み
 * （上記コメント参照）。マウント直後に一度だけスクロールし、loading の解決は待たない:
 * このセクションの上にある3節（言語設定・支援・サブスク確認）はサーバーから受け取った
 * propsで描画されマウント後に高さが変わらないため、アンカーのオフセットは確定している。
 * 実測でもレイアウトシフトは観測されなかった（スクロール前後の rect.top の変化 1003→663 が
 * スクロール量 340 と完全に一致した）。
 *
 * loading の解決を待つ実装は避ける。初回GET（staleなら続けて自動再判定POST）が終わるまで
 * 実機で約12秒スクロールされず、その間にユーザーが手動スクロールしていると位置を奪う。
 * block:'start' で自身の上端に合わせるため、このセクション自身の高さが後から変わっても
 * 着地位置はずれない。
 */
function useAnchorScroll() {
  const scrolledRef = useRef(false);

  useEffect(() => {
    if (scrolledRef.current) return;
    if (window.location.hash !== `#${SECTION_ANCHOR_ID}`) return;

    scrolledRef.current = true;
    document.getElementById(SECTION_ANCHOR_ID)?.scrollIntoView({ block: "start" });
  }, []);
}

interface AccessState {
  broadcasterType: string;
  capability: Capability;
  capabilityCheckedAt: string | null;
  enabled: boolean;
  hasRequiredScope: boolean;
  requiresReauth: boolean;
  stale: boolean;
  canEnable: boolean;
}

/**
 * 非Affiliateユーザー向けChannel Points利用可否確認・明示的オプトインセクション (#788 子D #792)。
 * /dashboard/account に配置し、/api/account/channel-points をsource of truthとして
 * 状態機械（Affiliate/reauth必要/確認中/有効化可能/有効化済み/利用不可/一時失敗）を描画する。
 */
export default function ChannelPointsAccessSection({
  broadcasterType,
  initialEnabled,
}: ChannelPointsAccessSectionProps) {
  const t = useTranslations("channelPointsAccess");
  const tMaintenance = useTranslations("maintenance");
  const router = useRouter();
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [loading, setLoading] = useState(true);
  // 初回GET完了までの仮状態。propsの値のみを反映し、GET結果で必ず上書きされる。
  const [state, setState] = useState<AccessState>({
    broadcasterType,
    capability: "unknown",
    capabilityCheckedAt: null,
    enabled: initialEnabled,
    hasRequiredScope: false,
    requiresReauth: false,
    stale: true,
    canEnable: false,
  });
  const [fetchFailed, setFetchFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  // React Strict Modeでのeffect二重実行や再render等で自動probeを複数回発火しないためのガード
  const autoProbeStarted = useRef(false);
  const mountedRef = useRef(true);

  // #channel-points 付きで遷移してきた場合に、この節までスクロールさせる
  useAnchorScroll();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchState = useCallback(async () => {
    try {
      const response = await fetch("/api/account/channel-points", { credentials: "include" });
      if (!response.ok) {
        if (mountedRef.current) setFetchFailed(true);
        return;
      }
      const data = (await response.json()) as AccessState;
      if (mountedRef.current) {
        setState(data);
        setFetchFailed(false);
      }
    } catch (err) {
      logger.error("Failed to fetch channel points access state:", err);
      if (mountedRef.current) setFetchFailed(true);
    }
  }, []);

  // 初回マウント時に1回だけGETする。
  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchState();
      if (mountedRef.current) setLoading(false);
    })();
  }, [fetchState]);

  const runProbe = useCallback(async () => {
    if (isMaintenanceBlocked) {
      setMessage({ type: "error", text: tMaintenance("writeDisabled") });
      return;
    }
    setChecking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/account/channel-points", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const maintenanceError = parseMaintenanceError(response, data);
        if (mountedRef.current) {
          setMessage({ type: "error", text: maintenanceError?.message || t("messages.genericError") });
        }
      }
    } catch {
      if (mountedRef.current) {
        setMessage({ type: "error", text: t("messages.genericError") });
      }
    } finally {
      await fetchState();
      if (mountedRef.current) setChecking(false);
    }
  }, [fetchState, isMaintenanceBlocked, t, tMaintenance]);

  // stale時の自動再判定。非Affiliate・スコープ有り・stale・現在probe中でない場合のみ、
  // mount中に最大1回だけ実行する（無限/重複POST防止）。maintenance中はrunProbe自体が
  // 拒否してエラーメッセージを出すだけになる（ユーザー操作無しで赤いエラーが出るのは
  // 体験として不適切）ため、ここで事前にスキップする。guardをautoProbeStarted設定より
  // 前に置くことで、maintenance解除後の再renderで自動的に再判定を試みられるようにする。
  useEffect(() => {
    if (loading || autoProbeStarted.current || checking || isMaintenanceBlocked) return;
    const isNonAffiliate = state.broadcasterType === "";
    if (isNonAffiliate && state.hasRequiredScope && state.stale) {
      autoProbeStarted.current = true;
      void runProbe();
    }
  }, [loading, state, checking, runProbe, isMaintenanceBlocked]);

  const handleReauthorize = useCallback(async () => {
    if (isMaintenanceBlocked) {
      setMessage({ type: "error", text: tMaintenance("writeDisabled") });
      return;
    }
    setChecking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/reauth", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          additionalScopes: CHANNEL_POINT_SCOPES,
          returnTo: "/dashboard/account",
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.state) {
          // callbackのstate検証(COOKIE_NAMES.AUTH_STATE)用。reauth APIはこのCookieを
          // server-sideで設定しないため、既存ChannelPointSettings.handleReauthorizeと
          // 同じ方式でclient側から設定する。
          document.cookie = `twitch_auth_state=${data.state}; path=/; max-age=600; secure; samesite=lax`;
        }
        window.location.href = data.loginUrl;
        return;
      }

      const errorData = await response.json().catch(() => ({}));
      const maintenanceError = parseMaintenanceError(response, errorData);
      // errorData.errorはAPI契約上は文字列だが、想定外のレスポンス形状
      // （オブジェクト等）をそのままJSX子要素へ渡すとReactがクラッシュするため防御する。
      const fallbackText = typeof errorData.error === "string" ? errorData.error : undefined;
      setMessage({ type: "error", text: maintenanceError?.message || fallbackText || t("messages.genericError") });
      setChecking(false);
    } catch {
      setMessage({ type: "error", text: t("messages.genericError") });
      setChecking(false);
    }
  }, [isMaintenanceBlocked, t, tMaintenance]);

  const handleEnable = useCallback(async () => {
    if (isMaintenanceBlocked) {
      setMessage({ type: "error", text: tMaintenance("writeDisabled") });
      return;
    }
    setEnabling(true);
    setMessage(null);
    try {
      const response = await fetch("/api/account/channel-points", {
        method: "PUT",
        credentials: "include",
      });
      const data = await response.json().catch(() => ({}));
      // 自動レビュー指摘: response.okだけで成功判定すると、DB更新は成功したが
      // session cookie再署名だけ失敗したケース（PUT成功時はcode: 'session_resync_failed'
      // + status 500 + enabled: true を返す設計）を「失敗」と誤表示し、直後のfetchState()で
      // enabled:trueが表示されて矛盾する。data.enabled===trueを主基準にする。
      if (data.enabled === true) {
        setMessage({
          type: "success",
          text:
            data.code === "session_resync_failed"
              ? t("messages.enableSuccessSessionPending")
              : t("messages.enableSuccess"),
        });
        await fetchState();
        // server component（dashboard layout等のisStreamer判定）へ反映。
        // session_resync_failed時はCookie未更新のため次回ログインまで完全には
        // 反映されないが、呼び出し自体は無害なため常に実行する。
        router.refresh();
      } else {
        const maintenanceError = parseMaintenanceError(response, data);
        setMessage({ type: "error", text: maintenanceError?.message || t("messages.enableFailed") });
        await fetchState();
      }
    } catch {
      if (mountedRef.current) {
        setMessage({ type: "error", text: t("messages.genericError") });
      }
    } finally {
      if (mountedRef.current) setEnabling(false);
    }
  }, [fetchState, isMaintenanceBlocked, router, t, tMaintenance]);

  if (loading) {
    return (
      <div id={SECTION_ANCHOR_ID} className={sectionShellClass}>
        <h2 className="mb-2 text-xl font-semibold text-white">{t("title")}</h2>
        <p className="text-sm text-gray-400">{t("loading")}</p>
      </div>
    );
  }

  if (fetchFailed) {
    return (
      <div id={SECTION_ANCHOR_ID} className={sectionShellClass}>
        <h2 className="mb-2 text-xl font-semibold text-white">{t("title")}</h2>
        <p className="mb-4 text-sm text-red-300">{t("messages.genericError")}</p>
        <button
          onClick={() => fetchState()}
          className="rounded-lg bg-gray-600 px-4 py-2 text-sm text-white hover:bg-gray-700"
        >
          {t("unknown.retryButton")}
        </button>
      </div>
    );
  }

  const isAffiliateOrPartner = state.broadcasterType === "affiliate" || state.broadcasterType === "partner";
  const buttonBaseClass =
    "rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50";
  const secondaryButtonClass =
    "rounded-lg bg-gray-600 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div id={SECTION_ANCHOR_ID} className={sectionShellClass}>
      <h2 className="mb-2 text-xl font-semibold text-white">{t("title")}</h2>
      <p className="mb-4 text-sm text-gray-400">{t("description")}</p>

      {message && (
        <div
          role="alert"
          aria-live="polite"
          className={`mb-4 rounded-lg p-3 text-sm ${
            message.type === "success"
              ? "border border-green-600/50 bg-green-900/30 text-green-300"
              : "border border-red-600/50 bg-red-900/30 text-red-300"
          }`}
        >
          {message.text}
        </div>
      )}

      {isMaintenanceBlocked && <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>}

      {isAffiliateOrPartner ? (
        <div>
          <p className="mb-3 text-sm text-gray-300">{t("affiliate.message")}</p>
          <Link href="/dashboard/settings" className={`inline-block ${buttonBaseClass}`}>
            {t("enabled.settingsLink")}
          </Link>
        </div>
      ) : state.enabled ? (
        <div>
          <p className="mb-3 text-sm text-green-300">{t("enabled.message")}</p>
          <Link href="/dashboard/settings" className={`inline-block ${buttonBaseClass}`}>
            {t("enabled.settingsLink")}
          </Link>
          {(state.requiresReauth || state.capability === "unavailable") && (
            <p className="mt-3 text-sm text-yellow-400">{t("capabilityLostWarning")}</p>
          )}
        </div>
      ) : checking ? (
        <p className="text-sm text-gray-300" aria-live="polite">
          {t("checking.message")}
        </p>
      ) : state.requiresReauth ? (
        <div>
          <p className="mb-3 text-sm text-yellow-300">{t("reauth.message")}</p>
          <button
            onClick={handleReauthorize}
            disabled={checking || isMaintenanceBlocked}
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
            className={buttonBaseClass}
          >
            {checking ? t("reauth.buttonLoading") : t("reauth.button")}
          </button>
        </div>
      ) : state.capability === "available" ? (
        <div>
          <p className="mb-2 text-sm text-green-300">{t("available.message")}</p>
          <p className="mb-3 text-sm text-gray-400">{t("available.enableDescription")}</p>
          <button
            onClick={handleEnable}
            disabled={enabling || isMaintenanceBlocked}
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
            className={buttonBaseClass}
          >
            {enabling ? t("available.enableButtonLoading") : t("available.enableButton")}
          </button>
        </div>
      ) : state.capability === "unavailable" ? (
        <div>
          <p className="mb-3 text-sm text-gray-300">{t("unavailable.message")}</p>
          <button
            onClick={runProbe}
            disabled={isMaintenanceBlocked}
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
            className={secondaryButtonClass}
          >
            {t("unavailable.recheckButton")}
          </button>
        </div>
      ) : (
        <div>
          <p className="mb-3 text-sm text-gray-300">{t("unknown.message")}</p>
          <button
            onClick={runProbe}
            disabled={isMaintenanceBlocked}
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
            className={secondaryButtonClass}
          >
            {t("unknown.retryButton")}
          </button>
        </div>
      )}
    </div>
  );
}
