import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { MAX_ANALYSIS_PAGE } from '../../../analysis/src/lib/pagination'

const dataTableSource = readFileSync(
  resolve(process.cwd(), 'analysis/src/components/DataTable.tsx'),
  'utf8'
)
const normalizedSource = dataTableSource.replace(/\s+/g, ' ')

describe('analysis DataTable server pagination guard', () => {
  it('APIの最大ページ番号と同じ1000ページでUIを止める', () => {
    // ここは React の実レンダリングをしない。
    // root Vitest と analysis 配下 node_modules で React 実体が二重に解決されると、
    // JSX レンダリングが「older version of React」で落ちるため、契約そのものを
    // source-level で固定するほうがこのリポジトリでは安定する。
    expect(MAX_ANALYSIS_PAGE).toBe(1000)
    expect(normalizedSource).toContain('Math.max(pagination?.maxPage ?? MAX_ANALYSIS_PAGE, 1)')
    expect(normalizedSource).toContain('const pageLimitReached = isServerPagination && fullTotalPages > totalPages')
    expect(normalizedSource).toContain('負荷保護のため先頭{Math.min(totalPages * pageSize, totalItems)}件まで')
  })

  it('最後のページ遷移は現在ページに対して+1を送る', () => {
    // DataTable の「次へ」ボタンは currentPage + 1 を送る実装でなければ、
    // 1000ページ到達時に最終ページへ前進できない。レンダリング不要な
    // source-level ガードとして、遷移ロジックの契約だけを検証する。
    expect(normalizedSource).toContain('onClick={() => pagination.onPageChange(currentPage + 1)}')
    expect(normalizedSource).toContain('{currentPage} / {totalPages}')
  })

  it('countとrowsの競合で空ページになったら親を最終ページへ戻す', () => {
    // data=[]かつtotalItems>0のときにページャーを先にreturnすると、
    // currentPageが新しい最終ページを越えたまま固定される。effectで親へ
    // クランプ値を通知する契約をsource-levelで固定する。
    expect(normalizedSource).toContain('data.length !== 0')
    expect(normalizedSource).toContain('totalItems <= 0')
    expect(normalizedSource).toContain('const recoveryPage =')
    expect(normalizedSource).toContain('Math.max(currentPage - 1, 1)')
    expect(normalizedSource).toContain('loading ||')
    expect(normalizedSource).toContain('requestedPage === recoveryPage')
    expect(normalizedSource).toContain('onPageChange(recoveryPage)')
  })
})
