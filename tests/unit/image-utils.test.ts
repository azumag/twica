import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getOptimizedImageUrl } from "@/lib/image-utils";

describe("getOptimizedImageUrl", () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    // 環境変数を元に戻す
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_APP_URL = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });

  describe("本番環境 (https)", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_URL = "https://twica.example.com";
    });

    it("thumbnailプリセットで正しいURLを生成する", () => {
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toBe(
        "https://twica.example.com/cdn-cgi/image/width=300,format=auto,quality=80,onerror=redirect/https://image.twica.bluemoon.works/cards/test.jpg"
      );
    });

    it("iconプリセットで正しいURLを生成する", () => {
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "icon");

      expect(result).toBe(
        "https://twica.example.com/cdn-cgi/image/width=96,format=auto,quality=80,onerror=redirect/https://image.twica.bluemoon.works/cards/test.jpg"
      );
    });

    it("onerror=redirectパラメータが含まれている", () => {
      const url = "https://example.com/image.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toContain("onerror=redirect");
    });

    it("format=autoパラメータが含まれている（WebP自動変換）", () => {
      const url = "https://example.com/image.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toContain("format=auto");
    });
  });

  describe("開発環境 (localhost)", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:8787";
    });

    it("オリジナルURLをそのまま返す", () => {
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toBe(url);
    });

    it("iconプリセットでもオリジナルURLをそのまま返す", () => {
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "icon");

      expect(result).toBe(url);
    });
  });

  describe("環境変数未設定", () => {
    beforeEach(() => {
      delete process.env.NEXT_PUBLIC_APP_URL;
    });

    it("オリジナルURLをそのまま返す", () => {
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toBe(url);
    });
  });

  describe("null/空URLの処理", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_URL = "https://twica.example.com";
    });

    it("nullの場合はnullを返す", () => {
      expect(getOptimizedImageUrl(null, "thumbnail")).toBeNull();
    });

    it("空文字列の場合はnullを返す", () => {
      expect(getOptimizedImageUrl("", "icon")).toBeNull();
    });
  });

  describe("エッジケース", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_URL = "https://twica.example.com";
    });

    it("クエリパラメータ付きURLもそのまま結合される", () => {
      const url = "https://example.com/image.jpg?token=abc";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toContain(url);
    });

    it("末尾スラッシュ付きAPP_URLでも動作する", () => {
      process.env.NEXT_PUBLIC_APP_URL = "https://twica.example.com/";
      const url = "https://example.com/image.jpg";
      const result = getOptimizedImageUrl(url, "icon");

      // Cloudflare は //cdn-cgi/... でも正常に処理する
      expect(result).toContain("/cdn-cgi/image/");
      expect(result).toContain(url);
    });
  });
});
