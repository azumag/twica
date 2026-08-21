# DB cutover invariant の source / target 前提

`scripts/db-cutover/layer-invariants.mjs` の Layer 5 は、cutover 前後の DB を同じ意味のデータ集合として比較するための検証です。`source` は移行元、`target` は移行先を表し、各 side を read-only snapshot で読み取ります。

## Tier A と Tier B

- Tier A は source / target をそれぞれ独立に評価する絶対条件です。違反件数が 0 であることなど、side 間の一致ではなく各 DB 自身が満たすべき条件を確認します。
- Tier B は source / target の違反集合を比較する相対条件です。違反件数と digest が一致することを前提にしており、移行前後で同じ業務ルールが適用されている場合の drift 検知に使います。

このため、**target の PlanetScale 側にだけ業務ルールを変更する migration を先行適用した状態**では、Tier B の差分が恒常的に出ることがあります。たとえば target だけでランキング除外述語を変更した場合、同じ生データを読んでも source の旧述語と target の新述語では違反集合が一致しない可能性があります。これは必ずしもコピー漏れや cutover 破損を意味しません。

## 意図的な target-only 差分を扱うとき

意図した migration 差分と、本物の cutover drift を混同しないため、次の順序で扱います。

1. 差分が migration で意図した業務ルール変更から説明できることを、対象 migration と release unit で確認する。
2. source / target の欠落テーブル、SQL 実行エラー、想定外の violation 増減など、migration だけでは説明できない finding は通常どおり失敗として扱う。
3. Tier B の意味自体が「同一ルールの比較」でなくなった場合は、全体を安易に allowlist したり判定を弱めたりせず、check の scope、version、または比較対象を明示的に分ける。
4. target-only の状態が一時的なデプロイ窓である場合は、その release unit の証跡に前提を残し、source と target が同じ業務ルールへ揃った後に通常の Tier B parity が回復することを確認する。

## 失敗を無視してよいという意味ではない

この注記は Tier B の解釈前提を明確にするものであり、cutover gate を迂回するための例外規則ではありません。次の finding は target-only migration の存在だけを理由に無視しません。

- required table の片側欠落や非対称な欠落
- invariant SQL の runtime error
- migration の意図から説明できない violation count / digest の差分
- Tier A の絶対条件違反
- allowlist の条件に一致しない既知差分

実装上の正本は `scripts/db-cutover/layer-invariants.mjs` と `scripts/db-cutover/invariant-checks.mjs` です。本書は Issue #1036 の「cutover invariant の source / target 前提」を運用・レビュー時に読み取れる形で明文化するものです。
