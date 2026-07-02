-- =============================================================================
-- RIOS - Migration 0086: treasury instrument type expansion
-- Adds a reference table for instrument types (12 types), drops the old hard-coded
-- CHECK constraint, replaces it with a FK, and adds FD/MF-specific columns.
-- =============================================================================

-- Reference table for instrument types
CREATE TABLE instrument_type_ref (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  sort_order  int  NOT NULL DEFAULT 0
);

INSERT INTO instrument_type_ref (code, label, sort_order) VALUES
  ('BOND',            'Bond',                    1),
  ('BILL',            'Treasury Bill',           2),
  ('EQUITY',          'Equity',                  3),
  ('CASH',            'Cash',                    4),
  ('FUND',            'Fund',                    5),
  ('FIXED_DEPOSIT',   'Fixed Deposit',           6),
  ('MUTUAL_FUND',     'Mutual Fund',             7),
  ('GOVERNMENT_BOND', 'Government Bond',         8),
  ('CORPORATE_BOND',  'Corporate Bond',          9),
  ('TREASURY_BILL',   'Treasury Bill (Short)',  10),
  ('MONEY_MARKET',    'Money Market',           11),
  ('STRUCTURED',      'Structured Product',     12);

-- Drop the old CHECK constraint if it exists (PostgreSQL 14+ supports DO block approach)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'investment_holding'
      AND constraint_type = 'CHECK'
      AND constraint_name LIKE '%instrument_type%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE investment_holding DROP CONSTRAINT ' || constraint_name
      FROM information_schema.table_constraints
      WHERE table_name = 'investment_holding'
        AND constraint_type = 'CHECK'
        AND constraint_name LIKE '%instrument_type%'
      LIMIT 1
    );
  END IF;
END;
$$;

-- Add FK to new reference table
ALTER TABLE investment_holding
  ADD CONSTRAINT investment_holding_instrument_type_fk
  FOREIGN KEY (instrument_type) REFERENCES instrument_type_ref(code);

-- Add new columns for fixed deposits and mutual funds
ALTER TABLE investment_holding
  ADD COLUMN IF NOT EXISTS nav_per_unit            numeric(18,6),
  ADD COLUMN IF NOT EXISTS units                   numeric(18,6),
  ADD COLUMN IF NOT EXISTS fd_tenor_days           int,
  ADD COLUMN IF NOT EXISTS fd_rate                 numeric(8,4),
  ADD COLUMN IF NOT EXISTS fd_maturity             date,
  ADD COLUMN IF NOT EXISTS accrued_interest_minor  bigint NOT NULL DEFAULT 0;
