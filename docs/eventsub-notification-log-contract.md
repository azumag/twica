# EventSub 通知失敗ログのラベル契約

`postRedemptionNotify` の通知失敗ログでは、人が読む warn 表示と `reportError` の構造化 context でラベル表記を意図的に分ける。

- warn 表示は `broadcast` / `chat announcement` を使う。ログ本文からソースを grep しやすいよう、表示ラベルはリテラルのまま維持する。
- `reportError` の context は `eventsub:postRedemptionNotify:broadcast` / `eventsub:postRedemptionNotify:chatAnnouncement` を使う。`chatAnnouncement` は既存の監視・テストとの互換性を保つため camelCase のまま変更しない。

したがって、表示文言を整える目的で `chatAnnouncement` context を `chat announcement` へ変更してはならない。逆に、人向け warn 表示を context に合わせて camelCase へ戻す必要もない。

リポジトリ外の Cloudflare Observability 等で文字列監視を追加・変更する場合は、旧表示文字列 `chatAnnouncement failed` を前提にせず、可能なら構造化 context を利用する。既存の外部監視条件があるかどうかはリポジトリだけでは確認できないため、監視設定を変更する際に別途確認する。

この文書化は既存ログ契約の説明だけで実行コードを変更しないため、専用の Preview 実経路ゲートは不要とする。通常の CI とレビューで文書と現行実装の整合を確認する。

Refs #1098 #1097
