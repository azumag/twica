import { UPLOAD_CONFIG } from "@/lib/constants"

type CardUploadFileLike = Pick<File, "name" | "type">

function getUploadExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".")
  return lastDotIndex > -1 ? fileName.slice(lastDotIndex + 1).toLowerCase() : ""
}

/**
 * カードアップロードで許容するか判定するための共通ヘルパー
 *
 * options.allowEmptyMimeWithExtension = true の場合、
 *   ブラウザによっては File.type が空文字になることがあるため、
 *   拡張子ベースで補完して許可する（CardManager のクライアント側ファイル選択時に使用）。
 * デフォルト (false) ではサーバ側 validateUpload など厳密判定が必要な経路で
 *   拡張子フォールバックを行わず、MIME 型のみで判定する。
 */
export interface IsAllowedCardUploadFileOptions {
  allowEmptyMimeWithExtension?: boolean
}

export function isAllowedCardUploadFile(
  file: CardUploadFileLike,
  options: IsAllowedCardUploadFileOptions = { allowEmptyMimeWithExtension: true },
): boolean {
  const allowedTypes = UPLOAD_CONFIG.ALLOWED_TYPES as readonly string[]
  if (allowedTypes.includes(file.type)) {
    return true
  }

  if (!options.allowEmptyMimeWithExtension) {
    return false
  }

  const allowedExtensions = UPLOAD_CONFIG.ALLOWED_EXTENSIONS as readonly string[]
  return file.type === "" && allowedExtensions.includes(getUploadExtension(file.name))
}

export function shouldPreserveOriginalCardUpload(file: CardUploadFileLike): boolean {
  const fileName = file.name.toLowerCase()

  return file.type === "image/gif" || fileName.endsWith(".gif")
}
