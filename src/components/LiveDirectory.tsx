"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import type {
  LiveDirectoryEntry,
  LiveDirectoryRankingEntry,
} from "@/lib/live-directory";

export type LiveDirectoryView =
  | "recentlyStarted"
  | "redemptionCount"
  | "totalPoints"
  | "cardCount";
export type LiveDirectoryRankingMetric = Exclude<
  LiveDirectoryView,
  "recentlyStarted"
>;

interface LiveDirectoryProps {
  entries: LiveDirectoryEntry[];
  rankings: LiveDirectoryRankingEntry[];
  /**
   * Server Component で確定した描画時刻。
   * Client Component 内で Date.now() を呼ぶとSSRとhydrationの分境界で表示が変わり、
   * hydration mismatch が起こり得るため、配信経過時間の基準をシリアライズして渡す。
   */
  referenceTime: string;
}

const VIEWS: ReadonlyArray<{
  id: LiveDirectoryView;
  labelKey:
    | "tabs.recentlyStarted"
    | "tabs.redemptionCount"
    | "tabs.totalPoints"
    | "tabs.cardCount";
}> = [
  { id: "recentlyStarted", labelKey: "tabs.recentlyStarted" },
  { id: "redemptionCount", labelKey: "tabs.redemptionCount" },
  { id: "totalPoints", labelKey: "tabs.totalPoints" },
  { id: "cardCount", labelKey: "tabs.cardCount" },
];

function compareFallback(a: LiveDirectoryEntry, b: LiveDirectoryEntry): number {
  // 視聴者数は変動が大きく、利用者が選択していない順位付けを同率時だけ
  // 暗黙に行うと表示順の意図が分かりにくい。安定した識別情報だけを使い、
  // SSRとクライアントで同じ決定的な順序に固定する。
  // localeCompare() の既定ロケールも実行環境で異なり得るため使わない。
  if (a.displayName !== b.displayName) return a.displayName < b.displayName ? -1 : 1;
  if (a.streamerId !== b.streamerId) return a.streamerId < b.streamerId ? -1 : 1;
  return 0;
}

/** ライブカードを入力非破壊で開始日時の新しい順に並べる。 */
export function sortLiveDirectoryEntries(
  entries: readonly LiveDirectoryEntry[],
): LiveDirectoryEntry[] {
  return [...entries].sort((a, b) => {
    const aTime = Date.parse(a.startedAt);
    const bTime = Date.parse(b.startedAt);
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);

    // Helix はRFC3339を返すが、境界値が混入しても comparator が NaN を返さず、
    // 不正値だけを末尾へ送る。NaN comparator はブラウザごとの並びを不定にする。
    if (aValid !== bValid) return aValid ? -1 : 1;
    if (aValid && bValid && aTime !== bTime) return bTime - aTime;
    return compareFallback(a, b);
  });
}

/**
 * ランキングを入力非破壊で降順にする。
 *
 * 同値は同順位として表示するため、比較に別の数値指標を混ぜない。公開identity同士は
 * 表示名で安定化し、匿名同士はRPCの決定的な入力順をstable sortで保つ。内部IDを
 * クライアントへ渡してtie-breakに使うことは匿名化の目的を壊すため行わない。
 */
export function sortLiveDirectoryRankings(
  entries: readonly LiveDirectoryRankingEntry[],
  metric: LiveDirectoryRankingMetric,
): LiveDirectoryRankingEntry[] {
  return [...entries].sort((a, b) => {
    const difference = b[metric] - a[metric];
    if (difference !== 0) return difference;

    if (a.identity && b.identity) {
      if (a.identity.displayName !== b.identity.displayName) {
        return a.identity.displayName < b.identity.displayName ? -1 : 1;
      }
      if (a.identity.streamerId !== b.identity.streamerId) {
        return a.identity.streamerId < b.identity.streamerId ? -1 : 1;
      }
    }
    if (a.identity !== null && b.identity === null) return -1;
    if (a.identity === null && b.identity !== null) return 1;
    return 0;
  });
}

/** 1, 2, 2, 4 形式で、同じ集計値には同順位を割り当てる。 */
export function getCompetitionRanks(
  entries: readonly LiveDirectoryRankingEntry[],
  metric: LiveDirectoryRankingMetric,
): number[] {
  let previousValue: number | null = null;
  let previousRank = 0;

  return entries.map((entry, index) => {
    const value = entry[metric];
    if (previousValue === null || value !== previousValue) {
      previousRank = index + 1;
      previousValue = value;
    }
    return previousRank;
  });
}

