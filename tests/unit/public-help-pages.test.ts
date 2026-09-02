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

    for (const scope of ["guidePage", "faqPage", "usagesPage", "channelPointsAccess"] as const) {
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
