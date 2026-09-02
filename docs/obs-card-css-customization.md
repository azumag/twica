# OBS でカード枠を CSS カスタマイズする

TwiCa の固定オーバーレイを OBS のブラウザソースとして使う場合は、OBS の
**カスタム CSS** からカード表示へ見た目を上書きできます。

## 基本手順

1. OBS で TwiCa の固定オーバーレイをブラウザソースとして追加します。
2. ブラウザソースのプロパティを開き、**カスタム CSS** 欄へ CSS を貼り付けます。
3. TwiCa 側のデモ表示でカードを出し、OBS 上の見た目を確認します。

カード表示全体には、オーバーレイ実装が保守用に付けている
`data-overlay-card="true"` 属性を使ってください。Tailwind の utility class 名や
DOM の階層は内部実装なので、カスタム CSS の恒久的な selector としては推奨しません。

```css
[data-overlay-card="true"] {
  position: relative;
}
```

## 例: カードの外側へ独自の枠を付ける

内部のカード枠そのものを直接選ばず、カード表示全体の疑似要素で外枠を追加すると、
内部 DOM の変更に比較的影響されにくくなります。

```css
[data-overlay-card="true"] {
  position: relative;
}

[data-overlay-card="true"]::before {
  content: "";
  position: absolute;
  inset: -10px;
  border: 4px solid #ffffff;
  border-radius: 24px;
  box-shadow: 0 0 24px rgba(255, 255, 255, 0.65);
  pointer-events: none;
}
```

## 例: カード全体へフィルターや変形を加える

```css
[data-overlay-card="true"] {
  filter: drop-shadow(0 0 18px rgba(120, 180, 255, 0.8));
  transform: rotate(-1deg);
}
```

TwiCa 自身も表示・非表示アニメーションで `transform` を使うため、独自の
`transform` を指定すると標準アニメーションを上書きします。標準アニメーションを
残したい場合は `filter` や疑似要素を使う方が安全です。

## 画像読み込み失敗時の表示

画像を表示できない場合の代替表示には
`data-overlay-card-fallback="true"` が付いています。例えば、枠線だけ変える場合は次の
ように指定できます。

```css
[data-overlay-card-fallback="true"] {
  border: 2px dashed rgba(255, 255, 255, 0.7);
}
```

## 背景を透明に保つ

固定オーバーレイ自体は透明背景ですが、他の CSS と組み合わせる場合は必要に応じて
次を追加できます。

```css
html,
body {
  background: transparent !important;
  overflow: hidden;
}
```

## selector を選ぶときの注意

- `data-overlay-card` と `data-overlay-card-fallback` は用途が分かる属性なので、
  Tailwind の class 名を直接つなぐより変更に強い selector です。
- `w-80`、`rounded-2xl`、`bg-gray-700` などの utility class は内部実装です。
  将来のレイアウト変更で変わる可能性があります。
- `imageOnly` や `autoPortrait` を使うと通常カードとは内部構造が変わります。
  どの表示モードでも効かせたい CSS は `data-overlay-card` を起点にしてください。
- CSS を大きく変更した後は、通常カード・画像のみ表示・画像読み込み失敗時の3経路を
  OBS のデモ表示で確認してください。

Refs #877
