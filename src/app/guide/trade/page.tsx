import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { TRADE_MAX_OPEN_OFFERS, TRADE_MAX_WANTED_QUANTITY } from "@/lib/trade";
import {
  TRADE_AUCTION_DURATIONS_HOURS,
  TRADE_AUCTION_SELECTION_HOURS,
  TRADE_MAX_ACTIVE_BIDS,
  TRADE_MAX_BID_QUANTITY,
} from "@/lib/trade-auction";
import PublicFooter from "@/components/PublicFooter";
import AuctionTimeline from "@/components/trade-guide/AuctionTimeline";
import Breadcrumb from "@/components/trade-guide/Breadcrumb";
import BoardTabsMock from "@/components/trade-guide/BoardTabsMock";
import CrossChannelFigure from "@/components/trade-guide/CrossChannelFigure";
import ExchangeFigure from "@/components/trade-guide/ExchangeFigure";
import FaqAccordion, { type FaqEntry } from "@/components/trade-guide/FaqAccordion";
import FlowSteps from "@/components/trade-guide/FlowSteps";
import GuideIcon, { type GuideIconName } from "@/components/trade-guide/GuideIcon";
import IconTile from "@/components/trade-guide/IconTile";
import ModeCard from "@/components/trade-guide/ModeCard";
import PhaseChips, { type PhaseChipItem } from "@/components/trade-guide/PhaseChips";
import RuleList, { type RuleItem } from "@/components/trade-guide/RuleList";
import TradeSettingsMock from "@/components/trade-guide/TradeSettingsMock";
import VisibilityTable from "@/components/trade-guide/VisibilityTable";
import WantableCheckMock from "@/components/trade-guide/WantableCheckMock";

export const metadata: Metadata = {
  title: "Card Trading Guide - TwiCa",
  description: "How to use TwiCa card trading: regular listings, auctions and streamer settings.",
};

// このページは図解中心の構成で、文言はすべて messages の tradeGuidePage.<セクション>.<キー> から
// 取得する（tsx に文言を持たない）。下の配列は「どの文言キーをどの順に、どのアイコンで描くか」だけを
// 持ち、tests/unit/public-help-pages.test.ts の同期テストが、配列とメッセージ（ja/en 両方）の
// キーが過不足なく1対1に対応していることを強制する。
//
// 数値（出品数・欲しい枚数・入札数・期限・選択期限）は文言に直書きせず、サーバーが実際に
// 判定に使っている定数をプレースホルダーに差し込む。定数を変えれば図解も追従するので、
// 「コードは変えたのにガイドが古いまま」という食い違いが起きない。
//
// このページは /guide（本番ではトレード入口がまだ非表示）からはリンクしない。
// トレード画面共通の layout（src/app/trade/layout.tsx）にだけ「使い方」リンクを置く。

// ページ内の見出しへ飛ぶ目次。ラベルは各セクションの title をそのまま使う
// （目次専用の文言を持たないので、見出しと目次の表記が食い違わない）。
const sections = [
  { id: "overview", icon: "book" },
  { id: "offer", icon: "swap" },
  { id: "auction", icon: "gavel" },
  { id: "streamer", icon: "gear" },
  { id: "faq", icon: "question" },
] as const satisfies readonly { id: string; icon: GuideIconName }[];

