import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getOptimizedImageUrl } from "@/lib/image-utils";

describe("getOptimizedImageUrl", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalEnabled = process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED;

  afterEach(() => {
    if (originalAppUrl !== undefined) {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    } else {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
    if (originalEnabled !== undefined) {
      process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED = originalEnabled;
    } else {
      delete process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED;
    }
  });

  describe("本番環境 (https + enabled + 同一ゾーン)", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_URL = "https://twica.bluemoon.works";
      process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED = "true";
    });

    it("thumbnailプリセットで正しいURLを生成する", () => {
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toBe(
        "https://twica.bluemoon.works/cdn-cgi/image/width=300,format=auto,quality=80,onerror=redirect/https://image.twica.bluemoon.works/cards/test.jpg"
      );
    });

    it("iconプリセットで正しいURLを生成する", () => {
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "icon");

      expect(result).toBe(
        "https://twica.bluemoon.works/cdn-cgi/image/width=96,format=auto,quality=80,onerror=redirect/https://image.twica.bluemoon.works/cards/test.jpg"
      );
    });

    it("onerror=redirectパラメータが含まれている", () => {
      const url = "https://image.twica.bluemoon.works/test.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toContain("onerror=redirect");
    });

    it("format=autoパラメータが含まれている（WebP自動変換）", () => {
      const url = "https://image.twica.bluemoon.works/test.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toContain("format=auto");
    });
  });

  describe("ゾーン外の画像URL（変換しない）", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_URL = "https://twica.bluemoon.works";
      process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED = "true";
    });

    it("r2.dev ドメインの画像はオリジナルURLを返す", () => {
      const url = "https://pub-c02c25e03cab49ea9f36afd3f7d2e167.r2.dev/test.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toBe(url);
    });

    it("Twitch CDN の画像はオリジナルURLを返す", () => {
      const url = "https://static-cdn.jtvnw.net/emoticons/v2/123/default/dark/3.0";
      const result = getOptimizedImageUrl(url, "icon");

      expect(result).toBe(url);
    });

    it("その他の外部ドメインもオリジナルURLを返す", () => {
      const url = "https://example.com/image.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toBe(url);
    });
  });

  describe("開発環境 (localhost)", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:8787";
      process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED = "true";
    });

    it("HTTPではオリジナルURLをそのまま返す", () => {
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toBe(url);
    });
  });

  describe("フラグ未設定 (HTTPS but not enabled)", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_URL = "https://twica.bluemoon.works";
      delete process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED;
    });

    it("フラグ未設定ではオリジナルURLをそのまま返す", () => {
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toBe(url);
    });

    it("フラグがfalseでもオリジナルURLをそのまま返す", () => {
      process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED = "false";
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "icon");

      expect(result).toBe(url);
    });
  });

  describe("環境変数未設定", () => {
    beforeEach(() => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED;
    });

    it("オリジナルURLをそのまま返す", () => {
      const url = "https://image.twica.bluemoon.works/cards/test.jpg";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toBe(url);
    });
  });

  describe("null/空URLの処理", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_URL = "https://twica.bluemoon.works";
      process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED = "true";
    });

    it("nullの場合はnullを返す", () => {
      expect(getOptimizedImageUrl(null, "thumbnail")).toBeNull();
    });

    it("空文字列の場合は空文字列を返す（型契約: string → string）", () => {
      const result: string = getOptimizedImageUrl("", "icon");
      expect(result).toBe("");
    });
  });

  describe("エッジケース", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_APP_URL = "https://twica.bluemoon.works";
      process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED = "true";
    });

    it("不正なURLはオリジナルをそのまま返す", () => {
      const url = "not-a-valid-url";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toBe(url);
    });

    it("クエリパラメータ付きの同一ゾーンURLも変換される", () => {
      const url = "https://image.twica.bluemoon.works/test.jpg?v=123";
      const result = getOptimizedImageUrl(url, "thumbnail");

      expect(result).toContain("/cdn-cgi/image/");
      expect(result).toContain(url);
    });
  });
});
