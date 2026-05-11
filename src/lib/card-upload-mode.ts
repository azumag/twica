import { UPLOAD_CONFIG } from "@/lib/constants"

type CardUploadFileLike = Pick<File, "name" | "type">

function getUploadExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".")
  return lastDotIndex > -1 ? fileName.slice(lastDotIndex + 1).toLowerCase() : ""
}

export function isAllowedCardUploadFile(file: CardUploadFileLike): boolean {
  const allowedTypes = UPLOAD_CONFIG.ALLOWED_TYPES as readonly string[]
  if (allowedTypes.includes(file.type)) {
    return true
  }

  const allowedExtensions = UPLOAD_CONFIG.ALLOWED_EXTENSIONS as readonly string[]
  return file.type === "" && allowedExtensions.includes(getUploadExtension(file.name))
}

export function shouldPreserveOriginalCardUpload(file: CardUploadFileLike): boolean {
  const fileName = file.name.toLowerCase()

  return file.type === "image/gif" || fileName.endsWith(".gif")
}
