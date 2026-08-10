// Claude 自動レビュー本文の整形ロジック（純関数）。
// workflow の inline JS から切り出し、tests/unit/claude-review-format.test.ts で
// 検証する（#916 round-10 指摘）。伏字化は公開 PR コメントへのシークレット漏洩を
// 防ぐ最後の防波堤のため、変更時は必ずテストを更新すること。

// 既知のトークン形式。GitHub のシークレットマスキングはログにのみ効き、
// API のコメント本文には適用されないため、投稿前に伏字化する。
// 末尾に否定先読みを置かない: 貪欲マッチと組み合わせると
// `ghp_..._` や `github_pat_...-` のような実トークンが素通りする
// fail-open になるため。過剰伏字化は安全側（#916 round-12 指摘）。
const SECRET_PATTERN =
  /\b(sk-ant-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g

// issue comment 上限 65536 文字に対して余裕を持つしきい値。
// プロンプトで 6000 字以内を指示しているが出力は強制されないため、
// 実運用に近い値で安全網として機能させる。
export const MAX_BODY_LENGTH = 20000

export function redactSecrets(text) {
  return text.replace(SECRET_PATTERN, '[REDACTED]')
}

// 上限超過時は行単位で切り詰める（サロゲートペアを分割しないようコードポイント
// 単位で数える）。未閉じのコードフェンスは常に判定して補完し、切り詰め時は
// フェンスを閉じてから省略注記を足す（注記がコードブロックに飲み込まれるのを防ぐ）。
export function truncateAndCloseFences(text) {
  let result = text
  const needsTruncation = Array.from(result).length > MAX_BODY_LENGTH
  if (needsTruncation) {
    const truncated = Array.from(result).slice(0, MAX_BODY_LENGTH).join('')
    const lastNewline = truncated.lastIndexOf('\n')
    result = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated
  }
  // 行頭の ``` のみ数える簡易ヒューリスティック（4連バッククォートの入れ子や
  // フェンス内の例示は誤判定し得る）。フッター/注記を守る目的では十分。
  const fenceCount = result
    .split('\n')
    .filter((line) => line.trim().startsWith('```')).length
  if (fenceCount % 2 === 1) {
    result += '\n```'
  }
  if (needsTruncation) {
    result += '\n\n（長すぎるため省略）'
  }
  return result
}

// このワークフローが投稿した既存レビューコメントかを判定する。
// マーカーは誰でも知り得るため、投稿者を Bot に限定して第三者コメントの
// 誤上書きを防ぐ。GITHUB_TOKEN での投稿は github-actions[bot]（type=Bot）になる。
export function isOwnReviewComment(comment, marker) {
  return (
    comment?.user?.type === 'Bot' &&
    comment.body?.split('\n', 1)[0].trim() === marker
  )
}
