-- 0051: formula_override.entity_id uuid -> text (defect D-2).
--
-- Overrides target business entities by reference (e.g. a treaty reference like
-- TRTY-2026-00019 or an external system id), not only internal uuids. The API
-- accepts any non-empty string; the uuid column made every non-uuid override
-- fail with a raw 22P02. Widen the column to text.

alter table formula_override
  alter column entity_id type text using entity_id::text;
