"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { OVERLAY_AURA_COLOR_VARS } from "@/lib/overlay-effect";
import styles from "./OverlayAura.module.css";

// 炎の高さは上辺を大きく、底は熾火がにじむ程度にする。キャンバスの余白には
// 透明になるまでの幅も含め、発光が矩形の端で切れないようにする。
const PADDING = { top: 68, side: 38, bottom: 20 };
const FRAME_INTERVAL = 1000 / 30;

type Color = readonly [number, number, number];

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const mix = (from: number, to: number, fraction: number) => from + (to - from) * fraction;
const smooth = (fraction: number) => fraction * fraction * (3 - 2 * fraction);

// 周期的な格子を補間して時間・座標の両方向で滑らかなノイズを得る。1つの格子を
// 全フレームで共有し、粒子の発生リストやフレームごとの乱数・メモリ確保を持たない。
const noiseGrid = new Float32Array(64 * 64);
let seed = 2088;
for (let index = 0; index < noiseGrid.length; index++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  noiseGrid[index] = seed / 4294967296;
}

function noise(x: number, y: number): number {
  const floorX = Math.floor(x);
  const floorY = Math.floor(y);
  const tx = smooth(x - floorX);
  const ty = smooth(y - floorY);
  const left = floorX & 63;
  const right = (floorX + 1) & 63;
  const top = (floorY & 63) * 64;
  const bottom = ((floorY + 1) & 63) * 64;
  return mix(
    mix(noiseGrid[top + left], noiseGrid[top + right], tx),
    mix(noiseGrid[bottom + left], noiseGrid[bottom + right], tx),
    ty,
  );
}

function palette(colorFrom: string, colorTo: string): Uint8ClampedArray {
  const rgb = (hex: string): Color => {
    // カスタムレアリティ設定が許容する #RGB も8ビットの各色成分へ展開する。
    const digits = hex.length === 4 ? hex.slice(1).replace(/./g, (digit) => digit + digit) : hex.slice(1);
    const number = parseInt(digits, 16);
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  };
  const from = rgb(colorFrom);
  const to = rgb(colorTo);
  const colors = new Uint8ClampedArray(256 * 3);
  for (let index = 0; index < 256; index++) {
    const heat = index / 255;
    for (let channel = 0; channel < 3; channel++) {
      // 先端はレアリティの深い色、炎の中央は明るい色、根元だけ白熱させる。
      colors[index * 3 + channel] = heat < 0.58
        ? mix(to[channel] * 0.82, from[channel], heat / 0.58)
        : mix(from[channel], 255, (heat - 0.58) / 0.42 * 0.91);
    }
  }
  return colors;
}

function createFlame(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  radius: number,
  topReach: number,
  colors: Uint8ClampedArray,
) {
  const paddedWidth = width + PADDING.side * 2;
  const paddedHeight = height + PADDING.top + PADDING.bottom;
  // 解像度を CSS ピクセルより低く固定して、OBS のDPRや出力解像度に描画負荷が
  // 比例しないようにする。拡大補間は炎の柔らかい輪郭にも使う。
  const scale = Math.min(0.58, 240 / paddedWidth, 320 / paddedHeight);
  const pixelWidth = canvas.width = Math.ceil(paddedWidth * scale);
  const pixelHeight = canvas.height = Math.ceil(paddedHeight * scale);
  const stepX = paddedWidth / pixelWidth;
  const stepY = paddedHeight / pixelHeight;
  const image = context.createImageData(pixelWidth, pixelHeight);
  const distances = new Float32Array(pixelWidth * pixelHeight);
  const reach = new Float32Array(distances.length);
  const topBlend = new Float32Array(pixelHeight);
  const topProfile = new Float32Array(pixelWidth);
  const topBend = new Float32Array(pixelWidth);
  const corner = Math.min(radius, width / 2, height / 2);

  for (let row = 0; row < pixelHeight; row++) {
    const y = (row + 0.5) * stepY - PADDING.top;
    const topWeight = smooth(clamp((12 - y) / 22));
    const bottomWeight = smooth(clamp((y - height + 10) / 15));
    topBlend[row] = topWeight;
    for (let col = 0; col < pixelWidth; col++) {
      const x = (col + 0.5) * stepX - PADDING.side;
      const dx = Math.abs(x - width / 2) - width / 2 + corner;
      const dy = Math.abs(y - height / 2) - height / 2 + corner;
      const index = row * pixelWidth + col;
      // 角丸矩形までの符号付き距離。四辺を同じ場として扱うので角で炎が途切れない。
      distances[index] = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
        + Math.min(0, Math.max(dx, dy)) - corner;
      const sideWeight = clamp(Math.max(-x, x - width) / 28);
      reach[index] = mix(27, topReach, topWeight * (1 - sideWeight)) - 18 * bottomWeight;
    }
  }

  return (time: number) => {
    for (let col = 0; col < pixelWidth; col++) {
      const x = col * stepX;
      const billow = noise(x * 0.036 - time * 0.36, time * 1.8);
      const tongues = noise(x * 0.093 + time * 0.24, 17 + time * 1.35);
      // 幅広い火のうねりに、細く伸びる先端を混ぜて高さの違う舌を作る。
      topProfile[col] = 0.11 + 0.45 * billow ** 1.3 + 0.5 * tongues ** 2.4;
      topBend[col] = 0.43 * Math.sin(x * 0.029 + time * 2.4);
    }
    for (let row = 0; row < pixelHeight; row++) {
      const y = row * stepY;
      const flow = y + time * 48;
      const bendHeight = Math.max(0, PADDING.top - y) / stepX;
      const left = 0.19 + 0.74 * noise(flow * 0.049, 9 + time * 0.62) ** 1.65;
      const right = 0.19 + 0.74 * noise(flow * 0.049, 25 + time * 0.65) ** 1.65;
      for (let col = 0; col < pixelWidth; col++) {
        const index = row * pixelWidth + col;
        const distance = distances[index];
        const colorIndex = index * 4;
        if (distance < -4 || distance > reach[index]) continue;

        // 座標を先端ほど横へずらし、根元を固定したまま炎の舌を曲げる。
        const tip = Math.max(0, Math.min(pixelWidth - 1, col + bendHeight * topBend[col]));
        const tipIndex = Math.floor(tip);
        const crown = mix(topProfile[tipIndex], topProfile[Math.min(tipIndex + 1, pixelWidth - 1)], tip - tipIndex);
        const contour = mix(col < pixelWidth / 2 ? left : right, crown, topBlend[row]);
        const depth = Math.max(0, distance) / reach[index];
        const fuel = contour - depth;
        const edge = smooth(clamp((fuel + 0.016) / 0.067));
        // 輪郭と根元は毎フレームつながったまま。炎の内側の濃淡だけを上方へ
        // 流し、ひと塊が上下するのではなく根元から燃料が湧き出すように見せる。
        const streak = noise(col * stepX * 0.075 + depth * 0.85, flow * 0.047);
        const heat = clamp(0.09 + fuel * 1.04 + streak * 0.31 + (1 - depth) * 0.12);
        const glow = smooth(clamp((fuel + 0.14) / 0.14)) * 0.25;
        const fadeAtLimit = smooth(clamp((1 - depth) / 0.12));
        const alpha = clamp((edge * (0.84 - depth * 0.24) + glow) * clamp((distance + 4) / 3))
          * fadeAtLimit;
        const paletteIndex = Math.floor(255 * heat) * 3;
        image.data[colorIndex] = colors[paletteIndex];
        image.data[colorIndex + 1] = colors[paletteIndex + 1];
        image.data[colorIndex + 2] = colors[paletteIndex + 2];
        image.data[colorIndex + 3] = alpha * 255;
      }
    }
    context.putImageData(image, 0, 0);
  };
}

