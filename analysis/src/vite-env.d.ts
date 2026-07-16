/// <reference types="vite/client" />

// #701: browser側は/__admin API経由のみでデータ取得するため、import.meta.envで
// 読むカスタム環境変数は無くなった。vite/clientの既定ImportMetaEnvで十分なため
// 独自宣言はしない。VITE_DASHBOARD_SUPABASE_*はanalysis/dev/localAdminApi.ts
// (Node dev server側)がまだ読んでいるが、それはVite設定から渡されるenv
// オブジェクト経由でimport.meta.envとは無関係のため、ここへの影響はない
