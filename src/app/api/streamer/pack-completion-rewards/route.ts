import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { getSession, canUseStreamerFeatures } from '@/lib/session';
import { validateCSRFToken } from '@/lib/csrf';
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from '@/lib/rate-limit';
import { validateContentType } from '@/lib/request-validation';
import { getDb } from '@/lib/db/client';
import { getSqlState } from '@/lib/db/errors';
import { rewardCacheTag } from '@/lib/services/pack-completion-reward';

const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

async function handle(request: NextRequest) {
  const method = request.method;
  if (method !== 'GET' && !(await validateCSRFToken(request)).valid) return respond({ error: 'Forbidden' }, 403);
  const session = await getSession();
  if (!session || !canUseStreamerFeatures(session)) return respond({ error: 'Unauthorized' }, 401);
  const limit = await checkRateLimit(rateLimits.streamerSettings, await getRateLimitIdentifier(request, session.twitchUserId));
  if (!limit.success) return respond({ error: 'Rate limit exceeded' }, 429);
  let body: Record<string, unknown> = {};
  if (method !== 'GET') {
    const contentError = validateContentType(request, 'application/json');
    if (contentError) return contentError;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return respond({ error: 'Invalid body' }, 400);
      body = parsed as Record<string, unknown>;
    } catch { return respond({ error: 'Invalid JSON' }, 400); }
    if (typeof body.collectionName !== 'string' || !body.collectionName.length || body.collectionName.length > 80) return respond({ error: 'Invalid pack' }, 400);
    if (method === 'PUT' && (typeof body.rewardCardId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.rewardCardId))) return respond({ error: 'Invalid card' }, 400);
  }
  try {
    const { sql } = await getDb();
    const [streamer] = await sql<{ id: string }[]>`SELECT id FROM public.streamers WHERE twitch_user_id = ${session.twitchUserId}`;
    if (!streamer) return respond({ error: 'Streamer not found' }, 404);
    if (method === 'GET') {
      const rewards = await sql`SELECT r.collection_name, r.reward_card_id, to_jsonb(c) AS card
        FROM public.pack_completion_rewards r JOIN public.cards c ON c.id = r.reward_card_id
        WHERE r.streamer_id = ${streamer.id}::uuid ORDER BY r.collection_name`;
      const candidates = await sql`SELECT id, name, image_url, rarity FROM public.cards WHERE streamer_id = ${streamer.id}::uuid AND is_active IS FALSE ORDER BY created_at`;
      const grants = await sql`SELECT collection_name, count(*)::integer AS count FROM public.pack_completion_reward_grants
        WHERE streamer_id = ${streamer.id}::uuid GROUP BY collection_name`;
      const completions = await sql`SELECT collection_name, count(DISTINCT twitch_user_id)::integer AS count FROM public.collection_completions
        WHERE streamer_id = ${streamer.id}::uuid GROUP BY collection_name`;
      return respond({ rewards, candidates, grants, completions });
    }
    if (method === 'PUT') {
      const [row] = await sql<{ result: { ok: boolean; reason?: string } }[]>`SELECT public.set_pack_completion_reward(
        ${streamer.id}::uuid, ${body.collectionName as string}, ${body.rewardCardId as string}::uuid) AS result`;
      if (!row?.result.ok) return respond({ error: row?.result.reason ?? 'Invalid reward' }, 400);
    } else {
      // Orphaned packs must remain removable; do not require catalog membership.
      await sql.begin(async tx => {
        // Use the same streamer lock as setting/grant/rename so removal cannot
        // race a grant that has already read its setting but not committed.
        await tx`SELECT id FROM public.streamers WHERE id = ${streamer.id}::uuid FOR UPDATE`;
        await tx`DELETE FROM public.pack_completion_rewards WHERE streamer_id = ${streamer.id}::uuid AND collection_name = ${body.collectionName as string}`;
      });
    }
    revalidateTag(rewardCacheTag(streamer.id), { expire: 0 });
    return respond({ success: true });
  } catch (error) {
    // Deploys and migrations run independently. Never pretend a rejected save
    // succeeded; settings UI can stay open while the schema becomes available.
    const pending = ['42P01', '42883'].includes(getSqlState(error) ?? '');
    return respond({ error: pending ? 'Completion rewards are not available yet' : 'Unable to save or load completion rewards', unavailable: pending }, 503);
  }
}
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;
