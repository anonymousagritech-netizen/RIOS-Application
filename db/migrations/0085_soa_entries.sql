-- 0085_soa_entries.sql: SOA premium and claim entry tables

CREATE TABLE premium_entry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  contract_id     uuid NOT NULL REFERENCES contract(id),
  -- Reliance/GIC-Bhutan layout columns
  policy_no       text,
  insured_name    text,
  period_from     date,
  period_to       date,
  sum_insured_minor bigint NOT NULL DEFAULT 0,
  gross_premium_minor bigint NOT NULL DEFAULT 0,
  ri_premium_minor    bigint NOT NULL DEFAULT 0,
  commission_minor    bigint NOT NULL DEFAULT 0,
  net_premium_minor   bigint NOT NULL DEFAULT 0,
  class_of_business   text,
  currency        text NOT NULL DEFAULT 'USD',
  remarks         text,
  source          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE claim_entry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  contract_id     uuid NOT NULL REFERENCES contract(id),
  claim_id        uuid REFERENCES claim(id),
  policy_no       text,
  insured_name    text,
  date_of_loss    date,
  cause_of_loss   text,
  gross_loss_minor    bigint NOT NULL DEFAULT 0,
  ri_loss_minor       bigint NOT NULL DEFAULT 0,
  outstanding_minor   bigint NOT NULL DEFAULT 0,
  paid_minor          bigint NOT NULL DEFAULT 0,
  class_of_business   text,
  currency        text NOT NULL DEFAULT 'USD',
  remarks         text,
  source          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE premium_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_entry   ENABLE ROW LEVEL SECURITY;

CREATE POLICY premium_entry_tenant ON premium_entry
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY claim_entry_tenant ON claim_entry
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Grant to app user
GRANT SELECT, INSERT, UPDATE, DELETE ON premium_entry TO rios_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON claim_entry   TO rios_app;

-- Seed CLASS_OF_BUSINESS code list values for the demo tenant
INSERT INTO code_list (tenant_id, key, name)
SELECT t.id, 'CLASS_OF_BUSINESS', 'Class of Business'
FROM tenant t WHERE t.code = 'demo'
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO code_value (tenant_id, code_list_id, code, label, sort_order)
SELECT t.id, cl.id, v.code, v.label, v.sort
FROM tenant t
JOIN code_list cl ON cl.tenant_id = t.id AND cl.key = 'CLASS_OF_BUSINESS'
CROSS JOIN (VALUES
  ('MB',      'Marine (Bulk Cargo)',             1),
  ('MLOP',    'Marine (Loss of Profit)',         2),
  ('CPM',     'Contractor''s Plant & Machinery', 3),
  ('DOS',     'Deterioration of Stock',          4),
  ('EEI',     'Electronic Equipment',            5),
  ('EAR',     'Erection All Risk',               6),
  ('CAR',     'Contractor''s All Risk',          7),
  ('BOILERS', 'Boilers & Pressure Vessels',      8),
  ('ALOP',    'Advanced Loss of Profit',         9),
  ('MEGA',    'Mega Risk',                       10),
  ('INWARD',  'Inward Facultative',              11),
  ('OTHER',   'Other',                           99)
) AS v(code, label, sort)
WHERE t.code = 'demo'
ON CONFLICT (code_list_id, code, effective_from) DO NOTHING;
