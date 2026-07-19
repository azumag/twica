import { describe, expect, it } from 'vitest'
import {
  OBJECT_CATEGORY,
  stripRestrictMetacommands,
  splitIntoBlocks,
  classifyBlock,
  containsOwnerOrAclStatement,
  normalizeDump,
  neutralizePreambleSessionScope,
  findUnexpectedExclusions,
  parseCliArgs,
} from '../../../scripts/db-phase2/normalize-schema.mjs'

/**
 * scripts/db-phase2/normalize-schema.mjs の単体テスト（Issue #691 Chunk 1）。
 * 実DBには一切接続せず、fixture（pg_dump の実出力を Docker 上の検証で確認した上で
 * 組み立てた、代表的なパターンを含む合成テキスト）のみで検証する。
 *
 * FIXTURE_RAW_DUMP は以下を意図的に含む:
 *   - \restrict / \unrestrict メタコマンド（PostgreSQL 17.6+ pg_dump が付与する。
 *     Docker上のpg_dump 17.10実測で実際に出力されることを確認済み）
 *   - `public` スキーマ自身の CREATE SCHEMA / COMMENT（pg_dumpが常に出力するが、
 *     `public` は新規DBに元から存在するため除外が必要。Docker実機検証で
 *     素通しすると「schema "public" already exists」エラーになることを確認済み）
 *   - 通常のTABLE/FUNCTION/POLICYブロック（bring-as-is。POLICYがauth.uid()や
 *     service_roleを参照していても、db/planetscale/bootstrap.sqlが先に適用される
 *     前提でそのまま持ち込む設計）
 *   - ブロック間に挟まる `SET default_tablespace = '';` のような非TOCの補助文
 *     （Docker実測で実際に生じるパターン。前のブロックに束ねて保持されることを確認する）
 *   - auth スキーマ混入・owner/ACL混入という「本来は起こらないはずだが防御的に検知する」
 *     契機（--schema=public --no-owner --no-privileges を実際に使えばどちらも
 *     発生しないことをDocker実機検証で確認済みだが、防御ロジック自体は
 *     このfixtureで意図的に注入して検証する）
 *   - preambleの実際のpg_dump出力（db/planetscale/public-schema.sql 冒頭と同一構成）:
 *     `set_config('search_path', '', false)` を含む複数のセッションスコープSET文
 *     （M-5対応の neutralizePreambleSessionScope() 検証用）
 */
const FIXTURE_RAW_DUMP = `--
-- PostgreSQL database dump
--

\\restrict abc123XYZ

-- Dumped from database version 17.10 (Debian 17.10-1.pgdg13+1)
-- Dumped by pg_dump version 17.10 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cards (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    streamer_id uuid NOT NULL
);


--
-- Name: cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage cards" ON public.cards
  FOR ALL TO service_role
  USING ((auth.uid() IS NOT NULL));


--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql
    AS $$ SELECT NULL::uuid $$;


--
-- Name: cards; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.cards TO anon;


--
-- PostgreSQL database dump complete
--

\\unrestrict abc123XYZ
`

describe('stripRestrictMetacommands', () => {
  it('\\restrict / \\unrestrict 行を除去し件数を返す', () => {
    const { stripped, removedCount } = stripRestrictMetacommands(FIXTURE_RAW_DUMP)
    expect(removedCount).toBe(2)
    expect(stripped).not.toContain('\\restrict')
    expect(stripped).not.toContain('\\unrestrict')
  })

  it('\\restrict/\\unrestrict が無いテキストは無変化・0件', () => {
    const text = 'SELECT 1;\n'
    const { stripped, removedCount } = stripRestrictMetacommands(text)
    expect(removedCount).toBe(0)
    expect(stripped).toBe(text)
  })
})

