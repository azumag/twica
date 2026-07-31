/**
 * Analysis dashboardのサーバー側ページングで許可する最大ページ番号。
 *
 * API側でも同じ上限を検証している。OFFSETはページ番号に比例してDBが
 * 先頭行を読み捨てるため、上限を設けないと「ページ番号だけ大きい」要求が
 * DB負荷を意図せず増やす。DataTableにも同じ値を渡し、UIが表示する最後の
 * ページとAPIが受け付ける最後のページを一致させる。
 */
export const MAX_ANALYSIS_PAGE = 1000
