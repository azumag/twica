/**
 * analysis 開発サーバーの bind 先を決める純関数群。
 *
 * この dev server は管理ダッシュボードの `/__admin` API をホストしており、
 * Node 側プロセスが `DASHBOARD_DATABASE_URL` で DB へ接続する。既定で
 * `host: true`（= 0.0.0.0 / :: へ bind）にすると、同一 LAN 上の第三者が
 * Vite 本体の既知脆弱性（例: GHSA-4w7w-66w2-5vf9 の .map パストラバーサル）
 * を通じて管理 PC のファイルや管理 API へ到達しうる。
 *
 * したがって既定は loopback とし、外部公開は「明示的に選択した場合だけ」許可する。
 * テストから直接呼べるよう、vite.config.ts 本体ではなくここへ切り出す。
 */

/** 外部公開を許可する意思表示に使う環境変数名。 */
export const ALLOW_EXTERNAL_KEY = 'TWICA_ANALYSIS_DEV_ALLOW_EXTERNAL'

/** 外部公開を許可する唯一の値。 */
export const ALLOW_EXTERNAL_VALUE = '1'

/**
 * 変数名に `VITE_` を付けない理由:
 * Vite は既定の `envPrefix`（`VITE_`）が付いた変数をクライアントの
 * `import.meta.env` へ露出する。サーバー bind のような Node 側専用の
 * 意思決定を `VITE_` で始めると、クライアントへ漏れる前提の命名と衝突し、
 * 「ブラウザから見える設定」という誤解を招くため。
 *
 * 値に `1` だけを許す理由:
 * `true`/`yes`/`on` のような揺れを許すと、「設定したつもりがない値」で
 * 公開に倒れる余地が増える。判定を1つの値に固定して fail-closed にする。
 * 先頭/末尾の空白だけは trim して許容する（シェルの `= 1` 等の事故を拾う）。
 */

export interface DevServerBinding {
  /** Vite の `server.host` に渡す値。 */
  host: string
  /** 外部公開で起動するか。呼び出し側の警告出力の判断に使う。 */
  external: boolean
  /**
   * 値を入れたが無効だった場合の警告文。有効/未設定なら null。
   * 「設定したのに効いていない」と誤解されると、かえって危険な回避策
   * （host を直接書き換える等）を招くため、明示的に警告する。
   */
  warning: string | null
}

/**
 * 環境変数の値から bind 先を解決する。
 *
 * - 未設定/空文字 → loopback（既定）
 * - `1`        → 外部公開
 * - それ以外     → loopback + 警告（fail-closed）
 */
export function resolveDevServerBinding(
  env: Record<string, string | undefined>,
): DevServerBinding {
  const raw = env[ALLOW_EXTERNAL_KEY]?.trim()

  if (raw === ALLOW_EXTERNAL_VALUE) {
    return { host: '0.0.0.0', external: true, warning: null }
  }

  if (raw) {
    return {
      host: '127.0.0.1',
      external: false,
      warning:
        `${ALLOW_EXTERNAL_KEY} は '${ALLOW_EXTERNAL_VALUE}' のみ有効です` +
        `（受領値: ${JSON.stringify(raw)}）。dev server は loopback のまま起動します。`,
    }
  }

  return { host: '127.0.0.1', external: false, warning: null }
}

/** Vite の `server` オプションのうち、本モジュールが決定する部分。 */
export interface DevServerOptions {
  port: number
  host: string
}

/** 開発サーバーの待受ポート。 */
export const DEV_SERVER_PORT = 5173

/**
 * bind 解決結果から Vite の `server` オプションを組み立てる。
 *
 * `server.allowedHosts` は **設定しない**。Vite は IP リテラルと
 * `localhost` を常に許可し、それ以外のホスト名だけを `allowedHosts` で判定する
 * （`isHostAllowedInternal`）。したがって未設定のままでも LAN の IP 直指定では
 * 到達でき、`allowedHosts: true` を指定した場合にだけ Host 検証が丸ごと
 * 無効化されて DNS rebinding（攻撃者ドメインを管理 PC の LAN IP へ再解決）が
 * 成立する。外部公開の用途は IP 直指定で足りるため、ここでは設定しない。
 */
export function toServerOptions(binding: DevServerBinding): DevServerOptions {
  return { port: DEV_SERVER_PORT, host: binding.host }
}
