import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'

// No npm dependencies: this runs in the migration job against its disposable PostgreSQL 17.
const args = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-h', process.env.PGHOST || '127.0.0.1', '-p', process.env.PGPORT || '5432',
  '-U', process.env.PGUSER || 'postgres', '-d', process.env.PGDATABASE || 'postgres']
const query = (sql) => execFileSync('psql', args, { input: sql, encoding: 'utf8' }).trim()
const streamer = '15490000-0000-4000-8000-000000000001'
const lease = '15490000-0000-4000-8000-000000000002'
const staleLease = '15490000-0000-4000-8000-000000000003'
const viewer = '15490000-0000-4000-8000-000000000090'
const cardA = '15490000-0000-4000-8000-000000000091'
const cardB = '15490000-0000-4000-8000-000000000092'
const cardC = '15490000-0000-4000-8000-000000000093'
const cardD = '15490000-0000-4000-8000-000000000094'
const cardE = '15490000-0000-4000-8000-000000000095'
const cardF = '15490000-0000-4000-8000-000000000096'
const id = (n) => `15490000-0000-4000-8000-${String(n).padStart(12, '0')}`
const resolve = (n, owner = lease) => `SELECT public.resolve_chat_outbox_delivery_mode('${id(n)}', '${owner}');`
const insert = (n, createdAt, count = 10) => `
  INSERT INTO public.chat_notification_outbox
    (id, batch_id, payload, expected_draw_count, assembled_draw_count, status, lease_id, lease_expires_at, created_at)
  VALUES ('${id(n)}', 'paced-ci-${n}', '{"streamer":{"id":"${streamer}"}}',
    ${count}, ${count}, 'processing', '${lease}', now() + interval '60 seconds', '${createdAt}');`
const complete = (n) => query(`UPDATE public.chat_notification_outbox SET status='sent',
  sent_at=now(), lease_id=NULL, lease_expires_at=NULL WHERE id='${id(n)}';`)

function background(sql) {
  const child = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let error = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { error += data })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error)))
  })
  // A readiness failure still reaches the cleanup below without an unhandled rejection.
  done.catch(() => {})
  child.stdin.end(sql)
  return { child, done }
}

async function waitForLock(key) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (query(`SELECT pg_try_advisory_xact_lock(1549, ${key});`) === 'f') return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`fixture barrier ${key} was not acquired`)
}

