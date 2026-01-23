"use client";

import { useState, useRef, useCallback } from "react";
import ReactCrop, { type Crop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

// Crop mode type: square or portrait
// トリミングモードの型：正方形またはポートレイト
export type CropMode = "square" | "portrait";

// Output dimensions configuration for each crop mode
// 各トリミングモードの出力サイズ設定
export const CROP_MODES = {
  // Square mode: 800x800 pixels (1:1 aspect ratio)
  // 正方形モード: 800x800ピクセル（1:1のアスペクト比）
  square: {
    width: 800,
    height: 800,
    aspect: 1, // 1:1 aspect ratio
    label: "正方形",
    labelEn: "Square",
    dimensions: "800x800",
  },
  // Portrait mode: 800x1118 pixels (approximately 5:7 aspect ratio)
  // ポートレイトモード: 800x1118ピクセル（約5:7のアスペクト比）
  portrait: {
    width: 800,
    height: 1118,
    aspect: 800 / 1118, // approximately 0.716
    label: "ポートレイト",
    labelEn: "Portrait",
    dimensions: "800x1118",
  },
} as const;

// Props for the ImageCropper component
// ImageCropperコンポーネントのプロパティ
interface ImageCropperProps {
  // Source image file to crop
  // トリミング対象の画像ファイル
  imageFile: File;
  // Crop mode: square (800x800) or portrait (800x1118)
  // トリミングモード: 正方形(800x800)またはポートレイト(800x1118)
  cropMode: CropMode;
  // Callback when cropping is confirmed, returns the cropped image as a Blob
  // トリミング確定時のコールバック、トリミング済み画像をBlobで返す
  onCropComplete: (croppedBlob: Blob) => void;
  // Callback when cancel button is clicked
  // キャンセルボタンクリック時のコールバック
  onCancel: () => void;
}

/**
 * Creates a centered crop for the initial display based on crop mode
 * トリミングモードに基づいて初期表示用の中央配置されたクロップを作成
 * @param mediaWidth - Width of the loaded image
 * @param mediaHeight - Height of the loaded image
 * @param aspect - Aspect ratio for the crop (width/height)
 * @returns Centered crop with the specified aspect ratio
 */
function centerAspectCrop(mediaWidth: number, mediaHeight: number, aspect: number): Crop {
  return centerCrop(
    makeAspectCrop(
      {
        unit: "%",
        // Start with a crop that covers 90% of the smaller dimension
        // 小さい方の辺の90%をカバーするクロップから開始
        width: 90,
      },
      aspect, // Aspect ratio based on crop mode
      mediaWidth,
      mediaHeight
    ),
    mediaWidth,
    mediaHeight
  );
}

/**
 * ImageCropper component that allows users to select a region of an image
 * and outputs a cropped image based on the selected crop mode
 *
 * ユーザーが画像の領域を選択し、選択されたトリミングモードに基づいてトリミング画像を出力するコンポーネント
 */
export default function ImageCropper({ imageFile, cropMode, onCropComplete, onCancel }: ImageCropperProps) {
  // Get crop mode configuration
  // トリミングモードの設定を取得
  const cropConfig = CROP_MODES[cropMode];
  // Current crop selection state
  // 現在のクロップ選択状態
  const [crop, setCrop] = useState<Crop>();
  // Processing state for the crop operation
  // トリミング処理中の状態
  const [processing, setProcessing] = useState(false);
  // Reference to the image element for canvas operations
  // Canvas操作用の画像要素への参照
  const imgRef = useRef<HTMLImageElement>(null);
  // Object URL for displaying the image (needs cleanup)
  // 画像表示用のObject URL（クリーンアップが必要）
  const [previewUrl] = useState(() => URL.createObjectURL(imageFile));

  /**
   * Called when the image loads to initialize the centered crop
   * 画像読み込み時に呼ばれ、中央配置のクロップを初期化
   */
  const onImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const { width, height } = e.currentTarget;
    setCrop(centerAspectCrop(width, height, cropConfig.aspect));
  }, [cropConfig.aspect]);

  /**
   * Creates a canvas with the cropped and resized image
   * トリミング・リサイズ済み画像のCanvasを作成
   *
   * Uses Canvas API to:
   * 1. Extract the selected crop region from the source image
   * 2. Resize it to the dimensions specified by crop mode
   * 3. Export as JPEG for universal browser support
   *
   * Canvas APIを使用して:
   * 1. ソース画像から選択されたクロップ領域を抽出
   * 2. トリミングモードで指定されたサイズにリサイズ
   * 3. 全ブラウザ対応のJPEG形式でエクスポート
   */
  const getCroppedImg = useCallback(async (): Promise<Blob | null> => {
    const image = imgRef.current;
    if (!image || !crop) return null;

    // Create an offscreen canvas for the crop operation
    // クロップ操作用のオフスクリーンCanvasを作成
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Calculate the actual pixel values from the percentage-based crop
    // パーセンテージベースのクロップから実際のピクセル値を計算
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;

    const pixelCrop = {
      x: (crop.x / 100) * image.width * scaleX,
      y: (crop.y / 100) * image.height * scaleY,
      width: (crop.width / 100) * image.width * scaleX,
      height: (crop.height / 100) * image.height * scaleY,
    };

    // Set canvas size to the desired output dimensions based on crop mode
    // トリミングモードに基づいて目的の出力サイズにCanvasサイズを設定
    canvas.width = cropConfig.width;
    canvas.height = cropConfig.height;

    // Enable image smoothing for better quality when resizing
    // リサイズ時の品質向上のため画像スムージングを有効化
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Draw the cropped region, scaled to fit the output canvas
    // クロップ領域を出力Canvasに合わせてスケーリングして描画
    ctx.drawImage(
      image,
      pixelCrop.x,
      pixelCrop.y,
      pixelCrop.width,
      pixelCrop.height,
      0,
      0,
      cropConfig.width,
      cropConfig.height
    );

    // Convert canvas to Blob using JPEG format (universally supported)
    // すべてのブラウザでサポートされているJPEG形式でCanvasをBlobに変換
    // Note: WebP is not supported in all browsers' Canvas API
    // 注意: WebPはすべてのブラウザのCanvas APIでサポートされていない
    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => resolve(blob),
        "image/jpeg",
        0.85 // 85% quality provides good balance between size and quality
      );
    });
  }, [crop, cropConfig.width, cropConfig.height]);

  /**
   * Handles the confirm button click
   * 確定ボタンクリック時の処理
   */
  const handleConfirm = async () => {
    setProcessing(true);
    try {
      const croppedBlob = await getCroppedImg();
      if (croppedBlob) {
        // Clean up the preview URL to prevent memory leaks
        // メモリリーク防止のためプレビューURLをクリーンアップ
        URL.revokeObjectURL(previewUrl);
        onCropComplete(croppedBlob);
      }
    } finally {
      setProcessing(false);
    }
  };

  /**
   * Handles the cancel button click
   * キャンセルボタンクリック時の処理
   */
  const handleCancel = () => {
    // Clean up the preview URL
    // プレビューURLをクリーンアップ
    URL.revokeObjectURL(previewUrl);
    onCancel();
  };

  return (
    // Modal overlay with dark background
    // ダーク背景のモーダルオーバーレイ
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-gray-800 shadow-2xl">
        {/* Modal header with title and close button */}
        {/* タイトルと閉じるボタン付きのモーダルヘッダー */}
        <div className="flex items-center justify-between border-b border-gray-700 p-4">
          <h3 className="text-lg font-semibold text-white">
            画像をトリミング
          </h3>
          <button
            type="button"
            onClick={handleCancel}
            className="text-gray-400 hover:text-white"
            aria-label="閉じる"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Crop area container */}
        {/* トリミングエリアのコンテナ */}
        <div className="p-4">
          <p className="mb-3 text-sm text-gray-400">
            ドラッグして位置とサイズを調整してください（{cropConfig.dimensions}にトリミングされます）
          </p>
          <div className="flex justify-center rounded-lg bg-gray-900 p-2">
            <ReactCrop
              crop={crop}
              onChange={(_, percentCrop) => setCrop(percentCrop)}
              aspect={cropConfig.aspect} // Aspect ratio based on crop mode
              className="max-h-[60vh]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={previewUrl}
                alt="トリミング対象の画像"
                onLoad={onImageLoad}
                className="max-h-[60vh] max-w-full object-contain"
              />
            </ReactCrop>
          </div>
        </div>

        {/* Action buttons */}
        {/* アクションボタン */}
        <div className="flex justify-end gap-3 border-t border-gray-700 p-4">
          <button
            type="button"
            onClick={handleCancel}
            disabled={processing}
            className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-700 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={processing || !crop}
            className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {processing ? "処理中..." : "確定"}
          </button>
        </div>
      </div>
    </div>
  );
}
