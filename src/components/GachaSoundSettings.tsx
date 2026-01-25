"use client";

import { useState, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { SOUND_UPLOAD_CONFIG } from "@/lib/constants";

interface GachaSoundSettingsProps {
  streamerId: string;
  // 現在の効果音URL（null=未設定）
  currentSoundUrl: string | null;
  // 効果音の有効/無効状態
  currentSoundEnabled: boolean;
}

/**
 * CookieからCSRFトークンを取得するヘルパー関数
 * CSRF保護のためにすべてのAPI呼び出しで使用
 */
function getCsrfTokenFromCookie(): string {
  if (typeof document === "undefined") return "";
  return document.cookie
    .split("; ")
    .find(row => row.startsWith("csrf_token="))
    ?.split("=")[1] || "";
}

/**
 * ガチャ効果音設定コンポーネント
 * 効果音のアップロード、プレビュー再生、有効/無効切り替えを管理
 */
export default function GachaSoundSettings({
  streamerId,
  currentSoundUrl,
  currentSoundEnabled,
}: GachaSoundSettingsProps) {
  const t = useTranslations("gachaSoundSettings");
  const tCommon = useTranslations("common");

  // State管理
  const [soundUrl, setSoundUrl] = useState<string | null>(currentSoundUrl);
  const [soundEnabled, setSoundEnabled] = useState(currentSoundEnabled);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  // オーディオ要素への参照
  const audioRef = useRef<HTMLAudioElement>(null);
  // ファイル入力への参照
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * 効果音ファイルをアップロード
   * 1MB以下のMP3/WAV/WebM/OGGファイルのみ許可
   */
  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // ファイルサイズチェック（クライアント側）
    if (file.size > SOUND_UPLOAD_CONFIG.MAX_FILE_SIZE) {
      setMessage(t("errors.fileTooLarge"));
      setIsError(true);
      return;
    }

    // ファイルタイプチェック（クライアント側）
    const allowedTypes = SOUND_UPLOAD_CONFIG.ALLOWED_TYPES as readonly string[];
    if (!allowedTypes.includes(file.type)) {
      setMessage(t("errors.invalidFileType"));
      setIsError(true);
      return;
    }

    setUploading(true);
    setMessage("");
    setIsError(false);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/upload/sound", {
        method: "POST",
        credentials: "include",
        headers: {
          "X-CSRF-Token": getCsrfTokenFromCookie(),
        },
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        setSoundUrl(data.url);
        setMessage(t("messages.uploadSuccess"));
        setIsError(false);

        // 自動的に設定を保存
        await saveSettings(data.url, soundEnabled);
      } else if (response.status === 429) {
        const errorData = await response.json();
        setMessage(errorData.error || t("errors.rateLimit"));
        setIsError(true);
      } else {
        const errorData = await response.json();
        setMessage(errorData.error || t("errors.uploadFailed"));
        setIsError(true);
      }
    } catch (error) {
      logger.error("Sound upload error:", error);
      setMessage(t("errors.uploadFailed"));
      setIsError(true);
    } finally {
      setUploading(false);
      // ファイル入力をリセット（同じファイルを再度選択可能にする）
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [soundEnabled, t, streamerId]);

  /**
   * 効果音設定を保存
   */
  const saveSettings = async (url: string | null, enabled: boolean) => {
    setSaving(true);
    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfTokenFromCookie(),
        },
        body: JSON.stringify({
          streamerId,
          gachaSoundUrl: url,
          gachaSoundEnabled: enabled,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        setMessage(errorData.error || t("errors.saveFailed"));
        setIsError(true);
        return false;
      }

      return true;
    } catch (error) {
      logger.error("Save settings error:", error);
      setMessage(t("errors.saveFailed"));
      setIsError(true);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /**
   * 効果音の有効/無効を切り替え
   */
  const handleToggleEnabled = useCallback(async () => {
    const newEnabled = !soundEnabled;
    setSoundEnabled(newEnabled);

    const success = await saveSettings(soundUrl, newEnabled);
    if (success) {
      setMessage(newEnabled ? t("messages.enabled") : t("messages.disabled"));
      setIsError(false);
    } else {
      // 失敗した場合は元に戻す
      setSoundEnabled(!newEnabled);
    }
  }, [soundEnabled, soundUrl, t]);

  /**
   * 効果音を削除
   */
  const handleDelete = useCallback(async () => {
    if (!soundUrl) return;

    // 削除確認
    if (!confirm(t("confirmDelete"))) {
      return;
    }

    setDeleting(true);
    setMessage("");
    setIsError(false);

    try {
      // R2から削除
      const deleteResponse = await fetch("/api/upload/sound", {
        method: "DELETE",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfTokenFromCookie(),
        },
        body: JSON.stringify({ url: soundUrl }),
      });

      if (!deleteResponse.ok) {
        const errorData = await deleteResponse.json();
        setMessage(errorData.error || t("errors.deleteFailed"));
        setIsError(true);
        return;
      }

      // 設定を更新（URLをnullに）
      const success = await saveSettings(null, soundEnabled);
      if (success) {
        setSoundUrl(null);
        setMessage(t("messages.deleted"));
        setIsError(false);
      }
    } catch (error) {
      logger.error("Delete sound error:", error);
      setMessage(t("errors.deleteFailed"));
      setIsError(true);
    } finally {
      setDeleting(false);
    }
  }, [soundUrl, soundEnabled, t, streamerId]);

  /**
   * プレビュー再生
   */
  const handlePlayPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch((error) => {
        logger.error("Audio play error:", error);
      });
    }
  }, []);

  /**
   * プレビュー停止
   */
  const handleStopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, []);

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">
          {t("title")}
        </h2>
        {/* 有効/無効ステータス表示 */}
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${
            soundEnabled && soundUrl
              ? "bg-green-500/20 text-green-400"
              : "bg-gray-500/20 text-gray-400"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              soundEnabled && soundUrl ? "bg-green-500" : "bg-gray-500"
            }`}
          />
          {soundEnabled && soundUrl ? t("status.enabled") : t("status.disabled")}
        </span>
      </div>

      <p className="mb-4 text-sm text-gray-400">
        {t("description")}
      </p>

      <div className="space-y-4">
        {/* ファイルアップロード */}
        <div>
          <label className="mb-1 block text-sm text-gray-300">
            {t("form.selectFile")}
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={SOUND_UPLOAD_CONFIG.ALLOWED_EXTENSIONS.map(ext => `.${ext}`).join(",")}
              onChange={handleFileUpload}
              disabled={uploading}
              className="block w-full text-sm text-gray-400
                file:mr-4 file:rounded-lg file:border-0
                file:bg-purple-600 file:px-4 file:py-2
                file:text-sm file:font-medium file:text-white
                hover:file:bg-purple-700 file:disabled:opacity-50
                file:cursor-pointer file:disabled:cursor-not-allowed"
            />
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {t("form.fileRequirements", {
              formats: SOUND_UPLOAD_CONFIG.ALLOWED_EXTENSIONS.map(ext => ext.toUpperCase()).join(", "),
              maxSize: "1MB",
            })}
          </p>
        </div>

        {/* 現在の効果音 */}
        {soundUrl && (
          <div className="rounded-lg bg-gray-700 p-4">
            <p className="mb-2 text-sm text-gray-300">
              {t("form.currentSound")}
            </p>
            {/* オーディオプレビュー */}
            <audio ref={audioRef} src={soundUrl} preload="metadata" />
            <div className="flex items-center gap-2">
              <button
                onClick={handlePlayPreview}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
              >
                {t("buttons.play")}
              </button>
              <button
                onClick={handleStopPreview}
                className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
              >
                {t("buttons.stop")}
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? tCommon("loading") : t("buttons.delete")}
              </button>
            </div>
          </div>
        )}

        {/* 有効/無効切り替え */}
        <div className="flex items-center gap-3">
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={soundEnabled}
              onChange={handleToggleEnabled}
              disabled={saving || !soundUrl}
              className="peer sr-only"
            />
            <div
              className={`h-6 w-11 rounded-full bg-gray-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-disabled:opacity-50 ${
                !soundUrl ? "opacity-50" : ""
              }`}
            />
          </label>
          <span className={`text-sm ${soundUrl ? "text-gray-300" : "text-gray-500"}`}>
            {t("form.enableSound")}
          </span>
          {!soundUrl && (
            <span className="text-xs text-gray-500">
              ({t("form.uploadFirst")})
            </span>
          )}
        </div>

        {/* ステータスメッセージ */}
        {message && (
          <p className={`text-sm ${isError ? "text-red-400" : "text-green-400"}`}>
            {message}
          </p>
        )}

        {/* ローディング表示 */}
        {(uploading || saving) && (
          <p className="text-sm text-gray-400">
            {uploading ? t("messages.uploading") : t("messages.saving")}
          </p>
        )}
      </div>
    </div>
  );
}