const pending = []
try {
  query(`INSERT INTO public.streamers(id,twitch_user_id,twitch_username,twitch_display_name)
    VALUES('${streamer}','paced-ci','paced-ci','Paced CI');`)

  // No settings: both the migration default and INSERT trigger keep legacy delivery.
  query(insert(10, '2026-01-01T00:00:00Z'))
  assert.equal(query(`SELECT delivery_mode || '|' || delivery_cursor || '|' || delivery_chunk_size
    FROM public.chat_notification_outbox WHERE id='${id(10)}';`), 'summary|0|3')
  query(`INSERT INTO public.streamer_chat_multi_delivery_settings(streamer_id,delivery_mode,chunk_size)
    VALUES('${streamer}','individual',3);`)
  assert.equal(query(resolve(10)), 'summary', 'setting edits cannot alter an existing snapshot')
  complete(10)

  // Older INSERT remains uncommitted while the newer transaction starts sending.
  // created_at-only congestion checks incorrectly let BOTH rows choose paced here.
  const delayedOlder = background(`BEGIN; ${insert(11, '2026-01-01T00:00:01Z')}
    SELECT pg_advisory_xact_lock(1549,1); SELECT pg_sleep(2); COMMIT; ${resolve(11)}`)
  pending.push(delayedOlder)
  await waitForLock(1)
  query(insert(12, '2026-01-01T00:00:02Z'))
  assert.equal(query(resolve(12)), 'individual')
  assert.equal(await delayedOlder.done, 'summary', 'late older commit must see the reserved newer sequence')
  complete(12)
  assert.equal(query(resolve(11)), 'summary', 'retry must retain the summary fallback after its blocker finishes')
  complete(11)

  // Two visible rows deciding concurrently share the same transaction-scoped lock.
  query(insert(13, '2026-01-01T00:00:03Z') + insert(14, '2026-01-01T00:00:03Z'))
  const first = background(`BEGIN; ${resolve(13)} SELECT pg_advisory_xact_lock(1549,2);
    SELECT pg_sleep(2); COMMIT;`)
  pending.push(first)
  await waitForLock(2)
  const second = background(resolve(14))
  pending.push(second)
  assert.equal(await first.done, 'individual')
  assert.equal(await second.done, 'summary', 'same-timestamp rows cannot reserve two paced sequences')
  assert.equal(query(resolve(13, staleLease)), '', 'a stale owner must not get sending permission')
  query(`UPDATE public.chat_notification_outbox SET delivery_cursor=6 WHERE id='${id(13)}';`)
  query(`UPDATE public.streamer_chat_multi_delivery_settings SET delivery_mode='chunked',chunk_size=5
    WHERE streamer_id='${streamer}';`)
  assert.equal(query(resolve(13)), 'individual', 'retry preserves the reserved mode and segment layout')
  assert.equal(query(`SELECT delivery_cursor || '|' || delivery_chunk_size FROM public.chat_notification_outbox
    WHERE id='${id(13)}';`), '6|3')
  complete(13)
  complete(14)

  // A queued older row blocks a new sequence, even while waiting for backoff.
  query(insert(15, '2026-01-01T00:00:04Z') + insert(16, '2026-01-01T00:00:05Z'))
  query(`UPDATE public.chat_notification_outbox SET status='pending',next_attempt_at=now()+interval '5 minutes',
    lease_id=NULL,lease_expires_at=NULL WHERE id='${id(15)}';`)
  assert.equal(query(resolve(16)), 'summary')
  complete(15)
  complete(16)

  // A single draw cannot occupy the paced lane merely because settings say individual.
  query(insert(17, '2026-01-01T00:00:06Z', 1) + insert(18, '2026-01-01T00:00:07Z'))
  assert.equal(query(resolve(18)), 'chunked')
  assert.equal(query(`SELECT has_function_privilege('anon','public.resolve_chat_outbox_delivery_mode(uuid,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.resolve_chat_outbox_delivery_mode(uuid,uuid)','EXECUTE');`), 'f')
  assert.equal(query(`SET ROLE service_role; ${resolve(18)}`), 'chunked', 'runtime role can execute the resolver')

  // New individual outboxes snapshot final counts for every distinct drawn card. The app
  // can then reconstruct {num}/{unique} at each draw without reading mutable current state.
  query(`
    RESET ROLE;
    UPDATE public.streamer_chat_multi_delivery_settings
      SET delivery_mode='individual',chunk_size=3 WHERE streamer_id='${streamer}';
    INSERT INTO public.users(id,twitch_user_id,twitch_username,twitch_display_name)
      VALUES('${viewer}','paced-viewer','paced-viewer','Paced Viewer');
    INSERT INTO public.cards(id,streamer_id,name) VALUES
      ('${cardA}','${streamer}','Card A'),
      ('${cardB}','${streamer}','Card B');
    INSERT INTO public.user_cards(user_id,card_id) VALUES
      ('${viewer}','${cardA}'),('${viewer}','${cardA}'),('${viewer}','${cardA}'),('${viewer}','${cardA}'),
      ('${viewer}','${cardB}');
    INSERT INTO public.chat_notification_outbox
      (id,batch_id,payload,expected_draw_count,assembled_draw_count,status,lease_id,lease_expires_at,created_at)
    VALUES (
      '${id(19)}','paced-ci-19',
      jsonb_build_object(
        'streamer',jsonb_build_object('id','${streamer}'),
        'userId','paced-viewer',
        'gachaResult',jsonb_build_object('cards',jsonb_build_array(
          jsonb_build_object('id','${cardA}'),jsonb_build_object('id','${cardA}'),jsonb_build_object('id','${cardB}')
        )),
        'chatSnapshot',jsonb_build_object('cardCount',4,'uniqueCount',2,'allCount',2,'newCardNames',jsonb_build_array())
      ),
      3,3,'processing','${lease}',now()+interval '60 seconds','2026-01-01T00:00:08Z'
    );`)
  assert.equal(query(`SELECT
      (payload #> '{chatSnapshot,cardCounts}' ->> '${cardA}') || '|' ||
      (payload #> '{chatSnapshot,cardCounts}' ->> '${cardB}')
    FROM public.chat_notification_outbox WHERE id='${id(19)}';`), '4|1')
  // (e) Templates without {packUnique}/{packAll} skip pack aggregation entirely.
  assert.equal(query(`SELECT payload #> '{chatSnapshot}' ? 'packCounts'
    FROM public.chat_notification_outbox WHERE id='${id(19)}';`), 'f')

  // Issue #2045: pack-scoped progress snapshots for {packUnique}/{packAll}.
  // Pack "Alpha" has A (owned x4), C (owned x2), D (unowned) and inactive E (owned).
  // The default pack has B (owned) and F (unowned). Card A/B above are reassigned here.
  query(`
    UPDATE public.cards SET collection_name='Alpha' WHERE id='${cardA}';
    INSERT INTO public.cards(id,streamer_id,name,collection_name,is_active) VALUES
      ('${cardC}','${streamer}','Card C','Alpha',true),
      ('${cardD}','${streamer}','Card D','Alpha',true),
      ('${cardE}','${streamer}','Card E','Alpha',false),
      ('${cardF}','${streamer}','Card F',NULL,true);
    INSERT INTO public.user_cards(user_id,card_id) VALUES
      ('${viewer}','${cardC}'),('${viewer}','${cardC}'),('${viewer}','${cardE}');`)
  const packInsert = (n, { single = null, multi = null, user = 'paced-viewer', snapshot = `jsonb_build_object('cardCount',4)` } = {}) => `
    INSERT INTO public.chat_notification_outbox
      (id,batch_id,payload,expected_draw_count,assembled_draw_count,status,lease_id,lease_expires_at,created_at)
    VALUES (
      '${id(n)}','paced-ci-${n}',
      jsonb_build_object(
        'streamer',jsonb_build_object('id','${streamer}',
          'chat_announcement_template',${single === null ? 'NULL::text' : `'${single}'`},
          'chat_announcement_multi_template',${multi === null ? 'NULL::text' : `'${multi}'`}),
        'userId','${user}',
        'gachaResult',jsonb_build_object('cards',jsonb_build_array(
          jsonb_build_object('id','${cardA}','collection_name','Alpha'),
          jsonb_build_object('id','${cardA}','collection_name','Alpha'),
          jsonb_build_object('id','${cardB}','collection_name',NULL)
        )),
        'chatSnapshot',${snapshot}
      ),
      3,3,'processing','${lease}',now()+interval '60 seconds','2026-01-01T00:00:09Z'
    );`
  const packCounts = (n) => query(`SELECT payload #> '{chatSnapshot,packCounts}'
    FROM public.chat_notification_outbox WHERE id='${id(n)}';`)
  // (a)(b)(c)(d)(f): individual delivery is still configured above, so cardCounts and
  // packCounts are written by separate triggers into the same chatSnapshot. Alpha owns
  // A x4 and C x2 -> 2 types (not 6 rows); inactive E is excluded from both sides; the
  // uncategorized card B is counted under the '__default__' sentinel key.
  query(packInsert(20, { single: '{user} {packUnique}/{packAll}' }))
  assert.deepEqual(JSON.parse(packCounts(20)), {
    Alpha: { unique: 2, all: 3 },
    __default__: { unique: 1, all: 2 },
  })
  assert.equal(query(`SELECT (payload #> '{chatSnapshot,cardCounts}' ->> '${cardA}') || '|' ||
      (payload #>> '{chatSnapshot,cardCount}')
    FROM public.chat_notification_outbox WHERE id='${id(20)}';`), '4|4',
  'packCounts is appended without rebuilding chatSnapshot or dropping cardCounts')
  // Either template triggers the snapshot, and {packAll} alone is enough.
  query(packInsert(21, { multi: '{packAll}' }))
  assert.deepEqual(JSON.parse(packCounts(21)).Alpha, { unique: 2, all: 3 })
  // Token match is case-sensitive, mirroring the app's literal replacement.
  query(packInsert(22, { single: '{packunique} {PACKALL}' }))
  assert.equal(packCounts(22), '')
  // A viewer without a users row still gets the denominator with unique=0.
  query(packInsert(23, { single: '{packUnique}', user: 'paced-missing-viewer' }))
  assert.deepEqual(JSON.parse(packCounts(23)), {
    Alpha: { unique: 0, all: 3 },
    __default__: { unique: 0, all: 2 },
  })
  // Packs with no active cards are omitted instead of rendering a misleading 0/0.
  query(`UPDATE public.cards SET is_active=false WHERE collection_name IS NULL AND streamer_id='${streamer}';`)
  query(packInsert(24, { single: '{packUnique}' }))
  assert.deepEqual(JSON.parse(packCounts(24)), { Alpha: { unique: 2, all: 3 } })
  // Malformed payloads are returned untouched instead of rolling back the gacha.
  query(packInsert(25, { single: '{packUnique}', snapshot: `'[]'::jsonb` }))
  assert.equal(query(`SELECT payload #> '{chatSnapshot}' FROM public.chat_notification_outbox
    WHERE id='${id(25)}';`), '[]')
  query(`
    INSERT INTO public.chat_notification_outbox
      (id,batch_id,payload,expected_draw_count,assembled_draw_count,status,lease_id,lease_expires_at,created_at)
    VALUES ('${id(26)}','paced-ci-26',
      jsonb_build_object('streamer',jsonb_build_object('id','not-a-uuid','chat_announcement_template','{packUnique}'),
        'userId','paced-viewer','gachaResult',jsonb_build_object('cards',jsonb_build_array()),
        'chatSnapshot',jsonb_build_object('cardCount',1)),
      1,1,'processing','${lease}',now()+interval '60 seconds','2026-01-01T00:00:10Z');`)
  assert.equal(packCounts(26), '')
  assert.equal(query(`SELECT has_function_privilege('anon','public.snapshot_chat_outbox_pack_counts()','EXECUTE')
    OR has_function_privilege('authenticated','public.snapshot_chat_outbox_pack_counts()','EXECUTE');`), 'f')

  console.log('paced multi-draw PostgreSQL defaults, snapshots, pack counts, retry reservation, fencing and concurrency checks passed')
} finally {
  for (const process of pending) process.child.kill()
  await Promise.allSettled(pending.map((process) => process.done))
  query(`RESET ROLE;
    DELETE FROM public.chat_notification_outbox WHERE batch_id LIKE 'paced-ci-%';
    DELETE FROM public.user_cards WHERE user_id='${viewer}';
    DELETE FROM public.cards WHERE id IN ('${cardA}','${cardB}','${cardC}','${cardD}','${cardE}','${cardF}');
    DELETE FROM public.users WHERE id='${viewer}';
    DELETE FROM public.streamers WHERE id='${streamer}';`)
}
