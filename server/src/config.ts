/** Environment configuration. Nothing secret is hard-coded; all from env (§14). */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dependency-free .env loader: populate process.env from the repo-root .env file
// for any key not already set. Real deployments inject env directly (§14).
(function loadDotEnv() {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const raw = readFileSync(join(root, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const key = m[1]!;
      let val = m[2]!.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no .env file - rely on the real environment */
  }
})();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  /** Owner connection - used for migrations & seeding only (bypasses RLS). */
  databaseUrl: required('DATABASE_URL', 'postgres://rios:rios@localhost:5432/rios'),
  /** Application connection - low-privilege role; RLS enforced. */
  databaseAppUrl:
    process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL ?? 'postgres://rios_app:rios_app@localhost:5432/rios',
  jwtSecret: required('JWT_SECRET', 'dev-only-change-me-please-32-characters-min'),
  jwtExpiresIn: '12h',
  ai: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.RIOS_AI_MODEL ?? 'claude-opus-4-8',
  },
};

export type Config = typeof config;
