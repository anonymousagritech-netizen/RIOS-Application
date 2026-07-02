-- 0064_facultative.sql
--
-- Facultative completion (brief §7.4, §29.2). Additive columns on the `risk`
-- row so a single-risk cession can capture the fields the facultative slip
-- carries but that previously had no home: the reinsurer taking the line, the
-- quote/offer validity date, and the last engineering-inspection date. These
-- mirror the semantics already present on fac_quote / fac_engineering (0048)
-- but sit on the underlying risk so the one-screen cession persists them
-- directly. fac-obligatory vs fac-facultative is carried in the term_set bag
-- (metadata-driven; no column needed).
--
-- Additive + idempotent. `risk` already has RLS + rios_app grants (0008); a
-- column add needs no policy change.

alter table risk add column if not exists reinsurer_party_id uuid references party(id) on delete set null;
alter table risk add column if not exists valid_until  date;
alter table risk add column if not exists inspected_on date;