describe('splitIntoBlocks', () => {
  const { stripped } = stripRestrictMetacommands(FIXTURE_RAW_DUMP)
  const { preamble, blocks } = splitIntoBlocks(stripped)

  it('preambleに\\restrict除去後の先頭コメント・SET文が入る', () => {
    expect(preamble).toContain('PostgreSQL database dump')
    expect(preamble).toContain('SET statement_timeout = 0;')
    expect(preamble).not.toContain('-- Name:')
  })

  it('TOCヘッダーを持つブロックを全て検出する（順序維持）', () => {
    expect(blocks.map((b) => `${b.type}:${b.name}`)).toEqual([
      'SCHEMA:public',
      'COMMENT:SCHEMA public',
      'FUNCTION:update_updated_at_column()',
      'TABLE:cards',
      'POLICY:cards',
      'FUNCTION:uid()',
      'ACL:cards',
    ])
  })

  it('schema/owner フィールドも正しく抽出する', () => {
    const cardsTable = blocks.find((b) => b.type === 'TABLE')
    expect(cardsTable?.schema).toBe('public')
    expect(cardsTable?.owner).toBe('-')
    const authFn = blocks.find((b) => b.type === 'FUNCTION' && b.name === 'uid()')
    expect(authFn?.schema).toBe('auth')
  })

  it('ブロック間の補助文（SET default_tablespace等）は前方のブロックのrawに含まれ、消失しない', () => {
    const fnBlock = blocks.find((b) => b.type === 'FUNCTION' && b.name === 'update_updated_at_column()')
    expect(fnBlock?.raw).toContain("SET default_tablespace = '';")
    expect(fnBlock?.raw).toContain('SET default_table_access_method = heap;')
  })

  it('round-trip不変条件: preamble + 全ブロックのraw連結 = \\restrict除去後の全文', () => {
    const reconstructed = preamble + blocks.map((b) => b.raw).join('')
    expect(reconstructed).toBe(stripped)
  })
})

describe('classifyBlock', () => {
  it('public スキーマ自身のSCHEMA/COMMENTブロックはexclude(public-schema-preexists)', () => {
    expect(classifyBlock({ name: 'public', type: 'SCHEMA', schema: '-' })).toEqual({
      category: OBJECT_CATEGORY.EXCLUDE,
      reason: 'public-schema-preexists',
    })
    expect(classifyBlock({ name: 'SCHEMA public', type: 'COMMENT', schema: '-' })).toEqual({
      category: OBJECT_CATEGORY.EXCLUDE,
      reason: 'public-schema-preexists',
    })
  })

  it('auth/realtime/storage/vault/supabase_migrationsスキーマはexclude', () => {
    for (const schema of ['auth', 'realtime', 'storage', 'vault', 'supabase_migrations']) {
      const result = classifyBlock({ name: 'x', type: 'FUNCTION', schema })
      expect(result.category).toBe(OBJECT_CATEGORY.EXCLUDE)
      expect(result.reason).toBe(`supabase-managed-schema:${schema}`)
    }
  })

  it('ACL/DEFAULT ACLタイプはexclude(owner-or-acl-defensive)', () => {
    expect(classifyBlock({ name: 'x', type: 'ACL', schema: 'public' }).category).toBe(OBJECT_CATEGORY.EXCLUDE)
    expect(classifyBlock({ name: 'x', type: 'DEFAULT ACL', schema: 'public' }).category).toBe(
      OBJECT_CATEGORY.EXCLUDE
    )
  })

  it('TABLE/FUNCTION/TRIGGER/INDEX/SEQUENCE/VIEW/CONSTRAINT/POLICY等の通常オブジェクトはbring-as-is', () => {
    for (const type of [
      'TABLE',
      'FUNCTION',
      'TRIGGER',
      'INDEX',
      'SEQUENCE',
      'VIEW',
      'CONSTRAINT',
      'FK CONSTRAINT',
      'POLICY',
      'ROW SECURITY',
      'COMMENT',
    ]) {
      expect(classifyBlock({ name: 'x', type, schema: 'public' }).category).toBe(OBJECT_CATEGORY.BRING_AS_IS)
    }
  })

  it('auth.uid()等を参照するPOLICYであってもschemaがpublicならbring-as-is（bootstrap.sqlが先に適用される前提）', () => {
    expect(classifyBlock({ name: 'cards', type: 'POLICY', schema: 'public' }).category).toBe(
      OBJECT_CATEGORY.BRING_AS_IS
    )
  })
})

