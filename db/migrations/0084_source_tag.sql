-- 0084_source_tag.sql
ALTER TABLE contract         ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE claim            ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE financial_event  ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE party            ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE participation    ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE contract_layer   ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE broker_profile   ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE cedent_profile   ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE investment_holding ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE fac_engineering  ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE fac_quote        ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE fac_placement_line ADD COLUMN IF NOT EXISTS source text;
