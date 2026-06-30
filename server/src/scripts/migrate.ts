/**
 * Apply SQL migrations in order. Idempotent at the file level via a simple
 * schema_migrations ledger. Uses the owner connection (bypasses RLS).
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPool, ownerQuery, closePools } from '../db.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../../../db/migrations');

async function main(): Promise<void> {
  await ownerQuery(`create table if not exists schema_migrations (
    filename text primary key, applied_at timestamptz not null default now())`);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await ownerQuery<{ filename: string }>(`select filename from schema_migrations`)).rows.map((r) => r.filename),
  );

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= skip ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(`insert into schema_migrations (filename) values ($1)`, [file]);
      await client.query('commit');
      console.log(`+ applied ${file}`);
    } catch (err) {
      await client.query('rollback');
      console.error(`x failed ${file}:`, (err as Error).message);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log('Migrations complete.');
}

main()
  .then(() => closePools())
  .catch(async (err) => {
    console.error(err);
    await closePools();
    process.exit(1);
  });
