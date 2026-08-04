export type ChatAnnouncementSectionStatus = "active" | "empty" | "attention";

/**
 * チャット通知セクションの表示状態を、serverで確定済みの警告判定から決める。
 *
 * `needsAttention` はDB取得成功時にだけ「通知は有効だが送信手段がない」と判定した
 * 値である。client側で `enabled && !canSendChat` を再構築すると、DB障害による
 * 「不明」までscope不足と誤表示するため、送信可否の材料はこの関数へ渡さない。
 * 純関数として切り出すことで、実装ソースの文字列一致に依存せず三状態の優先順位を
 * テストできるようにする。
 */
export function resolveChatAnnouncementSectionStatus({
  enabled,
  needsAttention,
}: {
  enabled: boolean;
  needsAttention: boolean;
}): ChatAnnouncementSectionStatus {
  if (needsAttention) return "attention";
  return enabled ? "active" : "empty";
}
