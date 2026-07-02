"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import {
  AdvancedSettingsLayout,
  SettingsViewModeProvider,
  SettingsViewToggle,
  useSetSettingsViewMode,
  useSettingsViewMode,
  type SettingsSection,
} from "@/components/SettingsViewMode";
import CopyButton from "@/components/CopyButton";
import VoteCampaignButton from "@/components/VoteCampaignButton";
import { VOTE_CAMPAIGN_CONFIG } from "@/lib/constants";
import type { Card } from "@/types/database";

// token-manager のサーバー専用モジュールに依存しないよう、戻り値型を inline 宣言。
// 形状は getCustomBotAccountDisplayForStreamer の戻り値と一致させる。
type BotAccountDisplay = { username: string | null; displayName: string | null };

// 配信設定ページのレイアウト切替クライアントコンポーネント。
// Simple = 集中度の高いクイックスタート 2 ステップ表示。
// Advanced = sticky 左サイドバー + 右コンテンツの単一セクション表示。
// 各モードで実コンポーネント (OverlayPreview / ChannelPointSettings 等) を
// 個別にマウントするため、トグル時は子の内部状態がリセットされる。
// これは fetch 重複を避けるため意図的にした設計判断。
// (双方を常時マウントすると初回ロードで API が 2 倍呼ばれるトレードオフがあった)

const OverlayPreview = dynamic(() => import("@/components/OverlayPreview"), {
  ssr: false,
  loading: () => <SettingsPanelSkeleton />,
});
const ChannelPointSettings = dynamic(() => import("@/components/ChannelPointSettings"), {
  ssr: false,
  loading: () => <SettingsPanelSkeleton />,
});
const GachaSoundSettings = dynamic(() => import("@/components/GachaSoundSettings"), {
  ssr: false,
  loading: () => <SettingsPanelSkeleton />,
});
const ChatAnnouncementSettings = dynamic(() => import("@/components/ChatAnnouncementSettings"), {
  ssr: false,
  loading: () => <SettingsPanelSkeleton />,
});
const CardVisibilitySettings = dynamic(() => import("@/components/CardVisibilitySettings"), {
  ssr: false,
  loading: () => <SettingsPanelSkeleton />,
});

function SettingsPanelSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-white/5 bg-gray-900/40 p-6">
      <div className="h-4 w-1/3 rounded bg-white/10" />
      <div className="mt-3 h-3 w-2/3 rounded bg-white/10" />
      <div className="mt-6 h-10 w-full rounded bg-white/10" />
    </div>
  );
}

export interface SettingsLayoutData {
  streamerId: string;
  baseUrl: string;
  cards: Card[];
  showVoteCampaign: boolean;
  botAccount: BotAccountDisplay | null;
  channelPoint: {
    rewardId: string | null;
    rewardName: string | null;
    // Issue #393: pack bound to the main reward (null = all cards)
    collectionName: string | null;
  };
  gachaSound: {
    soundUrl: string | null;
    soundEnabled: boolean;
  };
  chatAnnouncement: {
    enabled: boolean;
    template: string | null;
    multiTemplate: string | null;
    multiShowCards: boolean;
  };
  visibility: {
    showUnowned: boolean;
    showUnownedDetails: boolean;
  };
  // Issue #554: カードパックのプルダウン表示制御 + デフォルト名。未指定
  // (undefined)の場合は ChannelPointSettings 側が従来どおりの表示にフォール
  // バックする(後方互換 — 既存の呼び出し元を壊さない)。
  cardPacks?: {
    canManage: boolean;
    defaultPackName: string | null;
  };
  initialModeHint: "simple" | "advanced";
}

export default function SettingsLayout(props: SettingsLayoutData) {
  return (
    <SettingsViewModeProvider initialModeHint={props.initialModeHint}>
      <VoteCampaignButton visible={props.showVoteCampaign} bonusMb={VOTE_CAMPAIGN_CONFIG.BONUS_MB} />
      <ModeSwitch data={props} />
    </SettingsViewModeProvider>
  );
}

function ModeSwitch({ data }: { data: SettingsLayoutData }) {
  const mode = useSettingsViewMode();
  return mode === "simple" ? <SimpleLayout data={data} /> : <AdvancedLayout data={data} />;
}

