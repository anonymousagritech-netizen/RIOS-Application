-- Token revocation table for server-side JWT invalidation (G-07).
-- This table is NOT subject to tenant RLS; it is checked during token
-- verification before the tenant context is established.
CREATE TABLE IF NOT EXISTS token_revocation (
  jti         uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  revoked_at  timestamptz NOT NULL DEFAULT now(),
  reason      text NOT NULL DEFAULT 'logout'
);

CREATE INDEX token_revocation_user_idx   ON token_revocation(user_id);
CREATE INDEX token_revocation_tenant_idx ON token_revocation(tenant_id);

-- rios_app may INSERT (logout) and SELECT (verify), but never DELETE.
-- Revocations are append-only; there is no expiry / cleanup in-scope.
GRANT SELECT, INSERT ON token_revocation TO rios_app;
