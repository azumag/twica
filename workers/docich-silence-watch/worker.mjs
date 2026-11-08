// docich-silence-watch — azumag/docich#3509 段階1（GitHub Actions 版との並行稼働）
//
// 目的:
//   azumag/docich の GitHub Actions が「実行ゼロ（無音）」になった事象を、
//   GitHub の外（Cloudflare Workers Cron Trigger）から定期観測して Discord へ
//   通知する dead man's switch。GitHub Actions 全体障害では GitHub 側の
//   watchdog（.github/workflows/docich-actions-silence-watch.yml）は自壊
//   しうるため、その backstop として本 Worker をプラットフォーム外に置く。
//   検知ロジックは GitHub Actions 版と完全に同一で、段階1は並行稼働で検証
//   する（48h 安定後の段階2で GitHub 側の通知停止を別 PR で検討）。
//
// 検知ロジック（.github/workflows/docich-actions-silence-watch.yml と同一）:
//   - 対象 azumag/docich と control（azumag/twica, azumag/soviet_now）の
//     最新 run created_at と pushed_at を GitHub REST API から読む。
//   - 無音判定 = 最新 run から SILENCE_MS（2時間）超過 かつ pushed_at が
//     同期間内（活動はあるのに run が無い）。活動が無い静寂期間の誤報を防ぐ。
//   - 自動切り分け = docich のみ無音なら repo-specific（リポジトリ固有の
//     無効化/enforcement/イベント配送不全の疑い）、control も無音なら
//     platform-suspect（プラットフォーム部分障害の疑い）。
//
// 通知・頻度制御:
//   - 通知先は GitHub 版と同じ Discord webhook（secret DISCORD_WEBHOOK_URL）。
//   - 無音継続中のスパム防止に、最終送信時刻を KV（binding SILENCE_KV、
//     key "last_alert_at"）へ記録し SUPPRESS_MS（55分）以内の送信を抑制。
//     GitHub 版は commit status を anchor に使ったが、本 Worker は GitHub への
//     書き込みを持たないため KV を使う（GitHub API 障害時でも抑制が効く利点）。
//   - Cron 実行の成否は Workers Observability / run ログで追跡する。
//
// GitHub API 認証（DSH 要求の明記）:
//   - 対象3リポジトリは全て public のため読み取りは認証不要で動く
//     （anonymous 60 req/h/IP。本 Worker の呼び出しは 6 req/回×2回/h=12 req/h
//     で十分）。ただし Workers の egress IP は共有のため匿名レートに依存し
//     たくない場合は、secret GITHUB_READ_TOKEN に Actions:read 権限だけの
//     fine-grained PAT を設定する（未設定なら匿名にフォールバック）。
//
// 既知の限界:
//   - GitHub API 自体が死んでいる間は観測不能（fetch エラー→観測不能として
//     ログに残し、誤アラートは出さない）。
//   - Cloudflare 側の障害では自壊する（多重度の限界）。
//
// 手動確認用 fetch:
//   - GET /observe : Discord 送信・KV 更新を伴わない dry-run 観測結果を
//     JSON で返す（疎通確認・検証用。読み取り専用）。

const TARGET = "azumag/docich";
const CONTROLS = ["azumag/twica", "azumag/soviet_now"];
const SILENCE_MS = 2 * 60 * 60 * 1000; // 2 時間
const SUPPRESS_MS = 55 * 60 * 1000; // 55 分（GitHub 版と同じ抑制窓）
const KV_ALERT_KEY = "last_alert_at";
const KV_RECOVERED_KEY = "last_recovered_at";
const API_VERSION = "2026-03-10";

function parseTs(value) {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
}

// repo の観測結果から無音判定する純粋関数（テスト容易化のため分離）。
export function judgeSilent({ runAgeMs, pushAgeMs }, silenceMs = SILENCE_MS) {
  return (runAgeMs === null || runAgeMs > silenceMs) &&
    pushAgeMs !== null && pushAgeMs < silenceMs;
}

// 観測値の集合からアラート判定と切り分けを行う純粋関数。
export function classify(observations) {
  const target = observations[0];
  const silentControls = observations.slice(1).filter((o) => o.silent);
  if (!target.silent) return { alert: false, classification: "none" };
  if (silentControls.length > 0) {
    return {
      alert: true,
      classification:
        `platform-suspect: control 側にも無音あり (${silentControls.map((o) => o.repo).join(", ")})。` +
        "GitHub Actions プラットフォームの部分障害の可能性",
    };
  }
  return {
    alert: true,
    classification:
      "repo-specific: 監視対象のみ無音で control は正常。" +
      "リポジトリ固有の Actions 無効化 / enforcement / イベント配送不全の可能性",
  };
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "docich-silence-watch",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghJson(env, path) {
  // 認証付きで試し、401/403/404 なら匿名へフォールバック（公開情報のため）。
  const token = env.GITHUB_READ_TOKEN || "";
  for (const useToken of [true, false]) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: githubHeaders(useToken ? token : ""),
    });
    if (res.ok) return res.json();
    if (!(useToken && [401, 403, 404].includes(res.status))) {
      throw new Error(`github_api_${res.status}`);
    }
  }
}

