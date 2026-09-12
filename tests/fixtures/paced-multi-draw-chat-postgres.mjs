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
  console.log('paced multi-draw PostgreSQL defaults, snapshots, retry reservation, fencing and concurrency checks passed')
} finally {
  for (const process of pending) process.child.kill()
  await Promise.allSettled(pending.map((process) => process.done))
  query(`DELETE FROM public.chat_notification_outbox WHERE batch_id LIKE 'paced-ci-%';
    DELETE FROM public.streamers WHERE id='${streamer}';`)
}
