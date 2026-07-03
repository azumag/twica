import { UPLOAD_CONFIG, SOUND_UPLOAD_CONFIG } from '@/lib/constants';

export function getFileTypeFromBuffer(buffer: Buffer): string {
  if (buffer.length < 2) {
    return 'application/octet-stream';
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];

  if (firstByte === 0xFF && secondByte === 0xD8) {
    return 'image/jpeg';
  }

  if (buffer.length >= 8 &&
      firstByte === 0x89 && secondByte === 0x50 &&
      buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A &&
      buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return 'image/png';
  }

  // GIFシグネチャ: "GIF87a" (47 49 46 38 37 61) または "GIF89a" (47 49 46 38 39 61)
  // バージョンバイト (index 4) が 0x37 ('7') / 0x39 ('9') のいずれかを許容することで、
  // 一般的に流通するアニメーション GIF (GIF89a) も正しく判定する
  if (buffer.length >= 6 &&
      firstByte === 0x47 && secondByte === 0x49 &&
      buffer[2] === 0x46 && buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) &&
      buffer[5] === 0x61) {
    return 'image/gif';
  }

  if (buffer.length >= 12 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 &&
      buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  return 'application/octet-stream';
}

/**
 * 音声ファイルのMIMEタイプをマジックナンバーから判定
 * MP3, WAV, WebM, OGGをサポート
 * 効果音アップロード時にファイル内容の検証に使用
 */
export function getSoundFileTypeFromBuffer(buffer: Buffer): string {
  if (buffer.length < 12) {
    return 'application/octet-stream';
  }

  // MP3: ID3タグ (0x49 0x44 0x33) または MPEGフレームヘッダー (0xFF 0xFB/0xFA/0xF3/0xF2)
  // ID3タグはMP3ファイルのメタデータ（曲名、アーティスト名等）を格納
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return 'audio/mpeg';
  }
  // MPEGフレームシンクワード: 0xFF + フレームヘッダーの開始
  if (buffer[0] === 0xFF && (buffer[1] === 0xFB || buffer[1] === 0xFA || buffer[1] === 0xF3 || buffer[1] === 0xF2)) {
    return 'audio/mpeg';
  }

  // WAV: "RIFF....WAVE" フォーマット
  // RIFF (Resource Interchange File Format) はMicrosoftのマルチメディアファイル形式
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45) {
    return 'audio/wav';
  }

  // WebM: EBMLヘッダー (0x1A 0x45 0xDF 0xA3)
  // WebMはMatroskaベースの動画/音声コンテナフォーマット
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return 'audio/webm';
  }

  // OGG: "OggS" マジックナンバー
  // Ogg Vorbisはオープンソースの音声圧縮フォーマット
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return 'audio/ogg';
  }

  return 'application/octet-stream';
}

export function isValidExtension(ext: string): ext is typeof UPLOAD_CONFIG.ALLOWED_EXTENSIONS[number] {
  return UPLOAD_CONFIG.ALLOWED_EXTENSIONS.includes(ext as typeof UPLOAD_CONFIG.ALLOWED_EXTENSIONS[number]);
}

/**
 * 効果音ファイルの拡張子が許可されているかを検証
 * MP3, WAV, WebM, OGGのみ許可
 */
export function isValidSoundExtension(ext: string): ext is typeof SOUND_UPLOAD_CONFIG.ALLOWED_EXTENSIONS[number] {
  return SOUND_UPLOAD_CONFIG.ALLOWED_EXTENSIONS.includes(ext as typeof SOUND_UPLOAD_CONFIG.ALLOWED_EXTENSIONS[number]);
}

export function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf('.');
  return lastDotIndex > -1 ? fileName.slice(lastDotIndex + 1).toLowerCase() : '';
}
