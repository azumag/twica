/// <reference types="vite/client" />

// #701: browser側は/__admin API経由のみでデータ取得するため、import.meta.envで
// 読むカスタム環境変数は無くなった。vite/clientの既定ImportMetaEnvで十分なため
// 独自宣言はしない。旧ダッシュボード用Supabase接続の環境変数群は
// analysis/dev/localAdminApi.ts (Node dev server側)がまだ読んでいるが、
// それはVite設定から渡されるenvオブジェクト経由でimport.meta.envとは
// 無関係のため、ここへの影響はない
