"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  MAX_CARD_PACK_NAMES,
  RARITY_CONTROL_CHAR_REGEX as CONTROL_CHAR_REGEX,
  RARITY_BIDI_OVERRIDE_REGEX as BIDI_OVERRIDE_REGEX,
} from "@/lib/constants";
import { MAX_COLLECTION_NAME_LENGTH, isReservedCollectionName } from "@/lib/validation/collection-name";
import { logger } from "@/lib/logger";
import { isEnterKeySubmit } from "@/lib/keyboard-utils";

// ここでの事前検証は UX 向上のためで、最終的な検証はサーバーが行う
// (POST /api/streamer/settings, PATCH /api/cards/collections)。検証規則は
// constants / collection-name の共通定数を共有する。

interface CardPackModalProps {
  isOpen: boolean;
  onClose: () => void;
  streamerId: string;
  cardPackNames: string[];
  // Issue #554: 「デフォルト」(未分類)パックの表示名オーバーライド。
  // null は汎用ラベル("デフォルト")表示を意味する。
  defaultPackName: string | null;
  // Issue #269再設計: 新規パック追加のみプランでゲートする(削除は常に許可)。
  isPremium?: boolean;
  onSaved: (next: string[]) => void;
  // Issue #554: デフォルトパックの表示名リネームが成功した際に親へ通知する。
  onDefaultPackNameSaved: (next: string | null) => void;
  // Issue #605: 通常パックのリネームが成功した際、旧名→新名を親へ通知する。
  // onSaved はリネーム後のカタログ配列(string[])のみを渡すため、親
  // (CardManager)が保持する cards ステートの collection_name 追従には使えない。
  // このコールバックで親がカード側をローカルパッチできるようにする
  // (呼び出し側がカードを持たない場合に備え任意propとする)。
  onPackRenamed?: (oldName: string, newName: string) => void;
}

/**
 * ローカル(クライアント側)の単一パック名検証。サーバー側
 * (validatePackName / validateCardPackNamesInput)と同じ規則を共有し、
 * UXのために即座にフィードバックする。最終的な検証は常にサーバーが行う。
 */
function validatePackNameLocal(
  raw: string,
  t: ReturnType<typeof useTranslations>
): { ok: true; value: string } | { ok: false; error: string } {
  const key = raw.trim();
  if (key.length < 1) {
    return { ok: false, error: t("cardPackModal.errorEmpty") };
  }
  if (key.length > MAX_COLLECTION_NAME_LENGTH) {
    return { ok: false, error: t("cardPackModal.errorTooLong") };
  }
  if (CONTROL_CHAR_REGEX.test(key) || BIDI_OVERRIDE_REGEX.test(key)) {
    return { ok: false, error: t("cardPackModal.errorInvalidChars") };
  }
  // Issue #555: `__` は DEFAULT_PACK_SENTINEL 等の予約値の名前空間。ここで
  // 弾かないと、サーバー側検証で拒否されるまでユーザーが気づけない。
  if (isReservedCollectionName(key)) {
    return { ok: false, error: t("cardPackModal.errorReserved") };
  }
  return { ok: true, value: key };
}

/**
 * CardPackModal - 事前登録カードパック名の管理モーダル
 *
 * CustomRarityModal と同じパターン: パック名の追加/削除をこのモーダルで行い、
 * 保存すると streamers.card_pack_names に永続化される。カード作成/チャネポ
 * 設定側は、ここで登録済みのパック名から選ぶだけ(自由入力は廃止)。
 *
 * `!isPremium` のときは追加操作のみ無効化する(削除は常に可能)。サーバーが
 * ゲートで一部の追加を却下した場合はレスポンスの実際の永続化リストで
 * ローカルstateを同期し、その旨を案内する(モーダルは閉じない)。
 *
 * Issue #554: 一覧の先頭に削除不可の固定「デフォルト」行を表示し、既存パック
 * ＋デフォルト行の両方にインライン編集(リネーム)を追加する。リネームは
 * 追加/削除の「保存」ボタンとは独立に、行ごとに即時サーバーへ反映する
 * (通常パックは PATCH /api/cards/collections、デフォルトは
 * POST /api/streamer/settings { defaultCardPackName })。カスケード更新の
 * 単純さを優先し、未保存の追加/削除がある間はリネームを無効化する
 * (先に保存を促す)。
 */