export default function LiveDirectory({
  entries,
  rankings,
  referenceTime,
}: LiveDirectoryProps) {
  const t = useTranslations("livePage");
  const [view, setView] = useState<LiveDirectoryView>("recentlyStarted");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const sortedEntries = useMemo(() => sortLiveDirectoryEntries(entries), [entries]);

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % VIEWS.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + VIEWS.length) % VIEWS.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = VIEWS.length - 1;
    if (nextIndex === null) return;

    // WAI-ARIA Tabs Patternの自動アクティベーション。全パネルはローカルデータから
    // 即時描画できるため、矢印移動と選択を同時に行っても遅延を生まない。
    event.preventDefault();
    setView(VIEWS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <section aria-labelledby="live-directory-heading">
      <h2 id="live-directory-heading" className="sr-only">
        {t("directoryHeading")}
      </h2>

      <div className="mb-8 overflow-x-auto border-b border-gray-700">
        <div
          role="tablist"
          aria-label={t("tabs.label")}
          className="flex min-w-max"
        >
          {VIEWS.map((item, index) => {
            const selected = view === item.id;
            return (
              <button
                key={item.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                id={`live-directory-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="live-directory-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => setView(item.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className={`min-h-11 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-purple-400 sm:px-5 ${
                  selected
                    ? "border-purple-400 text-white"
                    : "border-transparent text-gray-400 hover:border-gray-500 hover:text-gray-200"
                }`}
              >
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      <div
        id="live-directory-panel"
        role="tabpanel"
        aria-labelledby={`live-directory-tab-${view}`}
        tabIndex={0}
        className="outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
      >
        {view === "recentlyStarted" ? (
          <LiveStreamGrid entries={sortedEntries} referenceTime={referenceTime} />
        ) : (
          <LiveDirectoryRanking entries={rankings} metric={view} />
        )}
      </div>

      <div className="mt-10 border-t border-gray-800 pt-8 text-center">
        <p className="text-sm text-gray-400">{t("listingCta.lead")}</p>
        <Link
          href="/dashboard/settings"
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg border border-purple-500 px-5 py-2 text-sm font-medium text-purple-300 transition hover:bg-purple-500/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
        >
          {t("listingCta.link")}
        </Link>
      </div>
    </section>
  );
}

function LiveStreamGrid({
  entries,
  referenceTime,
}: {
  entries: LiveDirectoryEntry[];
  referenceTime: string;
}) {
  const t = useTranslations("livePage");

  if (entries.length === 0) {
    return (
      <div className="border-y border-gray-800 py-16 text-center">
        <h3 className="text-xl font-semibold text-white">{t("empty.title")}</h3>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-gray-400">
          {t("empty.description")}
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((entry) => (
        <LiveDirectoryCard
          key={entry.streamerId}
          entry={entry}
          referenceTime={referenceTime}
        />
      ))}
    </div>
  );
}

function LiveDirectoryRanking({
  entries,
  metric,
}: {
  entries: LiveDirectoryRankingEntry[];
  metric: LiveDirectoryRankingMetric;
}) {
  const t = useTranslations("livePage");
  const sorted = useMemo(
    () => sortLiveDirectoryRankings(entries, metric),
    [entries, metric],
  );
  const ranks = useMemo(() => getCompetitionRanks(sorted, metric), [sorted, metric]);

  if (sorted.length === 0) {
    return (
      <p className="border-y border-gray-800 py-16 text-center text-sm text-gray-400">
        {t("ranking.empty")}
      </p>
    );
  }

  return (
    <ol className="divide-y divide-gray-800 border-y border-gray-800">
      {sorted.map((entry, index) => (
        <li
          key={entry.identity?.streamerId ?? `anonymous-${index}`}
          className="grid min-h-20 grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-3 py-3 sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:gap-4"
        >
          <span className="text-center text-lg font-semibold tabular-nums text-gray-300">
            {t("ranking.rank", { rank: ranks[index] })}
          </span>

          {entry.identity ? (
            <a
              href={`https://www.twitch.tv/${encodeURIComponent(entry.identity.twitchLogin)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex min-w-0 items-center gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              {entry.identity.profileImageUrl ? (
                <Image
                  src={entry.identity.profileImageUrl}
                  alt=""
                  width={40}
                  height={40}
                  className="h-10 w-10 shrink-0 rounded-full object-cover"
                  unoptimized
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-700 text-sm font-semibold text-gray-300"
                >
                  {entry.identity.displayName.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="min-w-0 truncate font-medium text-white group-hover:text-purple-200">
                {entry.identity.displayName}
              </span>
              <span className="sr-only">
                {t("ranking.channelLink", { name: entry.identity.displayName })}
              </span>
            </a>
          ) : (
            <span className="flex min-w-0 items-center gap-3 text-gray-400">
              <span
                aria-hidden="true"
                className="h-10 w-10 shrink-0 rounded-full bg-gray-800"
              />
              <span className="truncate font-medium">{t("ranking.anonymous")}</span>
            </span>
          )}

          <strong className="min-w-0 break-words text-right text-sm font-semibold tabular-nums text-emerald-300 sm:whitespace-nowrap sm:text-lg">
            {t(`ranking.${metric}`, { count: entry[metric] })}
          </strong>
        </li>
      ))}
    </ol>
  );
}

function LiveDirectoryCard({
  entry,
  referenceTime,
}: {
  entry: LiveDirectoryEntry;
  referenceTime: string;
}) {
  const t = useTranslations("livePage");
  const channelUrl = `https://www.twitch.tv/${encodeURIComponent(entry.twitchLogin)}`;
  const title = entry.title || t("card.untitled");
  const gameName = entry.gameName || t("card.uncategorized");
  const elapsed = formatElapsed(entry.startedAt, referenceTime, t);

  return (
    <article
      data-streamer-id={entry.streamerId}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-gray-700 bg-gray-800 shadow-sm transition hover:border-gray-600"
    >
      {/*
        主リンクとコレクション副リンクは兄弟要素にする。カード全体をLinkで包むと
        <a>が入れ子になり、クリック領域とスクリーンリーダーの解釈が壊れるため。
      */}
      <a
        href={channelUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="group block flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-purple-400"
      >
        <div className="relative aspect-video overflow-hidden bg-gray-950">
          {entry.thumbnailUrl ? (
            <Image
              src={entry.thumbnailUrl}
              alt={t("card.thumbnailAlt", { name: entry.displayName })}
              fill
              sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
              className="object-cover transition duration-200 group-hover:scale-[1.02]"
              // Twitchのframeは数分単位で更新される。Image最適化キャッシュで古いframeを
              // 長く保持せず、既存Twitch画像と同様に変換コストも発生させない。
              unoptimized
            />
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-gray-500">
              {t("card.thumbnailUnavailable")}
            </div>
          )}

          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded bg-red-600 px-2 py-1 text-xs font-bold text-white shadow">
            <span className="h-2 w-2 rounded-full bg-white" aria-hidden="true" />
            {t("card.live")}
          </span>
          <span className="absolute bottom-3 right-3 rounded bg-black/80 px-2 py-1 text-xs font-medium text-white shadow">
            {t("card.viewers", { count: entry.viewerCount })}
          </span>
        </div>

        <div className="p-4">
          <div className="flex min-w-0 items-center gap-3">
            {entry.profileImageUrl ? (
              <Image
                src={entry.profileImageUrl}
                alt={t("card.profileAlt", { name: entry.displayName })}
                width={40}
                height={40}
                className="h-10 w-10 shrink-0 rounded-full object-cover"
                unoptimized
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-700 text-sm font-semibold text-gray-300"
              >
                {entry.displayName.slice(0, 1).toUpperCase()}
              </span>
            )}
            <p className="min-w-0 flex-1 truncate font-semibold text-white">
              {entry.displayName}
              <span className="ml-1.5 text-gray-400" aria-hidden="true">
                ↗
              </span>
            </p>
          </div>

          <h3 className="mt-3 line-clamp-2 min-h-12 text-sm font-medium leading-6 text-gray-100">
            {title}
          </h3>
          <p className="mt-2 truncate text-sm text-cyan-300">
            {t("card.category", { name: gameName })}
          </p>
          <time dateTime={entry.startedAt} className="mt-1 block text-xs text-gray-400">
            {t("card.liveFor", { duration: elapsed })}
          </time>
        </div>
        {/* aria-label は子孫の可視情報をアクセシブル名から除外するため使わない。
            新規タブの補足だけを子要素として足し、配信タイトル等を支援技術へ残す。 */}
        <span className="sr-only">
          {t("card.watchOnTwitchNewTab", { name: entry.displayName })}
        </span>
      </a>

      <div className="border-t border-gray-700 p-4">
        <Link
          href={`/collection/${encodeURIComponent(entry.streamerId)}`}
          className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
        >
          {t("card.viewCollection")}
        </Link>
      </div>
    </article>
  );
}

function formatElapsed(
  startedAt: string,
  referenceTime: string,
  t: ReturnType<typeof useTranslations<"livePage">>,
): string {
  const start = Date.parse(startedAt);
  const reference = Date.parse(referenceTime);
  if (!Number.isFinite(start) || !Number.isFinite(reference)) {
    return t("duration.unknown");
  }

  const totalMinutes = Math.max(0, Math.floor((reference - start) / 60_000));
  if (totalMinutes === 0) return t("duration.justStarted");
  if (totalMinutes < 60) return t("duration.minutes", { minutes: totalMinutes });

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return t("duration.hours", { hours });
  return t("duration.hoursMinutes", { hours, minutes });
}
