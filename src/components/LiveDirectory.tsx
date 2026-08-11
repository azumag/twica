"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { LiveDirectoryEntry } from "@/lib/live-directory";

export type LiveDirectorySort =
  | "recentlyStarted"
  | "cardCount"
  | "redemptionCount";

interface LiveDirectoryProps {
  entries: LiveDirectoryEntry[];
  /**
   * Server Component で確定した描画時刻。
   * Client Component 内で Date.now() を呼ぶとSSRとhydrationの分境界で表示が変わり、
   * hydration mismatch が起こり得るため、配信経過時間の基準をシリアライズして渡す。
   */
  referenceTime: string;
}

function compareFallback(a: LiveDirectoryEntry, b: LiveDirectoryEntry): number {
  // 視聴者数は変動が大きく、利用者が選択していない順位付けを同率時だけ
  // 暗黙に行うと表示順の意図が分かりにくい。安定した識別情報だけを使い、
  // SSRとクライアントで同じ決定的な順序に固定する。
  // localeCompare() の既定ロケールも実行環境で異なり得るため使わない。
  if (a.displayName !== b.displayName) return a.displayName < b.displayName ? -1 : 1;
  if (a.streamerId !== b.streamerId) return a.streamerId < b.streamerId ? -1 : 1;
  return 0;
}

function compareStartedAt(a: LiveDirectoryEntry, b: LiveDirectoryEntry): number {
  const aTime = Date.parse(a.startedAt);
  const bTime = Date.parse(b.startedAt);
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);

  // Helix はRFC3339を返すが、境界値が混入しても comparator が NaN を返さず、
  // 不正値だけを末尾へ送る。NaN comparator はブラウザごとの並びを不定にするため避ける。
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && bValid && aTime !== bTime) return bTime - aTime;
  return compareFallback(a, b);
}

function compareStats(
  a: LiveDirectoryEntry,
  b: LiveDirectoryEntry,
  key: "cardCount" | "redemptionCount",
): number {
  // null（統計非公開）と公開値0は意味が異なる。0への丸め込みで公開範囲を
  // 誤認させず、非公開者は数値に関係なく常に末尾へ置く。
  if (a.stats === null && b.stats !== null) return 1;
  if (a.stats !== null && b.stats === null) return -1;
  if (a.stats !== null && b.stats !== null) {
    const difference = b.stats[key] - a.stats[key];
    if (difference !== 0) return difference;
  }
  return compareFallback(a, b);
}

/**
 * 受け取った配列を変更せず、選択された基準で決定的に並べ替える。
 * tie-break を固定し、KVの返却順やJavaScript実装差でカードが再描画ごとに
 * 入れ替わるのを防ぐ。
 */
export function sortLiveDirectoryEntries(
  entries: readonly LiveDirectoryEntry[],
  sort: LiveDirectorySort,
): LiveDirectoryEntry[] {
  return [...entries].sort((a, b) => {
    switch (sort) {
      case "recentlyStarted":
        return compareStartedAt(a, b);
      case "cardCount":
        return compareStats(a, b, "cardCount");
      case "redemptionCount":
        return compareStats(a, b, "redemptionCount");
      default:
        return compareStartedAt(a, b);
    }
  });
}

export default function LiveDirectory({ entries, referenceTime }: LiveDirectoryProps) {
  const t = useTranslations("livePage");
  const [sort, setSort] = useState<LiveDirectorySort>("recentlyStarted");
  const sortedEntries = useMemo(
    () => sortLiveDirectoryEntries(entries, sort),
    [entries, sort],
  );

  return (
    <section aria-labelledby="live-directory-heading">
      <h2 id="live-directory-heading" className="sr-only">
        {t("directoryHeading")}
      </h2>

      <div className="mb-6 flex justify-end">
        <div className="flex w-full items-center gap-3 sm:w-auto">
          <label htmlFor="live-directory-sort" className="shrink-0 text-sm text-gray-300">
            {t("sort.label")}
          </label>
          <select
            id="live-directory-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as LiveDirectorySort)}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:border-purple-400 focus:ring-2 focus:ring-purple-400/30 sm:min-w-64"
          >
            <option value="recentlyStarted">{t("sort.recentlyStarted")}</option>
            <option value="cardCount">{t("sort.cardCount")}</option>
            <option value="redemptionCount">{t("sort.redemptionCount")}</option>
          </select>
        </div>
      </div>

      {sortedEntries.length === 0 ? (
        <div className="border-y border-gray-800 py-16 text-center">
          <h3 className="text-xl font-semibold text-white">{t("empty.title")}</h3>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-gray-400">
            {t("empty.description")}
          </p>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {sortedEntries.map((entry) => (
            <LiveDirectoryCard
              key={entry.streamerId}
              entry={entry}
              referenceTime={referenceTime}
            />
          ))}
        </div>
      )}

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
        {entry.stats ? (
          <dl className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <dt className="min-h-10 break-words text-xs leading-5 text-gray-400">
                {t("stats.cardCount")}
              </dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums text-emerald-300">
                {t("stats.value", { count: entry.stats.cardCount })}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="min-h-10 break-words text-xs leading-5 text-gray-400">
                {t("stats.redemptionCount")}
              </dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums text-amber-300">
                {t("stats.value", { count: entry.stats.redemptionCount })}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="flex min-h-[4.5rem] items-center text-sm text-gray-500">
            {t("stats.private")}
          </p>
        )}

        <Link
          href={`/collection/${encodeURIComponent(entry.streamerId)}`}
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
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
