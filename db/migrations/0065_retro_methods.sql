-- 0065_retro_methods.sql
--
-- Retrocession cession methods (moving Tier-2 #10 from QUOTA_SHARE-only to the
-- full proportional/non-proportional set). Widens retro_allocation_rule.method
-- from ('QUOTA_SHARE') to ('QUOTA_SHARE','SURPLUS','XL') and adds the nullable
-- parameter columns each method needs:
--   - SURPLUS : retention_minor (retained line, minor units) + max_lines (lines
--               of surplus capacity; capacity = retention × max_lines).
--   - XL      : attachment_minor + limit_minor (the ceded layer of the source).
-- QUOTA_SHARE still uses cession_pct, which becomes nullable (only QS needs it);
-- the check now only bounds it when present. The domain engine
-- (allocateRetrocession) computes the cession for whichever method a rule sets.
-- Additive + idempotent; safe to re-run. Money is integer minor units.

alter table retro_allocation_rule
  add column if not exists retention_minor  bigint,
  add column if not exists max_lines        int,
  add column if not exists attachment_minor bigint,
  add column if not exists limit_minor      bigint;

-- Widen the method vocabulary: drop and re-add the check constraint.
alter table retro_allocation_rule drop constraint if exists retro_allocation_rule_method_check;
alter table retro_allocation_rule
  add constraint retro_allocation_rule_method_check
  check (method in ('QUOTA_SHARE','SURPLUS','XL'));

-- cession_pct is QUOTA_SHARE-only now: make it nullable and bound it only when set.
alter table retro_allocation_rule alter column cession_pct drop not null;
alter table retro_allocation_rule drop constraint if exists retro_allocation_rule_cession_pct_check;
alter table retro_allocation_rule
  add constraint retro_allocation_rule_cession_pct_check
  check (cession_pct is null or (cession_pct > 0 and cession_pct <= 100));

-- Guard rails so a row always carries the params its method requires.
alter table retro_allocation_rule drop constraint if exists retro_allocation_rule_method_params_check;
alter table retro_allocation_rule
  add constraint retro_allocation_rule_method_params_check
  check (
    (method = 'QUOTA_SHARE' and cession_pct is not null)
    or (method = 'SURPLUS' and retention_minor is not null and retention_minor > 0
        and max_lines is not null and max_lines >= 0)
    or (method = 'XL' and attachment_minor is not null and attachment_minor >= 0
        and limit_minor is not null and limit_minor > 0)
  );
