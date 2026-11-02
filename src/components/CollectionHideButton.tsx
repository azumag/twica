"use client";

import { useTranslations } from "next-intl";

interface CollectionHideButtonProps {
  /** aria-label 用の配信者表示名（同じ文言のボタンが並ぶため、対象を読み上げに含める） */
  streamerName: string;
  /**
   * このボタンを押した結果の状態。true = 非表示にする（通常カード側のボタン）、
   * false = 再表示する（「非表示のコレクション」内のボタン）。
   */
  hide: boolean;
  /** 送信中（同じ配信者への二重送信を防ぐ）。 */
  disabled: boolean;
  onClick: () => void;
  /** 直前の更新が失敗したか。true のときボタンの下にエラー文言を出す。 */
  error: boolean;
}

/**
 * マイコレクション一覧の「非表示 / 再表示」ボタン (#1953)。
 *
 * 状態と通信は持たない表示専用の部品。楽観的更新・POST・失敗時の巻き戻しは、
 * カードの移動と一体で扱う親の CollectionStreamerList が行う。
 * 確認ダイアログは出さない。非表示はカード所持に影響せず、「非表示のコレクション」
 * から 1 クリックで元に戻せる可逆な操作のため、確認で操作を重くしない。
 */
export default function CollectionHideButton({
  streamerName,
  hide,
  disabled,
  onClick,
  error,
}: CollectionHideButtonProps) {
  const t = useTranslations("collection.hide");

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={hide ? t("hideAria", { name: streamerName }) : t("showAria", { name: streamerName })}
        className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 transition-colors hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {hide ? t("hideButton") : t("showButton")}
      </button>
      {error && (
        <p role="alert" className="mt-1 max-w-[12rem] text-right text-xs text-red-400">
          {t("error")}
        </p>
      )}
    </div>
  );
}