interface OverlayAuraProps {
  colorFrom: string;
  colorTo: string;
  cornerRadius: number;
}

export function OverlayAura({ colorFrom, colorTo, cornerRadius }: OverlayAuraProps) {
  const edgeRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const edge = edgeRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!edge || !canvas || !context) return;

    const colors = palette(colorFrom, colorTo);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const card = edge.closest<HTMLElement>('[data-overlay-card="true"]');
    const startedAt = performance.now();
    let frame: number | undefined;
    let lastFrame = -Infinity;
    let draw: ((time: number) => void) | undefined;

    const animate = (now: number) => {
      if (now - lastFrame >= FRAME_INTERVAL) {
        draw?.((now - startedAt) / 1000);
        lastFrame = now - (Number.isFinite(lastFrame) ? (now - lastFrame) % FRAME_INTERVAL : 0);
      }
      frame = requestAnimationFrame(animate);
    };

    const syncMotion = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      // 静止時も根元と炎のシルエットは描画する。設定変更と再計測も同じ経路を通す。
      if (motion.matches) draw?.(0.42);
      else if (draw) frame = requestAnimationFrame(animate);
    };

    const resize = () => {
      const { clientWidth, clientHeight } = edge;
      // 縦長画像や付帯情報がある場合は、中央寄せされたカード全体の上下余白に
      // 応じて炎の上昇範囲を縮める。カードの入場 scale は寸法に含めない。
      const topMargin = (window.innerHeight - (card?.offsetHeight ?? clientHeight)) / 2;
      const topReach = Math.max(1, Math.min(61, topMargin - 6));
      draw = clientWidth && clientHeight
        ? createFlame(canvas, context, clientWidth, clientHeight, cornerRadius, topReach, colors)
        : undefined;
      syncMotion();
    };

    // clientWidth/Height はカード入退場の scale を含まない。画像や小表示のサイズが
    // 確定し直したときだけバッファを作り直し、通常のアニメーション中は使い回す。
    const observer = new ResizeObserver(resize);
    observer.observe(edge);
    if (card) observer.observe(card);
    window.addEventListener("resize", resize);
    motion.addEventListener("change", syncMotion);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      motion.removeEventListener("change", syncMotion);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [colorFrom, colorTo, cornerRadius]);

  return (
    <div
      ref={edgeRef}
      className={`pointer-events-none absolute inset-0 ${styles.glow}`}
      aria-hidden="true"
      data-overlay-aura="true"
      style={{
        borderRadius: cornerRadius,
        [OVERLAY_AURA_COLOR_VARS.from]: colorFrom,
        [OVERLAY_AURA_COLOR_VARS.to]: colorTo,
      } as CSSProperties}
    >
      <canvas
        ref={canvasRef}
        className="absolute max-w-none"
        style={{
          left: -PADDING.side,
          top: -PADDING.top,
          width: `calc(100% + ${PADDING.side * 2}px)`,
          height: `calc(100% + ${PADDING.top + PADDING.bottom}px)`,
        }}
      />
    </div>
  );
}
