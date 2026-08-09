/**
 * HEIC / HEIF 画像のクライアント側 JPEG 変換 / issue #770
 *
 * iPhone 等で撮影した画像は HEIC 形式になることがあるが、カード画像アップロードは
 * JPEG / PNG / GIF / WebP のみ許可している。HEIC を R2 に原形式で保存するのではなく、
 * ファイル選択直後にクライアント側で JPEG へ変換し、既存の画像サイズ取得・トリミング・
 * 圧縮・`/api/upload` 処理へ渡す方式をとる。
 *
 * この方式の利点:
 * - 保存形式は従来どおり JPEG となり、カード表示側・`/api/upload` の変更が不要
 * - サーバー（Cloudflare Workers）でネイティブ画像ライブラリを動かす必要がない
 * - 変換ライブラリ（heic-to）はCSP対応ビルドをHEIC選択時だけ動的 import し、
 *   通常アップロードの初期バンドルを増やさない
 *
 * 注意:
 * - HEIC は圧縮時のファイルサイズに比べデコード後のメモリ使用量が大きいため、
 *   変換前に専用の入力サイズ上限（HEIC_INPUT_MAX_BYTES）を設ける。
 * - HEIC コンテナに複数画像がある場合、初期対応では primary image のみを使用する。
 */
export const HEIC_INPUT_MAX_BYTES = 25 * 1024 * 1024; // 25MB（変換前の入力上限。デコード後のメモリ使用量は圧縮時サイズより大幅に増えるため、緩めの安全弁）

// heic-to の変換用 Worker を停止する Abort API は公開されていないため、
// 呼び出し側が無期限に待ち続けないよう、import とデコードを合わせた総時間に上限を設ける。
export const HEIC_CONVERSION_TIMEOUT_MS = 30_000;

// 変換処理の失敗種別（呼び出し側で Error.message を比較するための定数）
export const HEIC_ERROR_TOO_LARGE = "HEIC_TOO_LARGE";
export const HEIC_ERROR_CONVERT_FAILED = "HEIC_CONVERT_FAILED";
export const HEIC_ERROR_TIMEOUT = "HEIC_CONVERSION_TIMEOUT";

const HEIC_MIME_TYPES = ["image/heic", "image/heif"];
const HEIC_EXTENSIONS = [".heic", ".heif"];

/**
 * Abort API を持たない非同期処理に、利用者向けの有限な待機時間を与える。
 *
 * Promise.race は呼び出し側の Promise を終了させるだけで、変換 Worker は停止できない。
 * そのため、タイムアウト後に元の処理が遅れて完了しても呼び出し側で結果を採用しない
 * こと（CardManager の世代チェック）が必要になる。
 */
async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(HEIC_ERROR_TIMEOUT)), timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * アップロード対象ファイルが HEIC / HEIF かどうかを判定する。
 * File.type が空文字列の環境でも拡張子で判定できるようにする。
 *
 * @param file 選択されたファイル
 * @returns true なら HEIC / HEIF（クライアント側で JPEG 変換が必要）
 */
export function isHeicUpload(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (HEIC_MIME_TYPES.includes(mime)) return true;
  const name = file.name.toLowerCase();
  return HEIC_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * HEIC / HEIF ファイルを JPEG の File へ変換する。
 * 変換ライブラリ（heic-to）のCSP対応ビルドをHEIC選択時のみ動的 import する。
 *
 * `heic-to/csp` は libheif を unsafe-eval なしでビルドした Worker を含むため、
 * 本番の厳格なCSPを緩めずにブラウザ内変換を行える。通常のJPEG/PNGではimport
 * 自体が発生しないので、初期ロードへデコーダを追加しない。
 *
 * @param file HEIC / HEIF ファイル
 * @returns JPEG に変換された File（ファイル名の拡張子は .jpg）
 * @throws 変換失敗時・入力サイズ上限超過時は利用者向けのメッセージ付き Error
 */
export async function convertHeicToJpeg(file: File): Promise<File> {
  if (file.size > HEIC_INPUT_MAX_BYTES) {
    throw new Error(HEIC_ERROR_TOO_LARGE);
  }

  let output: Blob | Blob[];
  try {
    output = await withTimeout(async () => {
      // `heic-to/csp` はCSP制約を満たすビルドを選ぶための明示的なサブパス。
      const { heicTo } = await import("heic-to/csp");
      // quality は既存のクロップ再圧縮（ImageCropper の 0.85）と同等水準にする
      return heicTo({ blob: file, type: "image/jpeg", quality: 0.85 });
    }, HEIC_CONVERSION_TIMEOUT_MS);
  } catch (error) {
    // タイムアウトは呼び出し側で変換失敗と区別できるよう、そのまま伝える。
    // それ以外のライブラリ内部エラーは既存の利用者向けエラーへ正規化する。
    if (error instanceof Error && error.message === HEIC_ERROR_TIMEOUT) {
      throw error;
    }
    throw new Error(HEIC_ERROR_CONVERT_FAILED);
  }

  // heic-to は初期対応としてprimary imageを単一のBlobへ変換する。
  // 型が将来 Blob[] へ拡張されても先頭画像だけを採用して既存契約を守る。
  const jpegBlob = Array.isArray(output) ? output[0] : output;
  if (!jpegBlob || jpegBlob.size === 0) {
    throw new Error(HEIC_ERROR_CONVERT_FAILED);
  }

  // ファイル名の拡張子を .jpg に置換し、元の lastModified を維持する
  const baseName = file.name.replace(/\.[^.]+$/, "");
  return new File([jpegBlob], `${baseName}.jpg`, {
    type: "image/jpeg",
    lastModified: file.lastModified,
  });
}