describe('containsOwnerOrAclStatement (本文レベルの多重防御)', () => {
  it('ALTER ... OWNER TO を検出する', () => {
    expect(containsOwnerOrAclStatement('ALTER TABLE public.foo OWNER TO postgres;')).toBe(true)
  })

  it('GRANT/REVOKE文を検出する', () => {
    expect(containsOwnerOrAclStatement('GRANT SELECT ON TABLE public.foo TO anon;')).toBe(true)
    expect(containsOwnerOrAclStatement('REVOKE ALL ON FUNCTION public.foo() FROM PUBLIC;')).toBe(true)
  })

  it('通常のDDLには一致しない', () => {
    expect(containsOwnerOrAclStatement('CREATE TABLE public.foo (id uuid);')).toBe(false)
  })
})

describe('normalizeDump (統合)', () => {
  const result = normalizeDump(FIXTURE_RAW_DUMP)

  it('\\restrict/\\unrestrictの除去件数を報告する', () => {
    expect(result.restrictRemovedCount).toBe(2)
  })

  it('bring-as-is / exclude の件数集計が正しい', () => {
    // bring-as-is: update_updated_at_column, cards(TABLE), cards(POLICY) = 3件
    // exclude: public(SCHEMA), SCHEMA public(COMMENT), uid()(auth schema), cards(ACL) = 4件
    expect(result.countsByCategory[OBJECT_CATEGORY.BRING_AS_IS]).toBe(3)
    expect(result.countsByCategory[OBJECT_CATEGORY.EXCLUDE]).toBe(4)
    expect(result.countsByCategory[OBJECT_CATEGORY.COMPAT_BOOTSTRAP]).toBe(0)
  })

  it('出力に auth スキーマ・ACL文・public自身の再作成文が一切含まれない', () => {
    expect(result.output).not.toContain('Schema: auth')
    expect(result.output).not.toContain('GRANT SELECT ON TABLE public.cards TO anon')
    expect(result.output).not.toContain('CREATE SCHEMA public;')
    expect(result.output).not.toContain("COMMENT ON SCHEMA public IS 'standard public schema'")
  })

  it('出力に \\restrict / \\unrestrict が一切含まれない', () => {
    expect(result.output).not.toContain('\\restrict')
    expect(result.output).not.toContain('\\unrestrict')
  })

  it('bring-as-isなオブジェクトのSQLはそのまま出力に残る（auth依存policyも含む）', () => {
    expect(result.output).toContain('CREATE TABLE public.cards')
    expect(result.output).toContain('CREATE POLICY "Service role can manage cards"')
    expect(result.output).toContain('auth.uid()')
    expect(result.output).toContain('TO service_role')
  })

  it('除外したオブジェクトごとに警告メッセージを生成する', () => {
    expect(result.warnings.length).toBe(4)
    expect(result.warnings.some((w) => w.includes('public-schema-preexists'))).toBe(true)
    expect(result.warnings.some((w) => w.includes('supabase-managed-schema:auth'))).toBe(true)
    expect(result.warnings.some((w) => w.includes('owner-or-acl'))).toBe(true)
  })

  it('round-trip不変条件: 出力 + 除外ブロックを元の順序で挿し戻すと\\restrict除去後の全文に一致する', () => {
    const { stripped } = stripRestrictMetacommands(FIXTURE_RAW_DUMP)
    const reconstructed = result.preamble + result.blocks.map((b) => b.raw).join('')
    expect(reconstructed).toBe(stripped)

    // 出力（bring-as-isのみ）と全ブロックの差分が、除外ブロックの集合と一致することも確認する
    const excludedRaw = result.blocks
      .filter((b) => b.category === OBJECT_CATEGORY.EXCLUDE)
      .map((b) => b.raw)
    for (const raw of excludedRaw) {
      expect(result.output).not.toContain(raw)
    }
  })

  it('スナップショット: 正規化後の出力全体', () => {
    expect(result.output).toMatchSnapshot()
  })

  // M-5 (Fableレビュー): db-migrate.js は単一コネクション（max:1）で複数migrationファイルを
  // 順に適用するため、preambleのセッションスコープ設定がそのままだと後続migrationへ漏れる。
  // 出力（baselineへ書き込まれる内容）ではトランザクションローカルに書き換わっていることを
  // 確認する。
  it('出力のpreamble部分はセッションスコープ設定がSET LOCAL/set_config(...,true)に書き換わる', () => {
    expect(result.output).toContain('SET LOCAL statement_timeout = 0;')
    expect(result.output).toContain('SET LOCAL row_security = off;')
    expect(result.output).toContain("SELECT pg_catalog.set_config('search_path', '', true);")
    // 書き換え後の出力に、書き換え前の形（session-scope）が残っていないことも確認する
    expect(result.output).not.toContain('SET statement_timeout = 0;\n')
    expect(result.output).not.toContain("set_config('search_path', '', false)")
  })

  it('戻り値の preamble（round-trip不変条件用）は書き換え前のまま', () => {
    expect(result.preamble).toContain('SET statement_timeout = 0;')
    expect(result.preamble).toContain("set_config('search_path', '', false)")
    expect(result.preamble).not.toContain('SET LOCAL')
  })
})

