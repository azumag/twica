/**
 * Canvas 2D コンテキストの色空間ユーティリティ
 *
 * 背景 (Issue #615): 高解像度画像をアップロードすると明度が下がって見える問題
 *
 * iPhone等の最近のスマートフォンで撮影された高解像度写真は、多くの場合
 * Display P3 の広色域で撮影され、そのICCプロファイルが埋め込まれている。
 * これを何も指定しない（既定でsRGBの）canvas 2Dコンテキストに drawImage すると、
 * ブラウザは仕様通り色管理された変換を行い、Display P3の色域をsRGBへ
 * クリップ（gamut mapping）する。sRGBはDisplay P3より狭い色域のため、
 * P3でしか表現できない明るく鮮やかな色（特に赤・緑系統の高彩度色）が
 * sRGBの境界に丸められ、結果として彩度・明度が下がって見える。
 *
 * 参考: https://webkit.org/blog/12058/wide-gamut-2d-graphics-using-html-canvas/
 * 「Colors are muted when an sRGB canvas is used... When converting from the
 * wider Display P3 gamut to the narrower sRGB gamut, saturated colors appear
 * less vibrant or darker.」
 *
 * 対策: 可能であれば Display P3 の canvas コンテキストを使用することで、
 * P3画像をP3のままcanvasに描画でき、色域のクリップ（＝明度低下）を回避できる。
 * canvas.toBlob('image/jpeg') は Display P3 コンテキストに対しては、対応
 * ブラウザでは適切なカラープロファイルを埋め込んだJPEGを出力する。
 *
 * ブラウザ対応状況:
 * - Chrome 94+: 対応
 * - Safari (macOS 12.1+ / iOS 15.1+): 対応
 * - Safari (上記バージョン未満): colorSpace: 'display-p3' 指定時にTypeErrorを送出
 * - Firefox: 現時点で未対応
 *
 * 非対応環境では例外を捕捉し、通常の（sRGB）2Dコンテキストにフォールバックする。
 * フォールバック時は本修正前と同じ挙動（sRGBへのクリップ）になるだけで、
 * 新たな不具合は生じない（既存動作からの後退なし）。
 */
export function getColorManaged2DContext(
  canvas: HTMLCanvasElement
): CanvasRenderingContext2D | null {
  try {
    const p3Context = canvas.getContext("2d", { colorSpace: "display-p3" });
    if (p3Context) {
      return p3Context;
    }
  } catch {
    // colorSpace 未対応環境（要件を満たさないSafariバージョン等）。
    // 通常の sRGB コンテキストにフォールバックする。
  }
  return canvas.getContext("2d");
}
