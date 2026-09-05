# ガチャ効果音 URL の許可ホスト契約

`src/lib/gacha-sound-rules.ts` の `isAllowedSoundUrl` が現在実装している URL 許可規則を記録する。

この文書は運用上の推奨値を新しく決めるものではなく、既存実装の判定条件を明示するためのものとする。

## 判定順序

1. URL として解釈できない値は拒否する。
2. `https:` 以外は拒否する。
3. 許可ホスト集合を次の和集合で作る。
   - `R2_SOUND_PUBLIC_URL` の hostname
   - `R2_PUBLIC_URL` の hostname
   - `ALLOWED_SOUND_HOSTS` のカンマ区切り hostname
4. 許可ホスト集合が空の場合は、後方互換として HTTPS URL を許可する。
5. 許可ホスト集合がある場合は、対象 URL の hostname が集合に含まれていれば許可する。
6. ブラウザ環境で `location` が存在する場合は、同一 origin の HTTPS URL も許可する。
7. それ以外は拒否する。

## hostname の正規化

許可ホストは比較前に前後空白を除去し、小文字へ正規化する。対象 URL 側も `URL.hostname` を小文字へ正規化して比較する。

したがって、allowlist の比較単位は hostname の完全一致である。

- 大文字・小文字の違いは無視する。
- 対象 URL のポート番号は `URL.hostname` に含まれないため、allowlist の hostname 比較には使わない。
- `ALLOWED_SOUND_HOSTS` の各要素は URL として再解釈されず、そのまま hostname 文字列として比較される。そのため `cdn.example.com:443` ではなく `cdn.example.com` の形式で指定する。
- `example.com` を許可しても `cdn.example.com` は自動では許可されない。
- ワイルドカードや suffix 一致は実装していない。

例えば次の設定では `cdn.example.com` と `media.example.com` のみが明示追加される。

```env
ALLOWED_SOUND_HOSTS=cdn.example.com,media.example.com
```

## R2 由来ホスト

`R2_SOUND_PUBLIC_URL` / `R2_PUBLIC_URL` は URL として解釈できた場合のみ hostname を許可集合へ加える。不正な URL が設定されていた場合、その値は無視される。

`ALLOWED_SOUND_HOSTS` は R2 由来ホストを置き換える完全 allowlist ではなく、追加許可である。

## allowlist 未設定時の fallback

R2 由来ホストと `ALLOWED_SOUND_HOSTS` の双方から 1 件も hostname を得られない場合、現行実装は後方互換のため HTTPS URL を許可する。

これは「任意 URL を常に許可する」という意味ではない。いずれかの許可ホストが 1 件でも設定・導出されると hostname 制限が有効になる。

## same-origin 分岐

同一 origin の例外は `location` が存在するブラウザ環境でのみ評価される。サーバー側で `location` が存在しない実行では、この分岐には入らない。

この分岐は `parsed.origin === location.origin` で判定するため、allowlist の hostname 比較とは異なり scheme / hostname / port を含む origin 全体が一致する必要がある。

この分岐が各実利用経路で実際に必要か、削除・責務整理すべきかは Issue #1375 の別フォローアップとして扱い、本書では現行挙動だけを記録する。

Refs #1375 #1374 #1342 #837