describe('neutralizePreambleSessionScope (M-5対応)', () => {
  it('set_config(..., false) の第3引数を true に書き換える', () => {
    const input = "SELECT pg_catalog.set_config('search_path', '', false);\n"
    expect(neutralizePreambleSessionScope(input)).toBe(
      "SELECT pg_catalog.set_config('search_path', '', true);\n"
    )
  })

  it('素のSET文（LOCAL無し）をSET LOCALへ書き換える', () => {
    const input = 'SET statement_timeout = 0;\nSET row_security = off;\n'
    expect(neutralizePreambleSessionScope(input)).toBe(
      'SET LOCAL statement_timeout = 0;\nSET LOCAL row_security = off;\n'
    )
  })

  it('既にSET LOCALの行は二重にLOCALを付けない（冪等）', () => {
    const input = 'SET LOCAL statement_timeout = 0;\n'
    expect(neutralizePreambleSessionScope(input)).toBe(input)
  })

  it('SET/set_config を含まないテキストは無変化', () => {
    const input = '-- comment only\n'
    expect(neutralizePreambleSessionScope(input)).toBe(input)
  })
})

describe('findUnexpectedExclusions (M-2対応)', () => {
  it('public-schema-preexists 以外の理由でexcludeされたブロックのみ抽出する', () => {
    const blocks = [
      { category: OBJECT_CATEGORY.BRING_AS_IS, reason: null },
      { category: OBJECT_CATEGORY.EXCLUDE, reason: 'public-schema-preexists' },
      { category: OBJECT_CATEGORY.EXCLUDE, reason: 'supabase-managed-schema:auth' },
      { category: OBJECT_CATEGORY.EXCLUDE, reason: 'owner-or-acl-defensive' },
    ]
    const result = findUnexpectedExclusions(blocks)
    expect(result.map((b) => b.reason)).toEqual(['supabase-managed-schema:auth', 'owner-or-acl-defensive'])
  })

  it('public-schema-preexistsのみのexcludeなら空配列', () => {
    const blocks = [{ category: OBJECT_CATEGORY.EXCLUDE, reason: 'public-schema-preexists' }]
    expect(findUnexpectedExclusions(blocks)).toEqual([])
  })

  it('excludeが1件も無ければ空配列', () => {
    const blocks = [{ category: OBJECT_CATEGORY.BRING_AS_IS, reason: null }]
    expect(findUnexpectedExclusions(blocks)).toEqual([])
  })

  // 実fixtureに対する統合的な確認: auth混入・owner-or-acl混入の2件が想定外として検出される
  it('FIXTURE_RAW_DUMP（auth混入・ACL混入を含む）に対して2件検出する', () => {
    const result = normalizeDump(FIXTURE_RAW_DUMP)
    const unexpected = findUnexpectedExclusions(result.blocks)
    expect(unexpected.map((b) => b.reason).sort()).toEqual(
      ['owner-or-acl-defensive', 'supabase-managed-schema:auth'].sort()
    )
  })
})

