-- Empty disposable local cluster only; setup for pack-completion-rewards-pg.test.ts.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE streamers(id uuid PRIMARY KEY, card_pack_names jsonb DEFAULT '[]', channel_point_collection_name text, pack_rarity_weights jsonb);
CREATE TABLE cards(id uuid PRIMARY KEY, streamer_id uuid REFERENCES streamers(id), is_active boolean, collection_name text);
CREATE TABLE users(id uuid PRIMARY KEY, twitch_user_id text UNIQUE);
CREATE TABLE user_cards(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES users(id), card_id uuid REFERENCES cards(id));
CREATE TABLE streamer_additional_gacha_rewards(streamer_id uuid, collection_name text);
CREATE TABLE collection_completions(twitch_user_id text, streamer_id uuid, collection_name text, total_cards integer);
INSERT INTO streamers(id,card_pack_names,channel_point_collection_name) VALUES ('00000000-0000-0000-0000-000000000001','["A","B"]',null);
INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000002','viewer');
INSERT INTO cards VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',true,null),('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001',false,null);
INSERT INTO user_cards(user_id,card_id) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003');
