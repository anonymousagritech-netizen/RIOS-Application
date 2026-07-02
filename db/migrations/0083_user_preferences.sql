-- 0083 user_preference: per-user, per-page preference store (e.g. saved filter state).
-- Used by GET/PUT /api/preferences/:key. Tenant-scoped so one user's prefs don't
-- leak across tenants. Unique on (user_id, tenant_id, pref_key) so upserting is
-- a simple INSERT … ON CONFLICT DO UPDATE.

CREATE TABLE IF NOT EXISTS user_preference (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  tenant_id   uuid        NOT NULL REFERENCES tenant(id)  ON DELETE CASCADE,
  pref_key    text        NOT NULL,   -- e.g. 'filters:treaties', 'filters:claims'
  pref_value  jsonb       NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id, pref_key)
);

-- rios_app needs read + upsert; no delete (prefs are cleaned up by CASCADE on user/tenant).
GRANT SELECT, INSERT, UPDATE ON user_preference TO rios_app;