// ---------------------------------------------------------------------------
// Simple layout
// ---------------------------------------------------------------------------

function SimpleLayout({ data }: { data: SettingsLayoutData }) {
  const t = useTranslations("settingsPage");
  const collectionUrl = `${data.baseUrl}/collection/${data.streamerId}`;

  // クイックスタートのヒーローカードは「毎回邪魔」とのフィードバックを受け削除。
  // Step ラベル (「1. OBSにオーバーレイを追加」など) が既に説明的なため冗長だった。
  // The hero ribbon was removed per user feedback ("毎回邪魔"); the step labels
  // are self-explanatory and the page header already names the screen.
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader title={t("title")} />

      {/* Step 1: OBS URL */}
      <StepCard step={t("simple.step1")} label={t("simple.step1Label")}>
        <OverlayPreview
          streamerId={data.streamerId}
          baseUrl={data.baseUrl}
          cards={data.cards}
          showPreview={false}
          showCustomization={false}
          showCollectionUrl={false}
        />
      </StepCard>

      {/* Step 2: Reward picker — compact, no diagnostics */}
      <StepCard step={t("simple.step2")} label={t("simple.step2Label")}>
        <ChannelPointSettings
          streamerId={data.streamerId}
          currentRewardId={data.channelPoint.rewardId}
          currentRewardName={data.channelPoint.rewardName}
          currentCollectionName={data.channelPoint.collectionName}
          cardPacks={data.cardPacks}
          compact
        />
      </StepCard>

      {/* Collection URL — secondary share link */}
      <div className="rounded-2xl border border-white/5 bg-gray-900/40 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-200">{t("simple.collectionLink")}</p>
            <p className="mt-0.5 truncate text-xs text-gray-500">{collectionUrl}</p>
          </div>
          <CopyButton text={collectionUrl} />
        </div>
      </div>

      {/* CTA: switch to advanced */}
      <div className="flex justify-center pt-2">
        <SwitchToAdvancedLink />
      </div>
    </div>
  );
}

