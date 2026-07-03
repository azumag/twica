/**
 * IME(日本語・中国語・韓国語などの変換)入力中に変換を確定するEnterキー押下を
 * 「送信操作」として誤検知しないための判定。
 *
 * IME変換中にEnterキーを押すと、ブラウザは変換確定のためのkeydownイベント
 * (key === "Enter")を発火する。これを通常の送信/追加/保存トリガーと区別しないと、
 * ユーザーが変換を確定しただけのつもりで、意図せず保存・追加操作が走ってしまう
 * (Issue #613)。isComposing 中はここで弾き、Enterキー本来の送信動作は
 * 呼び出し側で e.preventDefault() 等と併せて行う。
 *
 * React合成イベントの isComposing は型上 nativeEvent 経由でのみ公開される
 * (React.KeyboardEvent 自体はこのフィールドを型に持たない)ため、構造的な型で
 * nativeEvent.isComposing を参照する(React.KeyboardEvent はこれを満たす)。
 */
export function isEnterKeySubmit(e: {
  key: string;
  nativeEvent: { isComposing: boolean };
}): boolean {
  return e.key === "Enter" && !e.nativeEvent.isComposing;
}
