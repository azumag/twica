/**
 * Storage URL Utility Functions
 * ストレージURLの判定ヘルパー関数
 *
 * R2とVercel Blobの両方をサポートするための共通ユーティリティ
 */

import { sha256Prefix } from './crypto-utils';
import { getR2PublicUrl } from './r2-client';

/**
 * URLがR2のURLかどうかを判定
 *
 * 判定は `R2_PUBLIC_URL` の origin との完全一致のみで行う (#830)。
 *
 * 旧実装は `url.includes('.r2.dev')` / `url.startsWith(r2PublicUrl)` という
 * 部分一致だったため、`https://attacker.r2.dev/<被害者のキー>` や
 * `https://<R2_PUBLIC_URLのホスト>.evil.example/...` のような外部URLでも true を
 * 返した。削除処理 (`deleteFromR2`) は URL のホストに関係なく常に自バケットの
 * `R2_IMAGES` バインディングへ発行されるため、これは「自バケット内の任意キーを
 * 指定できる」ことを意味していた。
 *
 * `R2_PUBLIC_URL` はバケット直下を指す前提（`uploadToR2` が
 * `${publicUrl}/${fileName}` を組み立て、`getR2KeyFromUrl` が pathname を
 * そのままキーとして扱う）なので、origin 一致で必要十分。
 *
 * 運用上の注意: 保存済みURLは組み立て時点の `R2_PUBLIC_URL` を含むため、
 * ドメインを付け替える場合は `cards.image_url` / `blob_files.url` のデータ移行が
 * 必須。移行しないと既存URLはすべて「ストレージ外」と判定され、カードの
 * 差し替え・削除時のクリーンアップが警告も出さずスキップされる（R2オブジェクトと
 * 使用量カウンタがリークする）。
 *
 * @param url - チェックするURL
 * @returns R2のURLの場合はtrue
 */
export function isR2Url(url: string): boolean {
  if (!url) return false;

  let base: URL;
  try {
    base = new URL(getR2PublicUrl());
  } catch {
    // R2_PUBLIC_URL が未設定/不正な環境では「R2ではない」と判定する（fail-closed）
    return false;
  }

  try {
    return new URL(url).origin === base.origin;
  } catch {
    return false;
  }
}

/**
 * URLがVercel BlobのURLかどうかを判定
 *
 * `includes()` だとクエリ文字列やパスに文字列を仕込むだけで一致してしまうため、
 * ホスト名で判定する (#830 / isR2Url と同種の修正)。
 *
 * @param url - チェックするURL
 * @returns Vercel BlobのURLの場合はtrue
 */
export function isVercelBlobUrl(url: string): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    // `public.blob.vercel-storage.com` などのサブドメインもサフィックスで一致する
    return hostname === 'blob.vercel-storage.com' ||
           hostname.endsWith('.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

/**
 * URLがストレージURL（R2またはVercel Blob）かどうかを判定
 * @param url - チェックするURL
 * @returns ストレージURLの場合はtrue
 */
export function isStorageUrl(url: string): boolean {
  return isR2Url(url) || isVercelBlobUrl(url);
}

/**
 * R2 URLからキー（ファイル名）を抽出
 * @param url - R2のURL
 * @returns ファイル名（キー）、または抽出できない場合はnull
 */
export function getR2KeyFromUrl(url: string): string | null {
  if (!url) return null;

  try {
    const urlObj = new URL(url);
    // パスから先頭の '/' を除去してキーを取得
    const key = urlObj.pathname.slice(1);
    return key || null;
  } catch {
    // URLのパースに失敗した場合
    return null;
  }
}

/**
 * ストレージURLが指定ユーザーの所有物かを判定する (#830)
 *
 * アップロード経路 (`src/app/api/upload/route.ts`) が生成するキーは常に
 * `{sha256Prefix(twitchUserId)}_{uniqueSuffix}.{ext}` というフラットな形式で、
 * `blob_files.user_prefix` にも同じプレフィックスが記録される。よってキー先頭の
 * プレフィックスが所有者を一意に表す（効果音削除 `/api/upload/sound` と同じ判定）。
 *
 * 判定対象は「URLのファイル名」ではなく `getR2KeyFromUrl` が返すキーそのもの。
 * ファイル名（最後のパスセグメント）だけを見ると
 * `victim-dir/{自分のprefix}_x.png` のようなネストキーで
 * 「検証した対象」と「削除される対象」がずれるため。
 *
 * 既知の限界: プレフィックスは sha256 の先頭8hex（2^32空間）なので、ユーザー数が
 * 十分に増えれば誕生日衝突でプレフィックスを共有するユーザー同士が現れうる。
 * 攻撃者は自分の Twitch ID を選べないため能動的な衝突は作れず、効果音削除
 * (`/api/upload/sound`) や `blob_files.user_prefix` も同じ前提で運用されている。
 * 規模が変わったら `blob_files.user_prefix` の逆引きへ切り替えること。
 *
 * @param url - ストレージURL
 * @param twitchUserId - 所有者として検証するTwitchユーザーID
 * @returns 自分の所有物であればtrue
 */
export async function isOwnedStorageUrl(url: string, twitchUserId: string): Promise<boolean> {
  const key = getR2KeyFromUrl(url);
  if (!key) return false;

  // アップロード経路が生成するキーは常にフラット。'/' を含むキーは
  // 自分のプレフィックス配下と断定できないため拒否する。
  if (key.includes('/')) return false;

  const userPrefix = await sha256Prefix(twitchUserId);
  return key.startsWith(`${userPrefix}_`);
}

/**
 * 画像URLをカードなどに紐付けてよいかを判定する (#830)
 *
 * 他人のストレージURLを自分のカードに設定できると、以降の画像差し替えや
 * カード削除の「旧画像クリーンアップ」で他人のオブジェクトが削除されるため、
 * 入口の時点で弾く。ストレージ外のURL（Twitchエモート等の外部CDN）は
 * `validateImageUrl` の担当なのでここでは許可する。
 *
 * @param imageUrl - 紐付けようとしている画像URL
 * @param twitchUserId - 紐付けを行うTwitchユーザーID
 * @returns 紐付けてよい場合はtrue
 */
export async function isAssignableImageUrl(imageUrl: unknown, twitchUserId: string): Promise<boolean> {
  // 未指定・空文字（画像なし）は対象外
  if (typeof imageUrl !== 'string' || imageUrl.trim() === '') return true;
  if (!isStorageUrl(imageUrl)) return true;
  return isOwnedStorageUrl(imageUrl, twitchUserId);
}
