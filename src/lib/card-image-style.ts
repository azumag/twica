/**
 * カード画像の表示フィット方法を決める共通ヘルパ / issue #899
 *
 * 余白（fit）モードで生成されたカード（image_padding_color が非 NULL）は、
 * 画像全体 + 余白が焼き込まれているため object-contain + 余白と同色の背景で
 * 表示する。従来のトリミング画像（NULL）は object-cover のまま（回帰ゼロ）。
 */
export function cardImageFitClass(paddingColor: string | null | undefined): string {
  return paddingColor ? "object-contain" : "object-cover";
}

export function cardImageFitStyle(
  paddingColor: string | null | undefined
): React.CSSProperties | undefined {
  // 余白と同色の背景を敷くことで、表示ボックスのアスペクト比が画像と微妙に
  // ズレる場合も余白が浮かず自然につながる。transparent は背景なし（従来どおり）
  return paddingColor ? { backgroundColor: paddingColor } : undefined;
}
