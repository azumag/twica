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
import BoardTabsMock from "@/components/trade-guide/BoardTabsMock";
import Breadcrumb from "@/components/trade-guide/Breadcrumb";
import Callout from "@/components/trade-guide/Callout";
import CrossChannelFigure from "@/components/trade-guide/CrossChannelFigure";
import DetailsBox from "@/components/trade-guide/DetailsBox";
import ExchangeFigure from "@/components/trade-guide/ExchangeFigure";
import FaqAccordion, { type FaqEntry } from "@/components/trade-guide/FaqAccordion";
import FlowSteps from "@/components/trade-guide/FlowSteps";
import GuideIcon, { type GuideIconName } from "@/components/trade-guide/GuideIcon";
import ModeCard from "@/components/trade-guide/ModeCard";
import PhaseChips, { type PhaseChipItem } from "@/components/trade-guide/PhaseChips";
import RuleList, { type RuleItem } from "@/components/trade-guide/RuleList";
import TermList from "@/components/trade-guide/TermList";
import TradeSettingsMock from "@/components/trade-guide/TradeSettingsMock";
import VisibilityTable from "@/components/trade-guide/VisibilityTable";
import WantableCheckMock from "@/components/trade-guide/WantableCheckMock";
import {
  EXAMPLE_ACCEPT_GET,
  EXAMPLE_ACCEPT_GIVE,
  EXAMPLE_AUCTION_BIDS,
  EXAMPLE_AUCTION_DURATION_HOURS,
  EXAMPLE_OFFER_GIVE,
  EXAMPLE_OFFER_WANT,
} from "@/components/trade-guide/exampleQuantities";

export const metadata: Metadata = {
  title: "Card Trading Guide - TwiCa",
  description: "How to use TwiCa card trading: regular listings, auctions and streamer settings.",
};

// このページは「やりたいこと」の順（応じる → 欲しいカードを指定して出品 → オークション →
// うまくいかないとき → 配信者向け）に並べる。文言はすべて messages の
// tradeGuidePage.<セクション>.<キー> から取得する（tsx に文言を持たない）。下の配列は
// 「どの文言キーをどの順に、どのアイコンで描くか」だけを持ち、
// tests/unit/public-help-pages.test.ts の同期テストが、配列とメッセージ（ja/en 両方）の
// キーが過不足なく1対1に対応していることを強制する。
//
// 数値（出品数・欲しい枚数・入札数・期限・選択期限）は文言に直書きせず、サーバーが実際に
// 判定に使っている定数をプレースホルダーに差し込む。定数を変えれば図解も追従するので、
// 「コードは変えたのにガイドが古いまま」という食い違いが起きない。例に使う枚数
// （exampleQuantities.ts）は「ルール」ではなく「この数字ならこうなる」という説明用の数字で、
// 上限の範囲内であることをテストが固定する。
//
// 文言の統一ルール（tests/unit/public-help-pages.test.ts が検査する）:
//   視聴者向け = 出品 / 応じる / 入札、「欲しいカード」「渡す」「もらう」、「クロスチャンネル」、
//   「だれとも交換されずに終了」、使えなくなったカードは「また使える」。
//   配信者向けの設定だけ、画面どおり「求めるカード」を引用する。
//
// このページは /guide（本番ではトレード入口がまだ非表示）からはリンクしない。
// トレード画面共通の layout（src/app/trade/layout.tsx）にだけ「使い方」リンクを置く。

// 冒頭の「どれを使う？」3択（messages: choose.<key>.{title,description}）。
// badge は対応するセクション見出しの文字と同じ。
const chooseCards = [
  { key: "accept", href: "#accept", icon: "search", tone: "accept", badge: "A" },
  { key: "offer", href: "#offer", icon: "swap", tone: "offer", badge: "B" },
  { key: "auction", href: "#auction", icon: "gavel", tone: "auction", badge: "C" },
] as const satisfies readonly {
  key: string;
  href: string;
  icon: GuideIconName;
  tone: "accept" | "offer" | "auction";
  badge: string;
}[];

// 用語ミニ解説（messages: start.terms.<key>.{term,description}）。
const termKeys = [{ key: "offer" }, { key: "accept" }, { key: "bid" }] as const;

