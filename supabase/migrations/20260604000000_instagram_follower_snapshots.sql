CREATE TABLE IF NOT EXISTS instagram_follower_snapshots (
  date DATE PRIMARY KEY,
  followers_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