// 「はじめに」のタイル（messages: overview.<key>.{title,description}）。先頭の where は
// タブ帯の図つきの別枠で描くので、ここには含めない。
const overviewTiles = [
  { key: "login", icon: "login" },
  { key: "noNotice", icon: "bellOff" },
  { key: "unavailable", icon: "ban" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];

// 通常トレードの3ステップ（messages: offer.flow.<key>）。番号は配列順から導出される。
const offerFlowSteps = [
  { key: "create", icon: "tag" },
  { key: "accept", icon: "user" },
  { key: "done", icon: "check" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];

// 「ここがポイント」2x2（messages: offer.points.<key>）。
const offerPoints = [
  { key: "limit", icon: "list" },
  { key: "locked", icon: "lock" },
  { key: "cancel", icon: "xCircle" },
  { key: "auto", icon: "sparkle" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];

// オークションの役割別フロー（messages: auction.roles.seller.<key> / bidder.<key>）。
const sellerSteps = [
  { key: "create", icon: "gavel" },
  { key: "wait", icon: "clock" },
  { key: "select", icon: "trophy" },
  { key: "done", icon: "check" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];
const bidderSteps = [
  { key: "bid", icon: "plusCircle" },
  { key: "change", icon: "pencil" },
  { key: "wait", icon: "clock" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];

// ルールのチップ（messages: auction.rules.<key>）。kind=ban は「できないこと」。
const auctionRules = [
  { key: "bidShape", icon: "cards" },
  { key: "activeBids", icon: "list" },
  { key: "noSelf", icon: "ban", kind: "ban" },
  { key: "noSameCard", icon: "ban", kind: "ban" },
  { key: "wantable", icon: "check" },
  { key: "autoPick", icon: "sparkle" },
  { key: "crossBid", icon: "globe" },
  { key: "privacy", icon: "eyeOff" },
  { key: "withdrawLock", icon: "lock", kind: "ban" },
  { key: "cancel", icon: "xCircle" },
  { key: "listings", icon: "tag" },
] as const satisfies readonly { key: string; icon: GuideIconName; kind?: "ban" }[];

// ステータスチップ（messages: auction.status.<key>）。ラベルは実画面と同じ
// trade.auctionPhase* / trade.auctionBidUnsettleableBadge を使う。
const phaseChips = [
  { key: "bidding", labelKey: "auctionPhaseBidding" },
  { key: "selecting", labelKey: "auctionPhaseSelecting" },
  { key: "completed", labelKey: "auctionPhaseCompleted" },
  { key: "expired", labelKey: "auctionPhaseExpired" },
  { key: "cancelled", labelKey: "auctionPhaseCancelled" },
  { key: "unsettleable", labelKey: "auctionBidUnsettleableBadge" },
] as const;

// 未所持カード非公開の表の行（messages: streamer.visibility.<key> と <key>Public / <key>Hidden）。
// ok=false が ✗。「持っていないカードを欲しいカードに指定」は非公開だと不可（持っているカードだけ）。
const visibilityRows = [
  { key: "names", publicOk: true, hiddenOk: false },
  { key: "listings", publicOk: true, hiddenOk: false },
  { key: "wanted", publicOk: true, hiddenOk: false },
] as const;

// FAQ（messages: faq.<key>.{question,answer}）。表示順は配列順、アイコンは問いの性質に合わせる。
const faqItems = [
  { key: "disabled", icon: "toggle" },
  { key: "cardInactive", icon: "ban" },
  { key: "alreadyDone", icon: "check" },
  { key: "notEnough", icon: "cards" },
  { key: "limitReached", icon: "list" },
  { key: "alreadyListed", icon: "lock" },
  { key: "noPartner", icon: "globe" },
  { key: "notWantable", icon: "xCircle" },
  { key: "bidUnsettleable", icon: "warning" },
  { key: "selectionExpired", icon: "clock" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];

// 交換図の例示用の枚数。ルールではなく「3枚で出品するとこうなる」という説明用の数字
// （上限 TRADE_MAX_WANTED_QUANTITY より小さければ何でもよい）。
const EXAMPLE_WANTED_QUANTITY = 3;

/**
 * Guide page explaining how to use card trading (regular listings and auctions)
 * カードトレード（通常出品・オークション）の使い方を図解中心で説明するガイドページ。
 * ログイン不要で表示できる（/guide と同じ公開ページ）。<details> 以外のインタラクションは
 * 持たない Server Component で、図解は src/components/trade-guide/ の表示専用コンポーネント。
 */
export default async function TradeGuidePage() {
  const session = await getSession();
  const t = await getTranslations("tradeGuidePage");
  const tHeader = await getTranslations("header");
  const tGuide = await getTranslations("guidePage");
  // 実画面の文言（ステータスチップ・タブ名・設定パネルなど）は、画面と同じ messages から取る。
  // ガイド用に言い換えを持つと、画面の文言を変えたときにガイドだけ古くなる。
  const tTrade = await getTranslations("trade");
  const tSettings = await getTranslations("tradeSettings");
  const tCardManager = await getTranslations("cardManager");
  const tCardVisibility = await getTranslations("cardVisibilitySettings");
  const tAccount = await getTranslations("accountPage");
  const tNav = await getTranslations("navigation");

  // 期限の表示は、出品フォームの選択肢と同じラベル（24時間 / 3日 / 7日）を定数の順に並べる。
  const durationKeys: Record<number, string> = {
    24: "createAuctionDuration24h",
    72: "createAuctionDuration3d",
    168: "createAuctionDuration7d",
  };
  const durationLabels = TRADE_AUCTION_DURATIONS_HOURS.map((hours) => tTrade(durationKeys[hours]));
  const durations = durationLabels.join(t("hero.durationSeparator"));
  const selectionHours = TRADE_AUCTION_SELECTION_HOURS;

  const phaseItems: PhaseChipItem[] = phaseChips.map(({ key, labelKey }) => ({
    key,
    label: tTrade(labelKey),
    description: t(`auction.status.${key}`),
  }));
  // プレースホルダー {max} に入れる値はルールごとに異なる（入札の枚数 / 有効な入札数 / 出品数）。
  const ruleMax: Record<string, number> = {
    bidShape: TRADE_MAX_BID_QUANTITY,
    activeBids: TRADE_MAX_ACTIVE_BIDS,
    listings: TRADE_MAX_OPEN_OFFERS,
  };
  const ruleItems: RuleItem[] = auctionRules.map((rule) => ({
    key: rule.key,
    icon: rule.icon,
    kind: "kind" in rule ? rule.kind : undefined,
    text: t(`auction.rules.${rule.key}`, { max: ruleMax[rule.key] ?? 0 }),
  }));
  // 長い1文の説明を「アイコン＋文」で並べる箇所（クロスチャンネルの補足・配信者設定の効果）。
  const iconLines = (scope: string, lines: readonly (readonly [string, GuideIconName])[]): RuleItem[] =>
    lines.map(([key, icon]) => ({ key, icon, text: t(`${scope}.${key}`) }));
  const faqEntries: FaqEntry[] = faqItems.map(({ key, icon }) => ({
    key,
    icon,
    question: t(`faq.${key}.question`),
    answer: t(`faq.${key}.answer`, {
      maxListings: TRADE_MAX_OPEN_OFFERS,
      maxBids: TRADE_MAX_ACTIVE_BIDS,
      hours: selectionHours,
    }),
  }));

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="border-b border-gray-800">
        <div className="container mx-auto px-4 py-4">
          <nav className="flex items-center justify-between">
            <Link href="/" className="text-xl font-bold text-white">
              TwiCa
            </Link>
            {session ? (
              <Link
                href="/dashboard"
                className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700"
              >
                {tHeader("dashboard")}
              </Link>
            ) : (
              <Link
                href="/"
                className="text-gray-400 hover:text-white"
              >
                {tGuide("home")}
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-10 sm:py-12">
        {/* Hero */}
        {/* ヒーロー - タイトル・導入・2つのモードカード・目次 */}
        <h1 className="mb-3 text-3xl font-bold text-white">
          {t("title")}
        </h1>
        <p className="mb-6 text-gray-300">
          {t("lead")}
        </p>

        {/* 2つのモードカード。スマホでは縦積み、sm 以上で横並び。カード全体が該当セクションへのリンク */}
        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          <ModeCard
            href="#offer"
            icon="swap"
            tone="offer"
            title={t("hero.offerTitle")}
            tagline={t("hero.offerTagline")}
            chips={[
              t("hero.offerChipWanted", { max: TRADE_MAX_WANTED_QUANTITY }),
              t("hero.offerChipListings", { max: TRADE_MAX_OPEN_OFFERS }),
            ]}
          />
          <ModeCard
            href="#auction"
            icon="gavel"
            tone="auction"
            title={t("hero.auctionTitle")}
            tagline={t("hero.auctionTagline")}
            chips={[
              t("hero.auctionChipDuration", { durations }),
              t("hero.auctionChipSelection", { hours: selectionHours }),
            ]}
          />
        </div>

        {/* Table of contents */}
        {/* 目次 - アイコン付きのピル型リンク。長いページなので各セクションへのアンカーを並べる */}
        <nav aria-label={t("toc")} className="mb-12 flex flex-wrap gap-2">
          {sections.map(({ id, icon }) => (
            <a
              key={id}
              href={`#${id}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              <GuideIcon name={icon} className="h-4 w-4 text-purple-300" />
              {t(`${id}.title`)}
            </a>
          ))}
        </nav>

        {/* Getting started section */}
        {/* はじめにセクション */}
        <section id="overview" className="mb-14 scroll-mt-8">
          <SectionHeading icon="book">{t("overview.title")}</SectionHeading>
          {/* 「どこから使う」はタブ帯の図を含み縦に長いので、残りの3枚とは別の段にして
              横幅いっぱいに置く（同じ段に並べると隣のタイルに大きな空白ができる）。 */}
          <div className="mb-3">
            <IconTile
              as="h3"
              icon="search"
              title={t("overview.where.title")}
              description={t("overview.where.description")}
            >
              <BoardTabsMock
                label={t("overview.where.tabsLabel")}
                tradeButton={tTrade("collectionTradeButton")}
                tabs={[tTrade("tabInChannel"), tTrade("tabCrossChannel"), tTrade("tabAuction")]}
                myTradesLink={tTrade("myTradesLink")}
              />
              <p className="mt-3 text-sm leading-relaxed text-gray-300">{t("overview.where.myTrades")}</p>
            </IconTile>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {overviewTiles.map(({ key, icon }) => (
              <IconTile
                key={key}
                as="h3"
                icon={icon}
                title={t(`overview.${key}.title`)}
                description={t(`overview.${key}.description`)}
              />
            ))}
          </div>
        </section>

        {/* Regular trade section */}
        {/* 通常トレードセクション */}
        <section id="offer" className="mb-14 scroll-mt-8">
          <SectionHeading icon="swap">{t("offer.title")}</SectionHeading>
          <p className="mb-6 text-gray-300">{t("offer.lead")}</p>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("offer.exchange.title")}</h3>
          <div className="mb-8">
            <ExchangeFigure
              giveLabel={t("offer.exchange.give")}
              giveCount={t("offer.exchange.giveCount")}
              wantLabel={t("offer.exchange.want")}
              wantCount={t("offer.exchange.wantCount", { max: TRADE_MAX_WANTED_QUANTITY })}
              wantBadge={tTrade("quantityBadge", { count: EXAMPLE_WANTED_QUANTITY })}
              arrowLabel={t("offer.exchange.arrowLabel")}
              caption={t("offer.exchange.caption")}
            />
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("offer.flow.title")}</h3>
          <div className="mb-8">
            <FlowSteps
              steps={offerFlowSteps.map(({ key, icon }) => ({
                icon,
                title: t(`offer.flow.${key}.title`),
                description: t(`offer.flow.${key}.description`),
              }))}
            />
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("offer.points.title")}</h3>
          <div className="mb-8 grid gap-3 sm:grid-cols-2">
            {offerPoints.map(({ key, icon }) => (
              <IconTile
                key={key}
                icon={icon}
                title={t(`offer.points.${key}.title`, { max: TRADE_MAX_OPEN_OFFERS })}
                description={t(`offer.points.${key}.description`)}
              />
            ))}
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("offer.cross.title")}</h3>
          <CrossChannelFigure
            inChannelTab={tTrade("tabInChannel")}
            inChannelCaption={t("offer.cross.inChannelCaption")}
            crossTab={tTrade("tabCrossChannel")}
            crossCaption={t("offer.cross.crossCaption")}
            streamerA={t("offer.cross.streamerA")}
            streamerB={t("offer.cross.streamerB")}
            sideA={t("offer.cross.sideA")}
            sideB={t("offer.cross.sideB")}
            condition={t("offer.cross.condition")}
          />
          <div className="mt-3">
            <RuleList
              columns={1}
              items={iconLines("offer.cross", [
                ["partners", "user"],
                ["boards", "globe"],
              ])}
            />
          </div>
        </section>

        {/* Auction section */}
        {/* オークションセクション */}
        <section id="auction" className="mb-14 scroll-mt-8">
          <SectionHeading icon="gavel">{t("auction.title")}</SectionHeading>
          <p className="mb-6 text-gray-300">{t("auction.lead")}</p>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("auction.timeline.title")}</h3>
          <div className="mb-8">
            <AuctionTimeline
              biddingChip={tTrade("auctionPhaseBidding")}
              biddingTitle={t("auction.timeline.bidding.title")}
              biddingDescription={t("auction.timeline.bidding.description")}
              durationLabels={durationLabels}
              deadlineLabel={t("auction.timeline.deadline")}
              selectingChip={tTrade("auctionPhaseSelecting")}
              selectingTitle={t("auction.timeline.selecting.title")}
              selectingDescription={t("auction.timeline.selecting.description")}
              maxHoursLabel={t("auction.timeline.maxHours", { hours: selectionHours })}
              outcomeLabel={t("auction.timeline.outcomeLabel")}
              completedChip={tTrade("auctionPhaseCompleted")}
              completedDescription={t("auction.timeline.completed")}
              expiredChip={tTrade("auctionPhaseExpired")}
              expiredDescription={t("auction.timeline.expired")}
              noBidsNote={t("auction.timeline.noBids", { hours: selectionHours })}
              caption={t("auction.timeline.caption", { durations, hours: selectionHours })}
            />
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("auction.roles.title")}</h3>
          <div className="mb-8 grid gap-6 md:grid-cols-2">
            <div>
              <h4 className="mb-3 flex items-center gap-2 font-semibold text-emerald-200">
                <GuideIcon name="gavel" className="h-5 w-5" />
                {t("auction.roles.seller.title")}
              </h4>
              <FlowSteps
                layout="column"
                accent="emerald"
                steps={sellerSteps.map(({ key, icon }) => ({
                  icon,
                  title: t(`auction.roles.seller.${key}.title`),
                  description: t(`auction.roles.seller.${key}.description`),
                }))}
              />
            </div>
            <div>
              <h4 className="mb-3 flex items-center gap-2 font-semibold text-sky-200">
                <GuideIcon name="plusCircle" className="h-5 w-5" />
                {t("auction.roles.bidder.title")}
              </h4>
              <FlowSteps
                layout="column"
                accent="sky"
                steps={bidderSteps.map(({ key, icon }) => ({
                  icon,
                  title: t(`auction.roles.bidder.${key}.title`),
                  description: t(`auction.roles.bidder.${key}.description`, { max: TRADE_MAX_BID_QUANTITY }),
                }))}
              />
            </div>
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("auction.rules.title")}</h3>
          <div className="mb-8">
            <RuleList items={ruleItems} />
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("auction.status.title")}</h3>
          <PhaseChips items={phaseItems} />
        </section>

        {/* For streamers section */}
        {/* 配信者向けセクション */}
        <section id="streamer" className="mb-14 scroll-mt-8">
          <SectionHeading icon="gear">{t("streamer.title")}</SectionHeading>
          <p className="mb-6 text-sm text-gray-300">{t("streamer.requirement")}</p>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("streamer.settings.title")}</h3>
          {/* 設定の場所は、実際のメニュー・見出しの文言を順にたどった形で示す */}
          <div className="mb-4">
            <Breadcrumb
              label={t("streamer.settings.whereLabel")}
              items={[
                tHeader("userSettings"),
                tAccount("collectionSharing.title"),
                tSettings("title"),
              ]}
            />
          </div>
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            {([true, false] as const).map((tradeEnabled) => (
              <TradeSettingsMock
                key={String(tradeEnabled)}
                caption={t(tradeEnabled ? "streamer.settings.mockOn" : "streamer.settings.mockOff")}
                title={tSettings("title")}
                statusEnabled={tSettings("status.enabled")}
                statusDisabled={tSettings("status.disabled")}
                tradeEnabledLabel={tSettings("form.tradeEnabled")}
                tradeEnabledHelp={tSettings("form.tradeEnabledHelp")}
                crossLabel={tSettings("form.crossChannelEnabled")}
                crossHelp={tSettings("form.crossChannelEnabledHelp")}
                requiresTradeEnabled={tSettings("form.requiresTradeEnabled")}
                stateOn={t("streamer.settings.stateOn")}
                stateOff={t("streamer.settings.stateOff")}
                tradeEnabled={tradeEnabled}
                crossEnabled
              />
            ))}
          </div>
          <div className="mb-8">
            <RuleList
              columns={1}
              items={iconLines("streamer.settings", [
                ["tradeOn", "check"],
                ["tradeOff", "eyeOff"],
                ["crossRule", "globe"],
              ])}
            />
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("streamer.wantable.title")}</h3>
          <div className="mb-4">
            <Breadcrumb
              label={t("streamer.settings.whereLabel")}
              items={[tNav("cardManagement"), tCardManager("editCard")]}
            />
          </div>
          <p className="mb-3 text-sm text-gray-300">{t("streamer.wantable.description")}</p>
          <WantableCheckMock
            label={tCardManager("form.tradeWantable")}
            checkedCaption={t("streamer.wantable.checked")}
            uncheckedCaption={t("streamer.wantable.unchecked")}
          />
          <p className="mb-2 mt-4 text-sm font-semibold text-gray-200">{t("streamer.wantable.uncheckedEffects")}</p>
          <div className="mb-8">
            <RuleList
              columns={1}
              items={iconLines("streamer.wantable", [
                ["effect1", "eyeOff"],
                ["effect2", "swap"],
                ["effect3", "ban"],
              ])}
            />
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("streamer.visibility.title")}</h3>
          <div className="mb-4">
            <Breadcrumb
              label={t("streamer.settings.whereLabel")}
              items={[tHeader("userSettings"), tCardVisibility("title")]}
            />
          </div>
          <p className="mb-3 text-sm text-gray-300">{t("streamer.visibility.description")}</p>
          <VisibilityTable
            caption={t("streamer.visibility.tableLabel")}
            aspectHeader={t("streamer.visibility.aspect")}
            revealedHeader={t("streamer.visibility.public")}
            hiddenHeader={t("streamer.visibility.hidden")}
            rows={visibilityRows.map(({ key, publicOk, hiddenOk }) => ({
              key,
              aspect: t(`streamer.visibility.${key}`),
              revealed: { ok: publicOk, text: t(`streamer.visibility.${key}Public`) },
              hidden: { ok: hiddenOk, text: t(`streamer.visibility.${key}Hidden`) },
            }))}
          />
          <p className="mt-3 text-sm text-gray-300">{t("streamer.visibility.note")}</p>
        </section>

        {/* FAQ section */}
        {/* よくある質問（取引が失敗する主な理由と対処）。<details> のアコーディオンで JS 不要 */}
        <section id="faq" className="scroll-mt-8">
          <SectionHeading icon="question">{t("faq.title")}</SectionHeading>
          <FaqAccordion items={faqEntries} />
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

/** Section title (h2) with a leading icon; the page's h1 → h2 → h3 outline stays unbroken. */
function SectionHeading({ icon, children }: { icon: GuideIconName; children: React.ReactNode }) {
  return (
    <h2 className="mb-5 flex items-center gap-3 text-2xl font-semibold text-purple-400">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-purple-500/15">
        <GuideIcon name={icon} className="h-6 w-6" />
      </span>
      {children}
    </h2>
  );
}