export default function CardPackModal({
  isOpen,
  onClose,
  streamerId,
  cardPackNames,
  defaultPackName,
  isPremium = false,
  onSaved,
  onDefaultPackNameSaved,
  onPackRenamed,
}: CardPackModalProps) {
  const t = useTranslations("cardManager");
  const tCommon = useTranslations("common");

  const [list, setList] = useState<string[]>(cardPackNames);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // デフォルトパックの表示名。追加/削除の一括保存とは独立に、リネームが
  // 成功した時点で即座にここを更新する(サーバー側の実際値を反映)。
  const [currentDefaultPackName, setCurrentDefaultPackName] = useState<string | null>(defaultPackName);

  // インライン編集中の行: 通常パックは編集対象の"現在の名前"、デフォルト行は
  // 専用フラグで管理する(2つ同時に編集中にはならない)。
  const [editingPack, setEditingPack] = useState<string | null>(null);
  const [editingDefault, setEditingDefault] = useState(false);
  const [renameInput, setRenameInput] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const isRenaming = editingPack !== null || editingDefault;

  // モーダルを開くたびに、保存済みの最新値から編集を開始する。
  useEffect(() => {
    if (isOpen) {
      setList(cardPackNames);
      setCurrentDefaultPackName(defaultPackName);
      setInput("");
      setError(null);
      setNotice(null);
      setEditingPack(null);
      setEditingDefault(false);
      setRenameInput("");
      setRenameError(null);
    }
  }, [isOpen, cardPackNames, defaultPackName]);

  const hasChanges = useMemo(() => {
    if (list.length !== cardPackNames.length) return true;
    return list.some((v, i) => v !== cardPackNames[i]);
  }, [list, cardPackNames]);

  if (!isOpen) return null;

  const cancelRename = () => {
    setEditingPack(null);
    setEditingDefault(false);
    setRenameInput("");
    setRenameError(null);
  };

  const handleClose = () => {
    // Issue #554 レビュー指摘: リネームの保存リクエストが飛んでいる間に
    // 背景クリック/×ボタンで閉じられると、結果(成功/失敗)をユーザーに
    // 伝えられないままサイレント失敗になり得るため、保存完了まで閉じない
    // (追加/削除の一括保存中も同様にガードする)。
    if (renameSaving || saving) return;
    // インライン編集中(未保存)のクローズは、追加/削除の未保存変更と同じ
    // confirmClose 確認にまとめる(編集途中の入力が黙って消えるのを防ぐ)。
    if ((hasChanges || isRenaming) && !confirm(t("cardPackModal.confirmClose"))) return;
    setList(cardPackNames);
    setInput("");
    setError(null);
    setNotice(null);
    cancelRename();
    onClose();
  };

  const handleAdd = () => {
    const validation = validatePackNameLocal(input, t);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    const key = validation.value;
    if (list.includes(key)) {
      setError(t("cardPackModal.errorDuplicate"));
      return;
    }
    if (list.length >= MAX_CARD_PACK_NAMES) {
      setError(t("cardPackModal.errorMax", { max: MAX_CARD_PACK_NAMES }));
      return;
    }
    setList([...list, key]);
    setInput("");
    setError(null);
  };

  const handleRemove = (value: string) => {
    setList(list.filter((v) => v !== value));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ streamerId, cardPackNames: list }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("cardPackModal.saveFailed"));
      }

      // Issue #269再設計: サーバーが実際に永続化したリストで同期する
      // (basicプランで一部の新規追加が却下された場合を含む)。
      const persisted = Array.isArray(data.cardPackNames) ? (data.cardPackNames as string[]) : list;

      // 自己レビュー指摘: デプロイ窓で書き込み自体が見送られた場合、
      // persisted は「保存前の値」のまま(実際には何も変わっていない)。
      // 成功扱いでモーダルを閉じると、次回読み込み時に静かに消えたように
      // 見えるため、他の非ゲート成功と同様にここで足止めして案内する。
      if (data.cardPackNamesSkippedDeployWindow) {
        setList(persisted);
        setNotice(t("cardPackModal.deployWindow"));
        return;
      }

      if (data.cardPackNamesPremiumRequired) {
        setList(persisted);
        setNotice(t("cardPackModal.premiumRequired"));
        return;
      }

      onSaved(persisted);
      onClose();
    } catch (err) {
      logger.error("Failed to save card pack names:", err);
      setError(err instanceof Error ? err.message : t("cardPackModal.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const startRenamePack = (name: string) => {
    setEditingDefault(false);
    setEditingPack(name);
    setRenameInput(name);
    setRenameError(null);
  };

  const startRenameDefault = () => {
    setEditingPack(null);
    setEditingDefault(true);
    setRenameInput(currentDefaultPackName ?? "");
    setRenameError(null);
  };

  /**
   * 通常パックのリネーム。カスケード更新(カード/報酬紐付け)のため、
   * 追加/削除の「保存」ボタンを待たず即時 PATCH で反映する。
   */
  const handleRenamePackSave = async () => {
    if (!editingPack) return;
    const oldName = editingPack;
    const validation = validatePackNameLocal(renameInput, t);
    if (!validation.ok) {
      setRenameError(validation.error);
      return;
    }
    const newName = validation.value;
    if (newName === oldName) {
      cancelRename();
      return;
    }
    if (list.includes(newName)) {
      setRenameError(t("cardPackModal.errorDuplicate"));
      return;
    }
    // Issue #554 レビュー指摘: デフォルトパックの表示名と同名へのリネームも拒否
    // (逆方向 — デフォルト表示名を実パック名に変える操作 — のチェックと対称)。
    // select 上に同一ラベルの選択肢が2つ並ぶ紛らわしさを防ぐ。サーバー側には
    // 対応するクロスフィールド検証を意図的に持ち込まない: 表示名は cosmetic
    // であり、API 2つ(settings/collections)にまたがる整合性検証を追加する
    // 複雑さに見合わないため(クライアント検証のみのベストエフォート)。
    if (currentDefaultPackName !== null && newName === currentDefaultPackName) {
      setRenameError(t("cardPackModal.errorDuplicate"));
      return;
    }

    setRenameSaving(true);
    setRenameError(null);
    try {
      const response = await fetch("/api/cards/collections", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ streamerId, oldName, newName }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setRenameError(data?.error || t("cardPackModal.renameFailed"));
        return;
      }

      const nextList = Array.isArray(data?.cardPackNames)
        ? (data.cardPackNames as string[])
        : list.map((v) => (v === oldName ? newName : v));
      setList(nextList);
      onSaved(nextList);
      // Issue #605: カタログ配列の更新(onSaved)だけでは、親が保持する既存カード
      // の collection_name が旧パック名のまま取り残される(サーバー側は
      // rename_card_pack RPC でカード側も含めて既にカスケード更新済み)。
      // 親側のカード表示がリロードするまで「別パックのカード」に見えてしまう
      // 不具合の原因だったため、専用コールバックで旧名→新名を明示的に伝える。
      onPackRenamed?.(oldName, newName);
      cancelRename();
    } catch (err) {
      logger.error("Failed to rename card pack:", err);
      setRenameError(t("cardPackModal.renameFailed"));
    } finally {
      setRenameSaving(false);
    }
  };

  /**
   * デフォルトパックの表示名リネーム。空欄での保存は「リセット」
   * (汎用ラベル表示に戻す = null)として扱う。
   */
  const handleRenameDefaultSave = async () => {
    const trimmed = renameInput.trim();
    let newValue: string | null;
    if (trimmed.length === 0) {
      newValue = null;
    } else {
      const validation = validatePackNameLocal(renameInput, t);
      if (!validation.ok) {
        setRenameError(validation.error);
        return;
      }
      // カタログ名との衝突を避ける(select上で同名の選択肢が並ぶのを防ぐ)。
      if (list.includes(validation.value)) {
        setRenameError(t("cardPackModal.errorDuplicate"));
        return;
      }
      newValue = validation.value;
    }

    if (newValue === currentDefaultPackName) {
      cancelRename();
      return;
    }

    setRenameSaving(true);
    setRenameError(null);
    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ streamerId, defaultCardPackName: newValue }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setRenameError(data?.error || t("cardPackModal.renameFailed"));
        return;
      }
      if (data?.defaultCardPackNameSkippedDeployWindow) {
        setRenameError(t("cardPackModal.deployWindow"));
        return;
      }

      setCurrentDefaultPackName(newValue);
      onDefaultPackNameSaved(newValue);
      cancelRename();
    } catch (err) {
      logger.error("Failed to rename default pack:", err);
      setRenameError(t("cardPackModal.renameFailed"));
    } finally {
      setRenameSaving(false);
    }
  };

  const defaultRowDisplayName = currentDefaultPackName ?? t("cardPackModal.defaultName");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={handleClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-hidden rounded-xl bg-gray-800 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="p-6 border-b border-gray-700">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">
              {t("cardPackModal.title")}
            </h3>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-white"
              aria-label="Close"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <p className="mt-2 text-sm text-gray-400">
            {t("cardPackModal.description")}
          </p>
        </div>

        {/* 本文 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div>
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                maxLength={MAX_COLLECTION_NAME_LENGTH}
                disabled={!isPremium || isRenaming}
                placeholder={t("cardPackModal.addPlaceholder")}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Issue #613: IME変換確定のEnterで誤って追加が走らないようにする
                  if (isEnterKeySubmit(e)) {
                    e.preventDefault();
                    handleAdd();
                  }
                }}
                className="w-full min-w-0 rounded-lg bg-gray-600 px-4 py-2 text-white placeholder:text-gray-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="button"
                onClick={handleAdd}
                disabled={!isPremium || isRenaming}
                className="rounded-lg border border-purple-600 px-4 py-2 text-purple-400 hover:bg-purple-600 hover:text-white transition whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-purple-400"
              >
                {t("cardPackModal.add")}
              </button>
            </div>
            {!isPremium && (
              <p className="mt-2 text-xs text-yellow-300">
                {t("cardPackModal.premiumRequiredHint")}
                <a href="/plans" className="ml-1 text-purple-400 hover:text-purple-300 underline">
                  支援特典について
                </a>
              </p>
            )}
            {error && (
              <p className="mt-2 text-sm text-red-400">{error}</p>
            )}
            {notice && (
              <p className="mt-2 text-sm text-yellow-300">{notice}</p>
            )}
            {/* Issue #554: 未保存の追加/削除がある間はリネームできない旨の案内 */}
            {hasChanges && !isRenaming && (
              <p className="mt-2 text-xs text-amber-300">
                {t("cardPackModal.renameDisabledHint")}
              </p>
            )}

            <div className="mt-4">
              <ul className="space-y-2">
                {/* Issue #554: 削除不可の固定「デフォルト」行。常に先頭に表示する。 */}
                <li className="rounded-lg bg-gray-700/70 border border-gray-600 px-4 py-2">
                  {editingDefault ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        autoFocus
                        value={renameInput}
                        maxLength={MAX_COLLECTION_NAME_LENGTH}
                        disabled={renameSaving}
                        placeholder={t("cardPackModal.defaultName")}
                        onChange={(e) => setRenameInput(e.target.value)}
                        onKeyDown={(e) => {
                          // Issue #613: IME変換確定のEnterで誤って保存が走らないようにする
                          if (isEnterKeySubmit(e)) {
                            e.preventDefault();
                            handleRenameDefaultSave();
                          } else if (e.key === "Escape") {
                            cancelRename();
                          }
                        }}
                        className="w-full min-w-0 rounded-lg bg-gray-600 px-3 py-1.5 text-white placeholder:text-gray-400 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <button
                        type="button"
                        onClick={handleRenameDefaultSave}
                        disabled={renameSaving}
                        className="whitespace-nowrap rounded-lg bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
                      >
                        {renameSaving ? tCommon("loading") : tCommon("save")}
                      </button>
                      <button
                        type="button"
                        onClick={cancelRename}
                        disabled={renameSaving}
                        className="whitespace-nowrap rounded-lg border border-gray-500 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600 disabled:opacity-50"
                      >
                        {tCommon("cancel")}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-white break-all">{defaultRowDisplayName}</span>
                        <p className="mt-0.5 text-xs text-gray-400">
                          {t("cardPackModal.defaultRowDescription")}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={startRenameDefault}
                          disabled={hasChanges || isRenaming}
                          aria-label="Rename default pack"
                          className="rounded border border-gray-500 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {t("cardPackModal.rename")}
                        </button>
                        <span className="rounded bg-gray-600 px-2 py-1 text-xs text-gray-300">
                          {t("cardPackModal.cannotDelete")}
                        </span>
                      </div>
                    </div>
                  )}
                  {editingDefault && renameError && (
                    <p className="mt-2 text-sm text-red-400">{renameError}</p>
                  )}
                </li>

                {list.length === 0 && (
                  <li>
                    <p className="text-sm text-gray-500">
                      {t("cardPackModal.empty")}
                    </p>
                  </li>
                )}

                {list.map((value) => (
                  <li
                    key={value}
                    className="rounded-lg bg-gray-700 px-4 py-2"
                  >
                    {editingPack === value ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          autoFocus
                          value={renameInput}
                          maxLength={MAX_COLLECTION_NAME_LENGTH}
                          disabled={renameSaving}
                          onChange={(e) => setRenameInput(e.target.value)}
                          onKeyDown={(e) => {
                            // Issue #613: IME変換確定のEnterで誤って保存が走らないようにする
                            if (isEnterKeySubmit(e)) {
                              e.preventDefault();
                              handleRenamePackSave();
                            } else if (e.key === "Escape") {
                              cancelRename();
                            }
                          }}
                          className="w-full min-w-0 rounded-lg bg-gray-600 px-3 py-1.5 text-white placeholder:text-gray-400 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        <button
                          type="button"
                          onClick={handleRenamePackSave}
                          disabled={renameSaving}
                          className="whitespace-nowrap rounded-lg bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
                        >
                          {renameSaving ? tCommon("loading") : tCommon("save")}
                        </button>
                        <button
                          type="button"
                          onClick={cancelRename}
                          disabled={renameSaving}
                          className="whitespace-nowrap rounded-lg border border-gray-500 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600 disabled:opacity-50"
                        >
                          {tCommon("cancel")}
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-white break-all">{value}</span>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => startRenamePack(value)}
                            disabled={hasChanges || isRenaming}
                            aria-label={`Rename ${value}`}
                            className="rounded border border-gray-500 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {t("cardPackModal.rename")}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemove(value)}
                            disabled={isRenaming}
                            className="text-gray-400 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`Remove ${value}`}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              className="h-5 w-5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          </button>
                        </div>
                      </div>
                    )}
                    {editingPack === value && renameError && (
                      <p className="mt-2 text-sm text-red-400">{renameError}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <p className="mt-3 text-xs text-gray-500">
              {t("cardPackModal.deleteNote")}
            </p>
          </div>
        </div>

        {/* フッター */}
        <div className="p-6 border-t border-gray-700 flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hasChanges || isRenaming}
            className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? t("cardPackModal.saving") : t("cardPackModal.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