async function observeRepo(env, repo, nowMs) {
  // 最新 run と pushed_at を読む。run が無ければ runAgeMs=null（無限大）。
  const runs = await ghJson(env, `/repos/${repo}/actions/runs?per_page=1`);
  const info = await ghJson(env, `/repos/${repo}`);
  const lastRunAt = parseTs(runs?.workflow_runs?.[0]?.created_at);
  const pushedAt = parseTs(info?.pushed_at);
  const runAgeMs = lastRunAt === null ? null : nowMs - lastRunAt;
  const pushAgeMs = pushedAt === null ? null : nowMs - pushedAt;
  const obs = {
    repo,
    last_run_at: lastRunAt === null ? null : new Date(lastRunAt).toISOString(),
    run_age_seconds: runAgeMs === null ? null : Math.trunc(runAgeMs / 1000),
    pushed_at: pushedAt === null ? null : new Date(pushedAt).toISOString(),
    push_age_seconds: pushAgeMs === null ? null : Math.trunc(pushAgeMs / 1000),
  };
  obs.silent = judgeSilent(obs);
  return obs;
}

function buildLines(observations, thresholdSec) {
  const fmt = (s) => (s === null ? "なし" : `${s} 秒`);
  const lines = observations.map(
    (o) =>
      `- ${o.repo}: 最新 run ${o.last_run_at || "記録なし"}（経過 ${fmt(o.run_age_seconds)}）` +
      ` / pushed_at ${o.pushed_at || "不明"}（経過 ${fmt(o.push_age_seconds)}）` +
      ` → ${o.silent ? "無音" : "正常"}`,
  );
  lines.push(`閾値: ${thresholdSec} 秒（無音判定には同期間内の push も必須）`);
  return lines;
}

function buildAlertMessage(observations, classification) {
  return [
    "⚠️ [GitHub Actions 無音検知] docich の workflow run が閾値を超えて記録されていません (workers-cron)",
    `切り分け: ${classification}`,
    "参照: azumag/docich#3509（Actions 無音事象の原因調査）",
    ...buildLines(observations, SILENCE_MS / 1000),
    "対応手順: docs/actions-silence-watch.md",
  ].join("\n");
}

async function sendDiscord(env, content) {
  // webhook URL は secret のみ。本文は観測値（公開情報）のみで機密を含まない。
  if (!env.DISCORD_WEBHOOK_URL) throw new Error("discord_webhook_not_configured");
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`discord_${res.status}`);
}

// 抑制判定を純粋関数として分離（テスト容易化）。
// last_alert が窓内でも、その後に recovered が記録されていれば抑制しない
// （GitHub 版の recovered status anchor に相当）。一度復帰した後の再発は
// 連続した同一障害ではなく新しい事象として扱い、即座に通知すべきため。
export function shouldSuppress(lastAlertAt, lastRecoveredAt, nowMs, suppressMs = SUPPRESS_MS) {
  if (lastAlertAt === null || nowMs - lastAlertAt >= suppressMs) return false;
  return lastRecoveredAt === null || lastRecoveredAt <= lastAlertAt;
}

// cron 本体。観測→判定→（抑制窓を見て）Discord 送信→最終送信時刻を KV 記録。
// 観測不能（API エラー）は誤アラートを出さずにログへ残す。
// KV 読み取り失敗は「送信する」側に倒す fail-open 設計: 監視系が自身の状態
// ストア故障で黙る方が重複通知より害が大きいため（DSH レビュー指摘）。
async function runWatch(env) {
  const nowMs = Date.now();
  const observations = [];
  for (const repo of [TARGET, ...CONTROLS]) {
    observations.push(await observeRepo(env, repo, nowMs));
  }
  const { alert, classification } = classify(observations);
  console.log(JSON.stringify({ alert, classification, observations }));

  if (!alert) {
    // 正常時は recovered マーカーを記録し、直前アラートとの新旧比較に使う。
    // KV 書き込み失敗は観測結果に影響しないためログに留める。
    try {
      await env.SILENCE_KV.put(KV_RECOVERED_KEY, new Date(nowMs).toISOString());
    } catch (error) {
      console.log(`kv_recovered_put_failed: ${error?.message || error}`);
    }
    return { alert: false, sent: false, observations };
  }

  let lastAlertAt = null;
  let lastRecoveredAt = null;
  try {
    lastAlertAt = parseTs(await env.SILENCE_KV.get(KV_ALERT_KEY));
    lastRecoveredAt = parseTs(await env.SILENCE_KV.get(KV_RECOVERED_KEY));
  } catch (error) {
    // fail-open: KV 読み取りに失敗したら抑制せず送信する。
    console.log(`kv_get_failed_failing_open: ${error?.message || error}`);
  }
  if (shouldSuppress(lastAlertAt, lastRecoveredAt, nowMs)) {
    console.log("suppressed: within the 55-minute suppression window");
    return { alert: true, sent: false, suppressed: true, observations };
  }
  await sendDiscord(env, buildAlertMessage(observations, classification));
  // 送信成功後にだけ anchor を記録する（送信失敗では黙らせない）。
  // put 失敗は次回の重複送信を招くだけで今回の通知は済んでいるためログに留める。
  try {
    await env.SILENCE_KV.put(KV_ALERT_KEY, new Date(nowMs).toISOString());
  } catch (error) {
    console.log(`kv_alert_put_failed: ${error?.message || error}`);
  }
  return { alert: true, sent: true, observations };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runWatch(env).catch((error) =>
        console.log(`observe_failed: ${error?.message || error}`),
      ),
    );
  },

  // 手動確認用の dry-run。送信・KV 更新を伴わず観測値だけ返す。
  async fetch(_request, env) {
    try {
      const nowMs = Date.now();
      const observations = [];
      for (const repo of [TARGET, ...CONTROLS]) {
        observations.push(await observeRepo(env, repo, nowMs));
      }
      const { alert, classification } = classify(observations);
      return Response.json({ alert, classification, observations });
    } catch (error) {
      return Response.json(
        { error: `observe_failed: ${error?.message || error}` },
        { status: 502 },
      );
    }
  },
};