describe('parseCliArgs', () => {
  it('既定値: allowExclusionsはfalse', () => {
    const result = parseCliArgs(['node', 'normalize-schema.mjs']) as { allowExclusions: boolean }
    expect(result.allowExclusions).toBe(false)
  })

  it('--allow-exclusions を検出する', () => {
    const result = parseCliArgs(['node', 'normalize-schema.mjs', '--allow-exclusions']) as {
      allowExclusions: boolean
    }
    expect(result.allowExclusions).toBe(true)
  })

  it('--input/--output と併用できる', () => {
    const result = parseCliArgs([
      'node',
      'normalize-schema.mjs',
      '--input=a.sql',
      '--output=b.sql',
      '--allow-exclusions',
    ]) as { input: string; output: string; allowExclusions: boolean }
    expect(result).toEqual({ input: 'a.sql', output: 'b.sql', allowExclusions: true })
  })

  // Minor (Fableレビュー): export-public-schema.mjs の parseCliArgs と同じ流儀
  // （console.error/process.exitCodeの副作用を持たず、{ error: message } を返すだけ）
  // に統一したことを確認する。
  it('不明な引数はconsole/exitCodeへの副作用を持たず { error: message } を返す', () => {
    const result = parseCliArgs(['node', 'normalize-schema.mjs', '--unknown-flag']) as {
      error?: string
      help?: boolean
    }
    expect(result.error).toContain('--unknown-flag')
    expect(result.help).toBeUndefined()
  })

  it('--help はhelp:trueを返す（他の検証より優先）', () => {
    const result = parseCliArgs(['node', 'normalize-schema.mjs', '--help']) as { help: boolean }
    expect(result).toEqual({ help: true })
  })
})

describe('splitIntoBlocks の異常系（fail-fast）', () => {
  it('TOC境界検出後にヘッダー行がパースできない場合は例外を投げる', () => {
    // BLOCK_BOUNDARY_RE は "--\n-- Name: " で分割するため、分割後のセグメントは
    // 必ずこの形式で始まる。ここでは分割後の内容が TOC_HEADER_LINE_RE の
    // 期待する "; Type: ...; Schema: ...; Owner: ..." を欠くよう意図的に壊し、
    // 「パース前提が崩れたら黙って処理を続けず例外を投げる」ことを確認する。
    const broken = '--\n-- Name: incomplete-header-without-type-field\nSELECT 1;\n'
    expect(() => splitIntoBlocks(broken)).toThrow(/TOCヘッダーのパースに失敗/)
  })

  // M-1 (Fableレビュー): 修正前は境界0件の場合フェイルオープンし、全文をpreamble扱いにして
  // 警告無しでそのまま出力していた（GRANT文やCREATE SCHEMA public;等が素通りするリスクが
  // あった実際のバグ）。CRLF化したdump等、TOCヘッダーが1件も検出できない入力に対しては
  // 黙って通さず例外を投げることを確認する。
  it('TOC境界が1件も見つからない場合は例外を投げる（フェイルオープンしない）', () => {
    const noBoundary = 'CREATE SCHEMA public;\nGRANT ALL ON SCHEMA public TO postgres;\n'
    expect(() => splitIntoBlocks(noBoundary)).toThrow(/TOC境界.*1件も見つかりませんでした/)
  })

  it('空文字列に対しても例外を投げる', () => {
    expect(() => splitIntoBlocks('')).toThrow(/TOC境界/)
  })

  // M-1 (Fableレビュー) の実際の再現条件そのもの: BLOCK_BOUNDARY_RE (/^--\n-- Name: /gm) は
  // LF改行のみを前提にしており、CRLF化されたdump（例: Windows環境でのファイル転送・
  // git設定のautocrlf等で意図せず変換されたケース）は "--\r\n-- Name: " となるため
  // 1件もマッチしない。修正前はこのケースでも警告無しでフェイルオープンしていた。
  it('CRLF化されたdumpはTOC境界0件として検出され、例外を投げる（フェイルオープンしない）', () => {
    const crlfDump = FIXTURE_RAW_DUMP.replace(/\n/g, '\r\n')
    expect(() => normalizeDump(crlfDump)).toThrow(/TOC境界/)
  })

  // normalizeDump経由でも同様にfail-fastすることを確認する（呼び出し元での握りつぶし防止）
  it('normalizeDump経由でもTOC境界0件は例外として伝播する', () => {
    const noBoundary = 'SET statement_timeout = 0;\nCREATE SCHEMA public;\n'
    expect(() => normalizeDump(noBoundary)).toThrow(/TOC境界/)
  })
})
