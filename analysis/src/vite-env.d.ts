/// <reference types="vite/client" />

// #701: browser側は/__admin API経由のみでデータ取得するため、import.meta.envで
// 読むカスタム環境変数は無くなった。vite/clientの既定ImportMetaEnvで十分なため
// 独自宣言はしない。DASHBOARD_DATABASE_URLはNode dev server側だけが読み、
// Viteのブラウザ用import.meta.envには公開しない。
