# /live 公開告知のリンク先

`db/planetscale/migrations/20260811140000_publish_live_directory_announcement.sql` の公開告知は、migration が preview 環境へ適用される場合も `https://twica.bluemoon.works/live` を案内する。

これは意図した運用である。告知は preview 専用機能の案内ではなく、ダッシュボード利用者へ公開済みの「チャネル・ランキング」ページを知らせるユーザー向けメッセージであり、リンク先には安定した本番URLを使う。branch preview / commit preview のURLは検証用で寿命やURLが変更され得るため、告知本文の恒久的な遷移先にはしない。

preview では、告知の表示、期限、`AutoLinkText` によるリンク化などを検証する。ただし検証のために告知本文を preview URL へ書き換えない。

将来 preview 限定の告知が必要になった場合は、適用済みmigrationの本文を書き換えるのではなく、環境別の告知を明示的に分離する。適用済みmigrationはchecksum管理の対象になり得るため、既存ファイルのコメントだけを追記する目的でも編集しない。

Refs: #740, #935, PR #934
