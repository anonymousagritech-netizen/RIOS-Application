/**
 * Seed the demo tenant. Executes db/seed/seed.sql with the owner connection.
 * The SQL is idempotent (ON CONFLICT DO NOTHING) so re-running is safe.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { ownerPool, closePools } from '../db.js';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const seedFile = join(here, '../../../db/seed/seed.sql');

async function main(): Promise<void> {
  // Prefer psql (handles \set meta-commands); fall back to inlining the variable.
  const url = process.env.DATABASE_URL ?? 'postgres://rios:rios@localhost:5432/rios';
  try {
    await exec('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', seedFile]);
    console.log('Seed applied via psql.');
  } catch {
    // Fallback: strip the \set line and inline the tenant id literal.
    let sql = await readFile(seedFile, 'utf8');
    sql = sql
      .replace(/\\set\s+tenant_id\s+'([^']+)'/i, '')
      .replace(/:'tenant_id'/g, `'11111111-1111-1111-1111-111111111111'`);
    await ownerPool.query(sql);
    console.log('Seed applied via pg fallback.');
  }
}

main()
  .then(() => closePools())
  .catch(async (err) => {
    console.error('Seed failed:', err);
    await closePools();
    process.exit(1);
  });