// A. 応じる側の3ステップ（messages: accept.steps.<key>）。番号は配列順から導出される。
const acceptSteps = [
  { key: "find", icon: "search" },
  { key: "accept", icon: "user" },
  { key: "confirm", icon: "check" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];

// B. 出品の3ステップ（messages: offer.steps.<key>）。
const offerSteps = [
  { key: "card", icon: "tag" },
  { key: "want", icon: "cards" },
  { key: "confirm", icon: "check" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];

// B. くわしいルール（messages: offer.rules.<key>）。
const offerRules = [
  { key: "limit", icon: "list" },
  { key: "locked", icon: "lock" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];

// C. オークションの役割別フロー（messages: auction.seller.<key> / auction.bidder.<key>）。
const sellerSteps = [
  { key: "create", icon: "gavel" },
  { key: "wait", icon: "clock" },
  { key: "select", icon: "trophy" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];
const bidderSteps = [
  { key: "bid", icon: "plusCircle" },
  { key: "change", icon: "pencil" },
  { key: "wait", icon: "clock" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];

// C. くわしいルール（messages: auction.rules.<key>）。
const auctionRules = [
  { key: "activeBids", icon: "list" },
  { key: "privacy", icon: "eyeOff" },
  { key: "crossBid", icon: "globe" },
] as const satisfies readonly { key: string; icon: GuideIconName }[];

// ステータスチップ（messages: auction.rules.status.<key>）。ラベルは実画面と同じ
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
  { key: "listings", publicOk: true, hiddenOk: false },
  { key: "wanted", publicOk: true, hiddenOk: false },
] as const;

// うまくいかないとき（messages: faq.<key>.{question,reason,action}）。表示順は配列順、
// アイコンは問いの性質に合わせる。
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

/**
 * Guide page explaining how to use card trading (accepting a listing, listing a wanted
 * card, auctions) and, at the end, the streamer settings.
 * カードトレードの使い方を「やりたいこと」の順に説明するガイドページ。
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
  const durations = durationLabels.join(t("auction.durationSeparator"));
  const selectionHours = TRADE_AUCTION_SELECTION_HOURS;
  // 例のオークションが選ぶ期間（定数の期間のどれか。テストが範囲を固定する）。
  const exampleDurationIndex = TRADE_AUCTION_DURATIONS_HOURS.indexOf(EXAMPLE_AUCTION_DURATION_HOURS);
  const exampleDuration = durationLabels[exampleDurationIndex] ?? durationLabels[0];

  // 例の入札（「スライム ×3」のように、実画面の数量バッジと同じ ×N 表記）
  const exampleBids = EXAMPLE_AUCTION_BIDS.map((bid) => ({
    key: bid.key,
    picked: bid.picked,
    label: `${t(`auction.timeline.cards.${bid.key}`)} ${tTrade("quantityBadge", { count: bid.quantity })}`,
  }));
  const pickedBid = exampleBids.find((bid) => bid.picked) ?? exampleBids[0];

  const phaseItems: PhaseChipItem[] = phaseChips.map(({ key, labelKey }) => ({
    key,
    label: tTrade(labelKey),
    description: t(`auction.rules.status.${key}`),
  }));
  // プレースホルダー {max} に入れる値はルールごとに異なる（出品数 / 有効な入札数）。
  const ruleMax: Record<string, number> = {
    limit: TRADE_MAX_OPEN_OFFERS,
    activeBids: TRADE_MAX_ACTIVE_BIDS,
  };
  const toRuleItems = (scope: string, rules: readonly { key: string; icon: GuideIconName }[]): RuleItem[] =>
    rules.map(({ key, icon }) => ({ key, icon, text: t(`${scope}.${key}`, { max: ruleMax[key] ?? 0 }) }));
  // 配信者設定の効果など、長い1文を「アイコン＋文」で並べる箇所。
  const iconLines = (scope: string, lines: readonly (readonly [string, GuideIconName])[]): RuleItem[] =>
    lines.map(([key, icon]) => ({ key, icon, text: t(`${scope}.${key}`) }));
  const faqEntries: FaqEntry[] = faqItems.map(({ key, icon }) => {
    const values = { maxListings: TRADE_MAX_OPEN_OFFERS, maxBids: TRADE_MAX_ACTIVE_BIDS, hours: selectionHours };
    return {
      key,
      icon,
      question: t(`faq.${key}.question`),
      reason: t(`faq.${key}.reason`, values),
      action: t(`faq.${key}.action`, values),
    };
  });

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
        {/* Intro */}
        {/* 冒頭 - タイトル・導入・「どれを使う？」の3択・使う前に */}
        <h1 className="mb-3 text-3xl font-bold text-white">
          {t("title")}
        </h1>
        <p className="mb-2 text-gray-300">
          {t("lead")}
        </p>
        <p className="mb-8 text-sm">
          <a
            href="#streamer"
            className="text-purple-300 underline-offset-2 hover:text-purple-200 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            {t("streamerLink")}
          </a>
        </p>

        <section id="choose" className="mb-10 scroll-mt-8">
          <h2 className="mb-4 text-2xl font-semibold text-purple-400">{t("choose.title")}</h2>
          {/* 3枚のカード全体が該当セクションへのリンク。縦に並べて、説明文を読み切れる幅を確保する */}
          <div className="grid gap-3">
            {chooseCards.map(({ key, href, icon, tone, badge }) => (
              <ModeCard
                key={key}
                href={href}
                icon={icon}
                tone={tone}
                badge={badge}
                title={t(`choose.${key}.title`)}
                description={t(`choose.${key}.description`)}
              />
            ))}
          </div>
        </section>

        <section id="start" className="mb-14 scroll-mt-8">
          <h2 className="mb-3 text-2xl font-semibold text-purple-400">{t("start.title")}</h2>
          <p className="text-gray-300">{t("start.where")}</p>
          <BoardTabsMock
            label={t("start.tabsLabel")}
            tradeButton={tTrade("collectionTradeButton")}
            tabs={[tTrade("tabInChannel"), tTrade("tabCrossChannel"), tTrade("tabAuction")]}
            myTradesLink={tTrade("myTradesLink")}
          />
          <div className="mt-4">
            <TermList
              label={t("start.termsLabel")}
              items={termKeys.map(({ key }) => ({
                key,
                term: t(`start.terms.${key}.term`),
                description: t(`start.terms.${key}.description`),
              }))}
            />
          </div>
        </section>

        {/* A. Accept a listing */}
        {/* A. 出ている出品に応じて交換する */}
        <section id="accept" className="mb-14 scroll-mt-8">
          <SectionHeading icon="search" badge="A">
            {t("accept.title")}
          </SectionHeading>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("accept.example.title")}</h3>
          <div className="mb-8">
            {/* 応じる側の視点: 出品者の1枚をもらい、出品者が欲しがる枚数を渡す（ボードの渡す/もらうと同じ向き） */}
            <ExchangeFigure
              giveLabel={t("accept.example.give")}
              giveCard={t("accept.example.giveCard")}
              giveBadge={tTrade("quantityBadge", { count: EXAMPLE_ACCEPT_GIVE })}
              giveStacked={EXAMPLE_ACCEPT_GIVE > 1}
              wantLabel={t("accept.example.get")}
              wantCard={t("accept.example.getCard")}
              wantBadge={tTrade("quantityBadge", { count: EXAMPLE_ACCEPT_GET })}
              wantStacked={EXAMPLE_ACCEPT_GET > 1}
              arrowLabel={t("accept.example.arrowLabel")}
              caption={t("accept.example.caption", { give: EXAMPLE_ACCEPT_GIVE, get: EXAMPLE_ACCEPT_GET })}
            />
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("accept.steps.title")}</h3>
          <FlowSteps
            steps={acceptSteps.map(({ key, icon }) => ({
              icon,
              title: t(`accept.steps.${key}.title`),
              description: t(`accept.steps.${key}.description`),
            }))}
          />
        </section>

        {/* B. List the card you want (regular listing) */}
        {/* B. 欲しいカードを指定して出品する（通常出品） */}
        <section id="offer" className="mb-14 scroll-mt-8">
          <SectionHeading icon="swap" badge="B">
            {t("offer.title")}
          </SectionHeading>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("offer.example.title")}</h3>
          <div className="mb-8">
            <ExchangeFigure
              giveLabel={t("offer.example.give")}
              giveCard={t("offer.example.giveCard")}
              giveBadge={tTrade("quantityBadge", { count: EXAMPLE_OFFER_GIVE })}
              giveStacked={EXAMPLE_OFFER_GIVE > 1}
              wantLabel={t("offer.example.want")}
              wantCard={t("offer.example.wantCard")}
              wantBadge={tTrade("quantityBadge", { count: EXAMPLE_OFFER_WANT })}
              wantStacked={EXAMPLE_OFFER_WANT > 1}
              arrowLabel={t("offer.example.arrowLabel")}
              caption={t("offer.example.caption", { give: EXAMPLE_OFFER_GIVE, want: EXAMPLE_OFFER_WANT })}
            />
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("offer.steps.title")}</h3>
          <FlowSteps
            steps={offerSteps.map(({ key, icon }) => ({
              icon,
              title: t(`offer.steps.${key}.title`),
              description: t(`offer.steps.${key}.description`, { max: TRADE_MAX_WANTED_QUANTITY }),
            }))}
          />
          <p className="mt-5 text-gray-300">{t("offer.cancel")}</p>

          <DetailsBox summary={t("offer.rules.summary")}>
            <RuleList columns={1} items={toRuleItems("offer.rules", offerRules)} />
            <div className="space-y-3">
              <p className="font-semibold text-white">{t("offer.rules.crossTitle")}</p>
              <CrossChannelFigure
                inChannelTab={tTrade("tabInChannel")}
                inChannelCaption={t("offer.rules.inChannelCaption")}
                crossTab={tTrade("tabCrossChannel")}
                crossCaption={t("offer.rules.crossCaption")}
                streamerA={t("offer.rules.streamerA")}
                streamerB={t("offer.rules.streamerB")}
                sideA={t("offer.rules.sideA")}
                sideB={t("offer.rules.sideB")}
                condition={t("offer.rules.condition")}
              />
            </div>
          </DetailsBox>
        </section>

        {/* C. Auction */}
        {/* C. オークションで交換相手を募る */}
        <section id="auction" className="mb-14 scroll-mt-8">
          <SectionHeading icon="gavel" badge="C">
            {t("auction.title")}
          </SectionHeading>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("auction.timeline.title")}</h3>
          <div className="mb-8">
            <AuctionTimeline
              biddingChip={tTrade("auctionPhaseBidding")}
              biddingTitle={t("auction.timeline.bidding.title", { duration: exampleDuration })}
              durationLabels={durationLabels}
              selectedDuration={Math.max(exampleDurationIndex, 0)}
              bidsLabel={t("auction.timeline.bidding.bidsLabel")}
              bids={exampleBids}
              deadlineLabel={t("auction.timeline.deadline")}
              selectingChip={tTrade("auctionPhaseSelecting")}
              selectingTitle={t("auction.timeline.selecting.title", { bid: pickedBid.label })}
              maxHoursLabel={t("auction.timeline.maxHours", { hours: selectionHours })}
              completedChip={tTrade("auctionPhaseCompleted")}
              completedDescription={t("auction.timeline.completed", { bid: pickedBid.label })}
              expiredChip={tTrade("auctionPhaseExpired")}
              expiredDescription={t("auction.timeline.expired", { hours: selectionHours })}
              caption={t("auction.timeline.caption")}
            />
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-emerald-200">
                <GuideIcon name="gavel" className="h-5 w-5" />
                {t("auction.seller.title")}
              </h3>
              <FlowSteps
                layout="column"
                accent="emerald"
                steps={sellerSteps.map(({ key, icon }) => ({
                  icon,
                  title: t(`auction.seller.${key}.title`),
                  description: t(`auction.seller.${key}.description`, { durations, hours: selectionHours }),
                }))}
              />
              <div className="mt-4">
                <Callout icon="warning">{t("auction.seller.note", { hours: selectionHours })}</Callout>
              </div>
            </div>
            <div>
              <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-sky-200">
                <GuideIcon name="plusCircle" className="h-5 w-5" />
                {t("auction.bidder.title")}
              </h3>
              <FlowSteps
                layout="column"
                accent="sky"
                steps={bidderSteps.map(({ key, icon }) => ({
                  icon,
                  title: t(`auction.bidder.${key}.title`),
                  description: t(`auction.bidder.${key}.description`, { max: TRADE_MAX_BID_QUANTITY }),
                }))}
              />
            </div>
          </div>

          <DetailsBox summary={t("auction.rules.summary")}>
            <RuleList columns={1} items={toRuleItems("auction.rules", auctionRules)} />
            <div className="space-y-3">
              <p className="font-semibold text-white">{t("auction.rules.statusTitle")}</p>
              <PhaseChips items={phaseItems} />
            </div>
          </DetailsBox>
        </section>

        {/* Troubleshooting */}
        {/* うまくいかないとき（表示された文言 → 理由 → 対処）。<details> のアコーディオンで JS 不要 */}
        <section id="faq" className="mb-14 scroll-mt-8">
          <SectionHeading icon="question">{t("faq.title")}</SectionHeading>
          <FaqAccordion items={faqEntries} reasonLabel={t("faq.reasonLabel")} actionLabel={t("faq.actionLabel")} />
        </section>

        {/* For streamers: kept at the very end, behind a rule, so viewers can stop before it */}
        {/* 配信者向け - 視聴者向けの説明とは罫線で分けてページ末尾に置く */}
        <section id="streamer" className="scroll-mt-8 border-t border-gray-700 pt-10">
          <SectionHeading icon="gear">{t("streamer.title")}</SectionHeading>
          <p className="mb-6 text-sm text-gray-300">{t("streamer.lead")}</p>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("streamer.enable.title")}</h3>
          {/* 設定の場所は、実際のメニュー・見出しの文言を順にたどった形で示す */}
          <div className="mb-4">
            <Breadcrumb
              label={t("streamer.whereLabel")}
              items={[
                tHeader("userSettings"),
                tAccount("collectionSharing.title"),
                tSettings("title"),
              ]}
            />
          </div>
          <p className="mb-4 text-gray-300">{t("streamer.enable.description")}</p>
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            {([true, false] as const).map((tradeEnabled) => (
              <TradeSettingsMock
                key={String(tradeEnabled)}
                caption={t(tradeEnabled ? "streamer.enable.mockOn" : "streamer.enable.mockOff")}
                title={tSettings("title")}
                statusEnabled={tSettings("status.enabled")}
                statusDisabled={tSettings("status.disabled")}
                tradeEnabledLabel={tSettings("form.tradeEnabled")}
                tradeEnabledHelp={tSettings("form.tradeEnabledHelp")}
                crossLabel={tSettings("form.crossChannelEnabled")}
                crossHelp={tSettings("form.crossChannelEnabledHelp")}
                requiresTradeEnabled={tSettings("form.requiresTradeEnabled")}
                stateOn={t("streamer.enable.stateOn")}
                stateOff={t("streamer.enable.stateOff")}
                tradeEnabled={tradeEnabled}
                crossEnabled
              />
            ))}
          </div>
          <div className="mb-10">
            <RuleList columns={1} items={iconLines("streamer.enable", [["off", "eyeOff"]])} />
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("streamer.wantable.title")}</h3>
          <div className="mb-4">
            <Breadcrumb
              label={t("streamer.whereLabel")}
              items={[tNav("cardManagement"), tCardManager("editCard")]}
            />
          </div>
          <p className="mb-3 text-gray-300">{t("streamer.wantable.description")}</p>
          <WantableCheckMock
            label={tCardManager("form.tradeWantable")}
            checkedCaption={t("streamer.wantable.checked")}
            uncheckedCaption={t("streamer.wantable.unchecked")}
          />
          <p className="mb-2 mt-4 text-sm font-semibold text-gray-200">{t("streamer.wantable.effectsTitle")}</p>
          <div className="mb-10">
            <RuleList
              columns={1}
              items={iconLines("streamer.wantable", [
                ["effect1", "eyeOff"],
                ["effect2", "swap"],
              ])}
            />
          </div>

          <h3 className="mb-3 text-lg font-semibold text-white">{t("streamer.visibility.title")}</h3>
          <div className="mb-4">
            <Breadcrumb
              label={t("streamer.whereLabel")}
              items={[tHeader("userSettings"), tCardVisibility("title")]}
            />
          </div>
          <p className="mb-3 text-gray-300">{t("streamer.visibility.description")}</p>
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
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

/**
 * Section title (h2) with a leading square. Sections A/B/C carry the same letter as the
 * card that links to them (so "A" on the card and "A" on the heading match); the others
 * carry an icon. The page's h1 → h2 → h3 outline stays unbroken.
 */
function SectionHeading({
  icon,
  badge,
  children,
}: {
  icon: GuideIconName;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <h2 className="mb-5 flex items-center gap-3 text-2xl font-semibold text-purple-400">
      <span
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-purple-500/15 text-xl font-bold"
      >
        {badge ?? <GuideIcon name={icon} className="h-6 w-6" />}
      </span>
      <span className="min-w-0">{children}</span>
    </h2>
  );
}
