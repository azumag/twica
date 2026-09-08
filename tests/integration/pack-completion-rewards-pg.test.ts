// Dedicated disposable PostgreSQL only. Apply the migration + minimal fixture
// before running; never point PACK_REWARD_TEST_DATABASE_URL at a shared DB.
import postgres from 'postgres';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
const url = process.env.PACK_REWARD_TEST_DATABASE_URL;
const sql = url ? postgres(url, { max: 4 }) : null;
const streamer = '00000000-0000-0000-0000-000000000001';
const bonus = '00000000-0000-0000-0000-000000000004';
describe.skipIf(!sql)('completion rewards actual PostgreSQL', () => {
  beforeAll(async () => {
    await sql!`TRUNCATE user_cards, pack_completion_reward_grants, pack_completion_rewards`;
    await sql!`UPDATE cards SET is_active=false WHERE id=${bonus}::uuid`;
    await sql!`UPDATE streamers SET card_pack_names='["A","B"]', pack_rarity_weights='{"A":{"rare":100}}' WHERE id=${streamer}::uuid`;
    await sql!`INSERT INTO user_cards(user_id,card_id) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003')`;
  });
  afterAll(async () => { await sql?.end(); });
  it('grants exactly once concurrently without requiring the bonus', async () => {
    const [setting] = await sql!`SELECT set_pack_completion_reward(${streamer}::uuid, '__default__', ${bonus}::uuid) AS result`;
    expect(setting.result.ok).toBe(true);
    const results = await Promise.all(Array.from({ length: 2 }, () => sql!`SELECT grant_pack_completion_reward('viewer', ${streamer}::uuid, '__default__', ${bonus}::uuid) AS result`));
    expect(results.filter(r => r[0].result.granted)).toHaveLength(1);
    expect(results.filter(r => r[0].result.already_granted)).toHaveLength(1);
    const [count] = await sql!`SELECT count(*)::integer AS n FROM user_cards WHERE card_id = ${bonus}::uuid`;
    expect(count.n).toBe(1);
  });
  it('refuses activation at the database boundary', async () => {
    await expect(sql!`UPDATE cards SET is_active = true WHERE id = ${bonus}::uuid`).rejects.toMatchObject({ code: 'P0720' });
  });
  it('is harmless for a missing viewer and an empty active pack', async () => {
    const [missing] = await sql!`SELECT grant_pack_completion_reward('missing', ${streamer}::uuid, '__default__', ${bonus}::uuid) AS result`;
    expect(missing.result.reason).toBe('user_not_found');
    await sql!`SELECT set_pack_completion_reward(${streamer}::uuid, 'A', ${bonus}::uuid)`;
    const [empty] = await sql!`SELECT grant_pack_completion_reward('viewer', ${streamer}::uuid, 'A', ${bonus}::uuid) AS result`;
    expect(empty.result.reason).toBe('incomplete');
  });
  it('serializes setting against concurrent activation with a fresh trigger snapshot', async () => {
    await sql!`DELETE FROM pack_completion_rewards WHERE reward_card_id = ${bonus}::uuid`;
    let unlock!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const setting = sql!.begin(async tx => {
      await tx`SELECT set_pack_completion_reward(${streamer}::uuid, 'A', ${bonus}::uuid)`;
      locked(); await gate;
    });
    await lockReady;
    const activation = sql!`UPDATE cards SET is_active = true WHERE id = ${bonus}::uuid`.then(() => 'unexpected', error => error.code);
    // Let the second connection begin waiting on the locked card.
    await new Promise(resolve => setTimeout(resolve, 100));
    unlock(); await setting;
    expect(await activation).toBe('P0720');
  });
  it('renames despite historical grant and orphan setting collisions', async () => {
    await sql!`INSERT INTO pack_completion_reward_grants(twitch_user_id,streamer_id,collection_name,reward_card_id)
      VALUES ('viewer',${streamer}::uuid,'A',${bonus}::uuid), ('viewer',${streamer}::uuid,'C',${bonus}::uuid)`;
    await sql!`INSERT INTO pack_completion_rewards(streamer_id,collection_name,reward_card_id) VALUES (${streamer}::uuid,'C',${bonus}::uuid)`;
    await sql!`SELECT rename_card_pack(${streamer}::uuid,'A','C')`;
    const rows = await sql!`SELECT collection_name FROM pack_completion_rewards WHERE streamer_id=${streamer}::uuid`;
    expect(rows.map(r => r.collection_name)).toEqual(['C']);
    const [owner] = await sql!`SELECT pack_rarity_weights FROM streamers WHERE id=${streamer}::uuid`;
    expect(owner.pack_rarity_weights).toEqual({ C: { rare: 100 } });
  });
});