function StepCard({
  step,
  label,
  children,
}: {
  step: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="overflow-hidden rounded-2xl border border-white/5 bg-gray-900/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    >
      <header className="flex items-center gap-3 border-b border-white/5 bg-white/[0.02] px-5 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-500/20 text-xs font-semibold text-violet-200 ring-1 ring-inset ring-violet-400/20">
          {step}
        </span>
        <h3 className="text-sm font-semibold tracking-wide text-gray-200">{label}</h3>
      </header>
      {/* 子コンポーネントは独自スタイル (rounded-xl bg-gray-800) を持つため、
          ここでは padding のみ与えて入れ子カードとして自然に見せる。
          以前は属性セレクタで子の class を打ち消していたが、Tailwind class が
          変わった瞬間に静かに壊れる脆さがあったため廃止。 */}
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

function SwitchToAdvancedLink() {
  const t = useTranslations("settingsPage.simple");
  const setMode = useSetSettingsViewMode();
  return (
    <button
      type="button"
      onClick={() => setMode("advanced")}
      className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-5 py-2 text-sm text-gray-300 transition-all hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-white"
    >
      {t("switchToAdvanced")}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Advanced layout
// ---------------------------------------------------------------------------

function AdvancedLayout({ data }: { data: SettingsLayoutData }) {
  const t = useTranslations("settingsPage");
  const collectionUrl = `${data.baseUrl}/collection/${data.streamerId}`;

  const rewardStatus: SettingsSection["status"] = data.channelPoint.rewardId ? "active" : "empty";
  const soundStatus: SettingsSection["status"] = data.gachaSound.soundEnabled
    ? "active"
    : data.gachaSound.soundUrl
      ? "configured"
      : "empty";
  const announcementStatus: SettingsSection["status"] = data.chatAnnouncement.enabled
    ? "active"
    : "empty";
  const visibilityStatus: SettingsSection["status"] = data.visibility.showUnowned
    ? "active"
    : "empty";

  const sections: SettingsSection[] = [
    {
      id: "overlay",
      label: t("advanced.section.overlay"),
      description: t("advanced.section.overlayDesc"),
      icon: <SectionIcon name="overlay" />,
      status: "configured",
      content: (
        <OverlayPreview
          streamerId={data.streamerId}
          baseUrl={data.baseUrl}
          cards={data.cards}
          showCollectionUrl={false}
        />
      ),
    },
    {
      id: "reward",
      label: t("advanced.section.reward"),
      description: t("advanced.section.rewardDesc"),
      icon: <SectionIcon name="reward" />,
      status: rewardStatus,
      content: (
        <ChannelPointSettings
          streamerId={data.streamerId}
          currentRewardId={data.channelPoint.rewardId}
          currentRewardName={data.channelPoint.rewardName}
          currentCollectionName={data.channelPoint.collectionName}
          cardPacks={data.cardPacks}
        />
      ),
    },
    {
      id: "sound",
      label: t("advanced.section.sound"),
      description: t("advanced.section.soundDesc"),
      icon: <SectionIcon name="sound" />,
      status: soundStatus,
      content: (
        <GachaSoundSettings
          streamerId={data.streamerId}
          currentSoundUrl={data.gachaSound.soundUrl}
          currentSoundEnabled={data.gachaSound.soundEnabled}
        />
      ),
    },
    {
      id: "announcement",
      label: t("advanced.section.announcement"),
      description: t("advanced.section.announcementDesc"),
      icon: <SectionIcon name="chat" />,
      status: announcementStatus,
      content: (
        <ChatAnnouncementSettings
          streamerId={data.streamerId}
          currentEnabled={data.chatAnnouncement.enabled}
          currentTemplate={data.chatAnnouncement.template}
          currentMultiTemplate={data.chatAnnouncement.multiTemplate}
          currentMultiShowCards={data.chatAnnouncement.multiShowCards}
          botAccount={data.botAccount}
        />
      ),
    },
    {
      id: "visibility",
      label: t("advanced.section.visibility"),
      description: t("advanced.section.visibilityDesc"),
      icon: <SectionIcon name="eye" />,
      status: visibilityStatus,
      content: (
        <CardVisibilitySettings
          streamerId={data.streamerId}
          currentShowUnowned={data.visibility.showUnowned}
          currentShowUnownedDetails={data.visibility.showUnownedDetails}
        />
      ),
    },
    {
      id: "share",
      label: t("advanced.section.share"),
      description: t("advanced.section.shareDesc"),
      icon: <SectionIcon name="share" />,
      status: "configured",
      content: <ShareSection url={collectionUrl} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <AdvancedSettingsLayout sections={sections} />
    </div>
  );
}

function ShareSection({ url }: { url: string }) {
  const t = useTranslations("overlaySettings");
  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <h2 className="mb-4 text-xl font-semibold text-white">{t("collectionUrl")}</h2>
      <p className="mb-4 text-sm text-gray-400">{t("collectionUrlDescription")}</p>
      <div className="flex gap-2">
        <input
          type="text"
          readOnly
          value={url}
          className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-gray-200"
        />
        <CopyButton text={url} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared header
// ---------------------------------------------------------------------------

function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">{title}</h1>
        {description && <p className="mt-2 text-sm text-gray-400">{description}</p>}
      </div>
      <SettingsViewToggle />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons — inline SVG path data only (no asset dependency).
// 一つの <SectionIcon> でラップし、共通の svg 属性を共有することで boilerplate を削減。
// ---------------------------------------------------------------------------

type IconName = "overlay" | "reward" | "sound" | "chat" | "eye" | "share";

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  overlay: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18" />
      <circle cx="7" cy="7" r="0.6" fill="currentColor" />
    </>
  ),
  reward: (
    <>
      <circle cx="12" cy="9" r="5" />
      <path d="M8.5 13.5 7 21l5-3 5 3-1.5-7.5" />
    </>
  ),
  sound: (
    <>
      <path d="M5 10v4h3l4 3V7L8 10H5z" />
      <path d="M16 8a5 5 0 0 1 0 8" />
    </>
  ),
  chat: <path d="M4 5h16v11H8l-4 4V5z" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.2 10.7 15.8 6.3M8.2 13.3l7.6 4.4" />
    </>
  ),
};

function SectionIcon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
      {ICON_PATHS[name]}
    </svg>
  );
}
