-- teardown_demo.sql: remove all rows seeded with source='demo'
-- Run this to reset to a clean (migrated but not seeded) state.

DELETE FROM fac_placement_line WHERE source = 'demo';
DELETE FROM fac_quote           WHERE source = 'demo';
DELETE FROM fac_engineering     WHERE source = 'demo';
DELETE FROM investment_holding  WHERE source = 'demo';
DELETE FROM cedent_profile      WHERE source = 'demo';
DELETE FROM broker_profile      WHERE source = 'demo';
DELETE FROM contract_layer      WHERE source = 'demo';
DELETE FROM participation       WHERE source = 'demo';
DELETE FROM financial_event     WHERE source = 'demo';
DELETE FROM claim               WHERE source = 'demo';
DELETE FROM contract            WHERE source = 'demo';
DELETE FROM party               WHERE source = 'demo';
