import { test as base, expect } from '@playwright/test';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

export interface TestSession {
  twitchUserId: string;
  twitchUsername: string;
  twitchDisplayName: string;
  twitchProfileImageUrl: string;
  broadcasterType: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const TEST_STREAMER_ID = '123456789';

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing Supabase environment variables');
  }
  return createClient(url, key);
}

async function setupTestStreamer() {
  const supabase = getSupabaseAdmin();
  
  const { data: existingStreamer } = await supabase
    .from('streamers')
    .select('id')
    .eq('twitch_user_id', TEST_STREAMER_ID)
    .single();

  if (!existingStreamer) {
    const { error } = await supabase.from('streamers').insert({
      twitch_user_id: TEST_STREAMER_ID,
      twitch_username: 'teststreamer',
      twitch_display_name: 'TestStreamer',
      twitch_profile_image_url: 'https://example.com/avatar.png',
      is_active: true,
    });
    if (error) {
      console.error('Failed to create test streamer:', error);
    }
  }
}

async function cleanupTestData() {
  const supabase = getSupabaseAdmin();
  await supabase.from('cards').delete().eq('streamer_id', TEST_STREAMER_ID);
}

const createTestSession = (overrides: Partial<TestSession> = {}): string => {
  const session: TestSession = {
    twitchUserId: TEST_STREAMER_ID,
    twitchUsername: 'teststreamer',
    twitchDisplayName: 'TestStreamer',
    twitchProfileImageUrl: 'https://example.com/avatar.png',
    broadcasterType: 'affiliate',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600000,
    ...overrides,
  };
  return JSON.stringify(session);
};

export const test = base.extend({
  page: async ({ page, context }, use) => {
    await setupTestStreamer();
    await cleanupTestData();
    const sessionValue = createTestSession();
    await context.addCookies([
      {
        name: 'twica_session',
        value: sessionValue,
        domain: 'localhost',
        path: '/',
      },
    ]);
    await use(page);
  },
});

export { expect } from '@playwright/test';

export { createTestSession };