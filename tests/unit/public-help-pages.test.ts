import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const jaMessages = JSON.parse(readSource("messages/ja.json"));
const enMessages = JSON.parse(readSource("messages/en.json"));

/**
 * ページ側の配列リテラル（`const <name> = [...]`）に列挙されたメッセージキーを抜き出す。
 * 型注釈付き（`const x: readonly string[] = [...]`）でも拾えるようにしている。
 */
function listedKeys(source: string, arrayName: string): string[] {
  const match = source.match(new RegExp(`const ${arrayName}\\b[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!match) throw new Error(`${arrayName} not found`);
  return quotedStrings(match[1]);
}

/** `stepSubsteps` の 1エントリ（`"streamer.step2": [...]`）に列挙された substep キー。 */
function listedSubstepKeys(source: string, stepPath: string): string[] {
  const escaped = stepPath.replace(/\./g, "\\.");
  const match = source.match(new RegExp(`"${escaped}":\\s*\\[([^\\]]*)\\]`));
  if (!match) throw new Error(`stepSubsteps entry not found: ${stepPath}`);
  return quotedStrings(match[1]);
}

function quotedStrings(body: string): string[] {
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("FAQ page", () => {
  it("adds a localized public FAQ route", () => {
    const source = readSource("src/app/faq/page.tsx");

    expect(source).toContain('getTranslations("faqPage")');
    expect(source).toContain('href="/about"');
    expect(jaMessages.faqPage.title).toBe("よくある質問");
    expect(enMessages.faqPage.title).toBe("FAQ");
  });

  it("adds a localized usage ideas route (#852)", () => {
    const source = readSource("src/app/usages/page.tsx");

    expect(source).toContain('getTranslations("usagesPage")');
    expect(jaMessages.usagesPage.title).toBe("こんなおすすめの使い方！");
    expect(enMessages.usagesPage.title).toBe("Fun ways to use TwiCa!");
  });

  it("renders the shared public footer on every public page", () => {
    const pages = [
      "src/app/page.tsx",
      "src/app/guide/page.tsx",
      "src/app/usages/page.tsx",
      "src/app/guide/trade/page.tsx",
      "src/app/about/page.tsx",
      "src/app/privacy/page.tsx",
      "src/app/tos/page.tsx",
      "src/app/releases/page.tsx",
      "src/app/plans/page.tsx",
      "src/app/faq/page.tsx",
      "src/app/live/page.tsx",
    ];

    for (const page of pages) {
      const source = readSource(page);

      expect(source).toContain('import PublicFooter from "@/components/PublicFooter"');
      expect(source).toContain("<PublicFooter />");
      expect(source).not.toContain('getTranslations("footer")');
    }
  });

  it("keeps the public footer link set in one place", () => {
    const source = readSource("src/components/PublicFooter.tsx");

    expect(source).toContain("PUBLIC_FOOTER_LINKS");
    expect(source).toContain('href: "/guide"');
    expect(source).toContain('href: "/usages"');
    expect(source).toContain('href: "/faq"');
    expect(source).toContain('href: "/tos"');
    expect(source).toContain('href: "/about"');
    expect(source).toContain('href: "/privacy"');
    expect(source).toContain('href: "/releases"');
  });
});

describe("top page live-directory navigation", () => {
  it("places the live-directory link in content navigation instead of top bars", () => {
    const home = readSource("src/app/page.tsx");
    const dashboardNav = readSource("src/components/DashboardNav.tsx");

    expect(readSource("src/components/Header.tsx")).not.toContain('href="/live"');
    expect(readSource("src/components/TopPageHeader.tsx")).not.toContain('href="/live"');
    expect(home).toContain('href="/live"');
    expect(home.indexOf('t("hero.streamerGuide")')).toBeLessThan(
      home.indexOf('t("hero.liveDirectory")'),
    );
    expect(home).toContain("border-gray-600 bg-gray-800");
    expect(dashboardNav).toContain('href: "/live"');
  });

  it("describes the live-directory CTA as a TwiCa channel directory in both locales", () => {
    // /live には配信中一覧だけでなく全アクティブチャネルのランキングもあるため、
    // CTAを「配信中だけを見る」という旧来の意味へ戻さず、ロケール間でも対象を揃える。
    expect(jaMessages.topPage.hero.liveDirectory).toBe("利用中のチャネルを見る");
    expect(enMessages.topPage.hero.liveDirectory).toBe("Browse TwiCa channels");
  });
});

/**
 * 非Affiliateでも配信者機能を有効化できることの案内は、告知（お知らせ）だけでなく
 * /guide と /faq に恒久的に載せる。告知は既読で消えるため、恒久ページ側の記述が
 * 「アフィリエイト必須」へ巻き戻ると案内が完全に失われる。
 *
 * アサートは必ず「ロケールごとに別のマーカー」で行う。ja/en 共通の選択的正規表現
 * （/User Settings|ユーザー設定/ 等）にすると、両ロケールの文面が入れ替わっていても
 * 通ってしまい、巻き戻り検知として空虚になる。
 */
describe("streamer enablement documentation", () => {
  const locales = [
    { name: "ja", messages: jaMessages },
    { name: "en", messages: enMessages },
  ] as const;

  it("does not present Affiliate/Partner as a hard requirement in the guide", () => {
    // 旧文言「※ Twitchアフィリエイトまたはパートナーのステータスが必要です。」からの
    // 巻き戻りを、ロケール別の断定フレーズで検出する
    expect(jaMessages.guidePage.streamer.requirement).toContain("アフィリエイト／パートナーでなくてもチャネルポイントを利用できます");
    expect(enMessages.guidePage.streamer.requirement).toContain("Affiliate or Partner status is not required");
  });

  it("documents the explicit opt-in steps with the labels the UI actually renders", () => {
    const guideSource = readSource("src/app/guide/page.tsx");

    // サブ手順は <p> 内の "1. 2. 3." テキストではなく実際の <ol> で描画する
    expect(guideSource).toContain("stepSubsteps");
    expect(guideSource).toContain('"streamer.step2":');
    expect(guideSource).toContain("<ol");

    const substepKeys = listedSubstepKeys(guideSource, "streamer.step2");
    expect(substepKeys).toEqual(["substep1", "substep2", "substep3"]);

    for (const { name, messages } of locales) {
      const step2 = messages.guidePage.streamer.step2;
      const access = messages.channelPointsAccess;

      for (const key of substepKeys) {
        expect(step2[key], `${name}.step2.${key}`).toBeTruthy();
      }

      // 手順に登場する操作ラベルは channelPointsAccess / header の実値と文字列一致させる。
      // 状態メッセージは文末の句点だけ落として引用しているため正規化して比較する。
      const stripTrailingPunctuation = (text: string) => text.replace(/[。.]$/, "");
      const quoted = [step2.description, ...substepKeys.map((key) => step2[key])].join("\n");

      for (const label of [
        access.title,
        access.reauth.button,
        access.available.enableButton,
        messages.header.userSettings,
        stripTrailingPunctuation(access.available.message),
      ]) {
        expect(quoted, `${name}: ${label}`).toContain(label);
      }
    }
  });

  it("answers the non-Affiliate enablement question in the FAQ", () => {
    for (const { name, messages } of locales) {
      expect(messages.faqPage.streamer.enableStreamer.question, name).toBeTruthy();
      expect(messages.faqPage.streamer.enableStreamer.answer, name).toContain(
        messages.channelPointsAccess.available.enableButton
      );
      // 「利用できません」と表示された場合の対処（再判定）もトラブルシュートに載せる
      expect(messages.faqPage.trouble.channelPointsUnavailable.answer, name).toContain(
        messages.channelPointsAccess.unavailable.recheckButton
      );
      expect(messages.faqPage.trouble.capabilityLost.answer, name).toBeTruthy();
    }

    // 有効化済みユーザーがcapabilityを失った状態（capabilityLostWarning）では、同じ画面に
    // 再判定/再連携のボタンが無い（ChannelPointsAccessSection の enabled 分岐は警告文と
    // 配信設定リンクのみを描画する）。復旧経路はFAQ側でしか案内されないので、行き先の
    // 記述が消えないよう各ロケールでその画面を指す語を固定する（faqPage.setup.answer 等の
    // 既存FAQと同じ呼び方に合わせる）。
    expect(jaMessages.faqPage.trouble.capabilityLost.answer).toContain("配信設定");
    expect(enMessages.faqPage.trouble.capabilityLost.answer).toContain("Stream Settings");

    const faqSource = readSource("src/app/faq/page.tsx");
    expect(faqSource).toContain('"enableStreamer"');
    expect(faqSource).toContain('"channelPointsUnavailable"');
    expect(faqSource).toContain('"capabilityLost"');
  });

  it("actually renders the streamer sections on the guide and FAQ pages", () => {
    // キー配列が存在するだけでは案内は表示されない。配列を描画へ渡している箇所が
    // 消えると、見出しだけの空セクションになっても他のアサートは全て通ってしまう。
    const guideSource = readSource("src/app/guide/page.tsx");
    expect(guideSource).toContain('<StepList scope="viewer" steps={viewerSteps} t={t} />');
    expect(guideSource).toContain('<StepList scope="streamer" steps={streamerSteps} t={t} />');
    expect(guideSource).toContain('{t("streamer.requirement")}');
    expect(guideSource).toContain("{tips.map(");

    const faqSource = readSource("src/app/faq/page.tsx");
    for (const arrayName of ["viewerQuestions", "streamerQuestions", "troubleQuestions"]) {
      expect(faqSource).toContain(`keys={${arrayName}}`);
    }
  });

  it("keeps the guide/FAQ key lists in sync with the message catalogs", () => {
    const guideSource = readSource("src/app/guide/page.tsx");
    const faqSource = readSource("src/app/faq/page.tsx");

    const stepKeys = (section: Record<string, unknown>) =>
      Object.keys(section).filter((key) => /^step\d+$/.test(key));

    // ガイドの手順はカード番号が配列順（index + 1）から導出されるため、順序も一致させる
    expect(listedKeys(guideSource, "viewerSteps")).toEqual(stepKeys(jaMessages.guidePage.viewer));
    expect(listedKeys(guideSource, "streamerSteps")).toEqual(stepKeys(jaMessages.guidePage.streamer));
    expect(listedKeys(guideSource, "tips")).toEqual(
      Object.keys(jaMessages.guidePage.tips).filter((key) => /^tip\d+$/.test(key))
    );

    // FAQ の表示順はプロダクト判断でメッセージのキー順に縛られないため、集合だけ比較する
    for (const [arrayName, scope] of [
      ["viewerQuestions", "viewer"],
      ["streamerQuestions", "streamer"],
      ["troubleQuestions", "trouble"],
    ] as const) {
      expect([...listedKeys(faqSource, arrayName)].sort()).toEqual(
        Object.keys(jaMessages.faqPage[scope])
          .filter((key) => key !== "title")
          .sort()
      );
    }

    // 列挙されたステップの子キーが両ロケールに揃っていること。集合が一致していても
    // title/description が欠けると、画面にキーパスがそのまま表示される
    for (const { name, messages } of locales) {
      for (const scope of ["viewer", "streamer"] as const) {
        for (const key of stepKeys(messages.guidePage[scope])) {
          expect(messages.guidePage[scope][key].title, `${name}.${scope}.${key}.title`).toBeTruthy();
          expect(
            messages.guidePage[scope][key].description,
            `${name}.${scope}.${key}.description`
          ).toBeTruthy();
        }
      }
    }

    // おすすめの使い方ページ（#852）: グリッドの表示順は配列順なので厳密比較する。
    // メタ情報キー（title/metaDescription/lead/getStarted）は配列対象外。
    const usageSource = readSource("src/app/usages/page.tsx");
    const usageKeys = Object.keys(jaMessages.usagesPage).filter(
      (key) => !["title", "metaDescription", "lead", "getStarted"].includes(key)
    );
    expect(listedKeys(usageSource, "usages")).toEqual(usageKeys);
    for (const { name, messages } of locales) {
      for (const key of usageKeys) {
        for (const child of ["title", "description", "example", "feature"] as const) {
          expect(messages.usagesPage[key][child], `${name}.usagesPage.${key}.${child}`).toBeTruthy();
        }
      }
    }
    expect(usageSource).toContain("{usages.map(");
  });

  it("points non-streamers on the dashboard at the enablement flow", () => {
    // ロケール別マーカーで、アフィリエイト必須の断定へ戻っていないことを見る
    expect(jaMessages.dashboard.overview.streamerInfoText).toContain(
      "ユーザー設定の「チャネルポイント / 配信者機能」から配信者機能を有効化できます"
    );
    expect(enMessages.dashboard.overview.streamerInfoText).toContain(
      'enable streamer features from "Channel Points / Streamer Features" in User Settings'
    );
    expect(jaMessages.topPage.streamerInfo.description).toContain("アフィリエイト／パートナーでなくても");
    expect(enMessages.topPage.streamerInfo.description).toContain(
      "Affiliate or Partner status is not required"
    );

    for (const { name, messages } of locales) {
      expect(messages.dashboard.overview.streamerInfoAccountLink, name).toBeTruthy();
      expect(messages.dashboard.overview.streamerInfoGuideLink, name).toBeTruthy();
    }

    // !isStreamer の枠から、実際の操作場所（アンカー付き）と手順ページへ飛べること
    const dashboardSource = readSource("src/app/dashboard/page.tsx");
    expect(dashboardSource).toContain('href="/dashboard/account#channel-points"');
    expect(dashboardSource).toContain('href="/guide#streamer"');
    expect(dashboardSource).toContain('t("overview.streamerInfoAccountLink")');
    expect(dashboardSource).toContain('t("overview.streamerInfoGuideLink")');

    // アンカー先は fetch 解決前の loading / エラー分岐でも存在しないとスクロールできない
    const sectionSource = readSource("src/components/ChannelPointsAccessSection.tsx");
    expect(sectionSource).toContain('const SECTION_ANCHOR_ID = "channel-points"');
    expect(sectionSource.match(/id=\{SECTION_ANCHOR_ID\}/g)).toHaveLength(3);

    // ID だけではブラウザ標準のハッシュスクロールが効かないことを preview 実機で確認済み
    // （scrollY が 0 のまま）。自前スクロールを外すとリンクが機能しなくなるため固定する。
    expect(sectionSource).toContain("function useAnchorScroll(");
    expect(sectionSource).toContain("useAnchorScroll()");
    expect(sectionSource).toContain("scrollIntoView(");
    // loading の解決を待つと実機で約12秒スクロールされず、その間の手動スクロールを奪う。
    // マウント時に一度だけ実行する（依存配列は空）ことを固定する。
    expect(sectionSource).toMatch(/scrollIntoView\(\{ block: "start" \}\);\s*\}, \[\]\);/);
    expect(readSource("src/app/page.tsx")).toContain('t("streamerInfo.description")');
  });

  it("keeps ja/en key parity for the guide, FAQ and the surfaces they replace", () => {
    const collectKeys = (value: unknown, prefix = ""): string[] =>
      typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, child]) => [
            prefix + key,
            ...collectKeys(child, `${prefix}${key}.`),
          ])
        : [];

    for (const scope of ["guidePage", "faqPage", "usagesPage", "tradeGuidePage", "channelPointsAccess"] as const) {
      expect(collectKeys(jaMessages[scope]).sort(), scope).toEqual(collectKeys(enMessages[scope]).sort());
    }
    expect(collectKeys(jaMessages.topPage.streamerInfo).sort()).toEqual(
      collectKeys(enMessages.topPage.streamerInfo).sort()
    );
    expect(collectKeys(jaMessages.dashboard.overview).sort()).toEqual(
      collectKeys(enMessages.dashboard.overview).sort()
    );
  });
});

/**
 * カードトレードの使い方ガイド（/guide/trade）。
 * ページ側の配列とメッセージの1対1対応、画面上のボタン名との一致、導線（トレード画面側からだけ
 * リンクする）を固定する。数値・ルールの根拠は PR 本文の対応表を参照。
 */
describe("trade guide page", () => {
  const locales = [
    { name: "ja", messages: jaMessages },
    { name: "en", messages: enMessages },
  ] as const;
  const source = readSource("src/app/guide/trade/page.tsx");

  // セクションごとのステップ配列（ページ側の const 名）と、メッセージ側のスコープ。
  const stepScopes = [
    ["overviewSteps", "overview"],
    ["offerSteps", "offer"],
    ["auctionSteps", "auction"],
    ["streamerSteps", "streamer"],
  ] as const;
  // ステップ以外のメタ情報キー（配列の対象外）。
  const metaKeys = new Set(["title", "lead", "requirement"]);

  it("adds a localized public route that renders without login", () => {
    expect(source).toContain('getTranslations("tradeGuidePage")');
    expect(source).toContain("getSession()");
    // 公開ページなので認証必須の分岐（redirect）を持たない
    expect(source).not.toContain("redirect(");
    expect(jaMessages.tradeGuidePage.title).toBe("カードトレードの使い方");
    expect(enMessages.tradeGuidePage.title).toBe("How to Use Card Trading");
  });

  it("keeps the step arrays in sync with the message catalogs (order included)", () => {
    for (const [arrayName, scope] of stepScopes) {
      const stepKeys = Object.keys(jaMessages.tradeGuidePage[scope]).filter((key) => !metaKeys.has(key));
      // 番号は配列順（index + 1）から導出されるため、順序も一致させる
      expect(listedKeys(source, arrayName), arrayName).toEqual(stepKeys);
    }
    // FAQ の表示順は配列順。メタ情報は title のみ
    expect(listedKeys(source, "faqItems")).toEqual(
      Object.keys(jaMessages.tradeGuidePage.faq).filter((key) => key !== "title")
    );
    // 目次はセクションの id と、メッセージのセクション（title を持つもの）に1対1で対応する
    expect(listedKeys(source, "sectionIds")).toEqual(
      ["overview", "offer", "auction", "streamer", "faq"]
    );
    for (const id of listedKeys(source, "sectionIds")) {
      expect(source, id).toContain(`id="${id}"`);
    }
  });

  it("has every listed step, substep, point and FAQ entry in both locales", () => {
    const substepScopes = [...source.matchAll(/^ {2}"([a-zA-Z]+\.[a-zA-Z]+)": \[/gm)].map((m) => m[1]);
    expect(substepScopes.length).toBeGreaterThan(0);

    for (const { name, messages } of locales) {
      const page = messages.tradeGuidePage;
      for (const [arrayName, scope] of stepScopes) {
        for (const step of listedKeys(source, arrayName)) {
          expect(page[scope][step].title, `${name}.${scope}.${step}.title`).toBeTruthy();
          expect(page[scope][step].description, `${name}.${scope}.${step}.description`).toBeTruthy();
        }
      }
      // サブ手順・補足項目は stepSubsteps / stepPoints の列挙どおりに、両ロケールで実在する
      for (const stepPath of substepScopes) {
        const [scope, step] = stepPath.split(".");
        const keys = listedSubstepKeys(source, stepPath);
        expect(keys.length, stepPath).toBeGreaterThan(0);
        for (const key of keys) {
          expect(page[scope][step][key], `${name}.${stepPath}.${key}`).toBeTruthy();
        }
        // 列挙漏れ（メッセージにあるのにページが描画しない文言）も検出する
        const prefix = keys[0].startsWith("substep") ? "substep" : "point";
        expect(
          Object.keys(page[scope][step]).filter((key) => key.startsWith(prefix)),
          `${name}.${stepPath}`
        ).toEqual(keys);
      }
      for (const item of listedKeys(source, "faqItems")) {
        expect(page.faq[item].question, `${name}.faq.${item}.question`).toBeTruthy();
        expect(page.faq[item].answer, `${name}.faq.${item}.answer`).toBeTruthy();
      }
    }
  });

  it("actually renders every section", () => {
    // 配列が存在するだけでは表示されない。描画へ渡している箇所が消えると
    // 見出しだけの空セクションになっても他のアサートは通ってしまう。
    for (const [arrayName, scope] of stepScopes) {
      expect(source).toContain(`<StepList scope="${scope}" steps={${arrayName}} t={t} />`);
    }
    expect(source).toContain("{faqItems.map(");
    expect(source).toContain("{sectionIds.map(");
    expect(source).toContain("<PublicFooter />");
  });

  it("quotes the labels the trade UI actually renders (so the guide and screens use the same words)", () => {
    // ガイドが画面上のボタン名・見出しとズレると、読んだ人が画面で探せない。
    // 引用するラベルは messages の実値と文字列一致させる（ロケール別に取得するので、
    // ja/en の文面が入れ替わっても通らない）。
    for (const { name, messages } of locales) {
      const everything = JSON.stringify(messages.tradeGuidePage);
      const trade = messages.trade;
      const labels: Record<string, string> = {
        "trade.collectionTradeButton": trade.collectionTradeButton,
        "trade.tabInChannel": trade.tabInChannel,
        "trade.tabCrossChannel": trade.tabCrossChannel,
        "trade.tabAuction": trade.tabAuction,
        "trade.myTradesLink": trade.myTradesLink,
        "trade.createOfferButton": trade.createOfferButton,
        "trade.loginToCreate": trade.loginToCreate,
        "trade.acceptButton": trade.acceptButton,
        "trade.confirmModalSubmitButton": trade.confirmModalSubmitButton,
        "trade.cancelOfferButton": trade.cancelOfferButton,
        "trade.cancelOfferModalConfirmButton": trade.cancelOfferModalConfirmButton,
        "trade.myTradesTabOpen": trade.myTradesTabOpen,
        "trade.myTradesTabCancelled": trade.myTradesTabCancelled,
        "trade.createStep1Title": trade.createStep1Title,
        "trade.createStep2Title": trade.createStep2Title,
        "trade.createConfirmTitle": trade.createConfirmTitle,
        "trade.createStep2QuantityLabel": trade.createStep2QuantityLabel,
        "trade.createStep2SelectStreamer": trade.createStep2SelectStreamer,
        // 長い案内文なので、ガイドが引用する冒頭の一文だけを比較する
        "trade.createStep2NoPartners": trade.createStep2NoPartners.split(/[。.]/)[0],
        "trade.createStep1ListedBadge": trade.createStep1ListedBadge,
        "trade.createAuctionButton": trade.createAuctionButton,
        "trade.createKindLabel": trade.createKindLabel,
        "trade.createKindAuction": trade.createKindAuction,
        "trade.createAuctionStep1Title": trade.createAuctionStep1Title,
        "trade.createAuctionStep2Title": trade.createAuctionStep2Title,
        "trade.createAuctionDuration24h": trade.createAuctionDuration24h,
        "trade.createAuctionDuration3d": trade.createAuctionDuration3d,
        "trade.createAuctionDuration7d": trade.createAuctionDuration7d,
        "trade.createAuctionSubmitButton": trade.createAuctionSubmitButton,
        "trade.auctionRowDetailLink": trade.auctionRowDetailLink,
        "trade.auctionScopeCrossChannel": trade.auctionScopeCrossChannel,
        "trade.auctionBidChangeTitle": trade.auctionBidChangeTitle,
        "trade.auctionWithdrawButton": trade.auctionWithdrawButton,
        "trade.auctionPhaseBidding": trade.auctionPhaseBidding,
        "trade.auctionPhaseSelecting": trade.auctionPhaseSelecting,
        "trade.auctionBidUnsettleableBadge": trade.auctionBidUnsettleableBadge,
        "trade.auctionSettleButton": trade.auctionSettleButton,
        "trade.auctionSettleConfirmButton": trade.auctionSettleConfirmButton,
        "trade.auctionCancelButton": trade.auctionCancelButton,
        "trade.myAuctionsRoleSelling": trade.myAuctionsRoleSelling,
        "trade.myAuctionsSettleLink": trade.myAuctionsSettleLink,
        "trade.myTradesUnavailableBadge": trade.myTradesUnavailableBadge,
        "tradeSettings.title": messages.tradeSettings.title,
        "tradeSettings.form.tradeEnabled": messages.tradeSettings.form.tradeEnabled,
        "tradeSettings.form.crossChannelEnabled": messages.tradeSettings.form.crossChannelEnabled,
        "accountPage.collectionSharing.title": messages.accountPage.collectionSharing.title,
        "header.userSettings": messages.header.userSettings,
        "navigation.cardManagement": messages.navigation.cardManagement,
        "navigation.collection": messages.navigation.collection,
        "cardManager.editCard": messages.cardManager.editCard,
        "cardManager.form.tradeWantable": messages.cardManager.form.tradeWantable,
        "cardVisibilitySettings.title": messages.cardVisibilitySettings.title,
        "cardVisibilitySettings.form.showUnowned": messages.cardVisibilitySettings.form.showUnowned,
        "cardVisibilitySettings.form.showDetails": messages.cardVisibilitySettings.form.showDetails,
        // 取引が失敗したときに画面へ出る文言（FAQ の見出しとして引用している）
        "trade.errorTradeDisabled": trade.errorTradeDisabled,
        "trade.errorTradeOfferedCardInactive": trade.errorTradeOfferedCardInactive,
        "trade.errorTradeAlreadyCompletedOrInvalid": trade.errorTradeAlreadyCompletedOrInvalid,
        "trade.errorTradeAuctionExpired": trade.errorTradeAuctionExpired,
        "trade.errorTradeAuctionBidLocked": trade.errorTradeAuctionBidLocked,
        "trade.errorTradeCardAlreadyListed": trade.errorTradeCardAlreadyListed,
        "trade.errorTradeWantedCardNotWantable": trade.errorTradeWantedCardNotWantable,
      };
      for (const [path, label] of Object.entries(labels)) {
        // エラー文言は文末の句点だけ落として引用しているため正規化して比較する。
        // JSON.stringify は " を \" にエスケープするため、比較側も同じ形に揃える。
        const escaped = JSON.stringify(label.replace(/[。.]$/, "")).slice(1, -1);
        expect(everything, `${name}: ${path} = ${label}`).toContain(escaped);
      }
    }
  });

  it("states the limits with the same numbers the code enforces", () => {
    // 数値は推測で書かない。コード側の定数と、ガイドの文言を突き合わせる
    // （定数を変えたのに文言が古いまま残る、を検出する）。
    // 各数値の根拠（ファイル:行）は PR の対応表を参照。
    const tradeSource = readSource("src/lib/trade.ts");
    const auctionSource = readSource("src/lib/trade-auction.ts");
    expect(tradeSource).toMatch(/export const TRADE_MAX_OPEN_OFFERS = 10;/);
    expect(tradeSource).toMatch(/export const TRADE_MAX_WANTED_QUANTITY = 10;/);
    expect(auctionSource).toMatch(/TRADE_AUCTION_DURATIONS_HOURS = \[24, 72, 168\] as const;/);
    expect(auctionSource).toMatch(/TRADE_AUCTION_SELECTION_HOURS = 72;/);
    expect(auctionSource).toMatch(/TRADE_MAX_ACTIVE_BIDS = 10;/);
    expect(auctionSource).toMatch(/TRADE_MAX_BID_QUANTITY = 10;/);

    const { ja, en } = {
      ja: jaMessages.tradeGuidePage,
      en: enMessages.tradeGuidePage,
    };
    // 出品数の上限（通常出品とオークション合計）
    expect(ja.offer.limit.description).toContain("最大10件");
    expect(en.offer.limit.description).toContain("up to 10 listings");
    // 欲しい枚数 1〜10 / 入札 1〜10枚
    expect(ja.offer.quantity.description).toContain("1〜10枚");
    expect(en.offer.quantity.description).toContain("1 to 10");
    expect(ja.auction.bid.point1).toContain("1〜10枚");
    expect(en.auction.bid.point1).toContain("1 to 10");
    // 期限 24時間/3日/7日、選択期限72時間
    expect(ja.auction.create.substep3).toContain("24時間");
    expect(ja.auction.create.substep3).toContain("3日");
    expect(ja.auction.create.substep3).toContain("7日");
    expect(en.auction.create.substep3).toContain("24 hours");
    expect(en.auction.create.substep3).toContain("3 days");
    expect(en.auction.create.substep3).toContain("7 days");
    expect(ja.auction.select.description).toContain("72時間");
    expect(en.auction.select.description).toContain("72 hours");
    // 有効な入札の上限
    expect(ja.auction.limits.point2).toContain("最大10件");
    expect(en.auction.limits.point2).toContain("up to 10 active bids");
  });

  it("is linked only from the trade screens, not from /guide or the public footer", () => {
    // 本番ではトレード入口がまだ非表示のため、一般向けの導線には出さない
    expect(readSource("src/app/guide/page.tsx")).not.toContain("/guide/trade");
    expect(readSource("src/app/usages/page.tsx")).not.toContain("/guide/trade");
    expect(readSource("src/components/PublicFooter.tsx")).not.toContain("/guide/trade");
    expect(readSource("src/app/page.tsx")).not.toContain("/guide/trade");

    const layout = readSource("src/app/trade/layout.tsx");
    expect(layout).toContain('href="/guide/trade"');
    expect(layout).toContain('getTranslations("tradeGuidePage")');
    for (const { name, messages } of locales) {
      expect(messages.tradeGuidePage.entryLink, name).toBeTruthy();
    }
  });
});
