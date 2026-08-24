# Analysis dashboard comparison: scope and limitations

`scripts/compare-analysis-dashboard-vs-sql.mjs` は、analysis dashboard が利用する `get_analysis_*()` RPC の結果と、同じ read-only snapshot 上で直接集計した SQL の結果を突き合わせるための確認ツールです。

## この比較で検出できるもの

- RPC の返却キー欠落や shape drift
- RPC と基礎集計 SQL の件数差分
- `usersSummary.totalUsers`、`streamersSummary.totalStreamers`、`streamersSummary.totalCards` の独立経路との不一致
- `rarityDistribution` の rarity ごとの件数差分
- migration / RPC 適用漏れや、片側だけ変更された集計式による drift

比較は `fetchBasicAggregates()` と `fetchRpcAggregates()` を同じ read-only transaction snapshot 内で実行するため、比較中の書き込みによる時点差を原因とする誤差は避けます。

## この比較だけでは検出できないもの

`fetchBasicAggregates()` は、RPC と同じ集計境界を別 SQL として書き下しています。たとえば `today`、直近7日、月初からの集計期間は、RPC と基礎集計 SQL の双方で同じ定義を使います。

そのため、**RPC と基礎集計 SQL の両方に同じ定義ミスが入った場合は、一致していても誤りを検出できません。** このツールは RPC 実装そのものの正しさを完全に証明するものではなく、主に「2経路の drift・欠落・shape 差分」を検出するものとして扱います。

同様に、業務上の期待値そのものが誤っている場合や、両経路が同じ誤った前提を共有している場合も、この比較だけでは判定できません。

## 結果の解釈

- **差分あり**: RPC / migration /集計 SQL のどこかに不整合があるため、昇格前に原因を確認します。
- **差分なし**: 比較対象の2経路が一致していることを示します。RPC の仕様・境界条件まで正しいことの証明にはしません。

より強い独立性が必要な指標は、同じ式を再記述するのではなく、別アルゴリズムでの照合を追加します。例として、期間集計を日次 `GROUP BY` の合算から再構成する方法があります。これは必要性が確認できた指標から個別に追加し、本スクリプトの通常比較を過度に複雑化しない方針とします。

Related: #1082
