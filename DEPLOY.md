# Deploying RIOS (Render + Vercel + Neon) - pilot/UAT

This is the turnkey path for a **pilot** environment. It is not yet cleared for
production reinsurance (real money/PII) - see `docs/open-questions.md` for the
hardening + sign-off backlog.

## 1. Database - Neon

1. Create a Neon project → a database. Neon gives you two endpoints:
   - **Direct** (`...neon.tech`)
   - **Pooled** (`...-pooler.neon.tech`)
2. Append `?sslmode=require` to both connection strings (the app relies on the
   connection string for TLS; Neon requires SSL).
3. You will use:
   - `DATABASE_URL`     → the **direct** string (migrations create the `rios_app`
     role + `pgcrypto`/`citext` extensions, and login runs here).
   - `DATABASE_APP_URL` → the **pooled** string, but with the **`rios_app`**
     user/password, i.e. `postgres://rios_app:rios_app@<pooled-host>/<db>?sslmode=require`.
     (Migration `0008` creates the `rios_app` role with password `rios_app`; the
     app connects as it so Postgres RLS enforces tenant isolation. Change this
     password for anything beyond a pilot.)

> RLS works on Neon's pooled (PgBouncer transaction) endpoint because tenant
> context is set with `SET LOCAL` **inside a transaction** (`runAs`), which is
> transaction-pooling-safe.

## 2. Backend - Render

- New → **Blueprint** → select this repo. `render.yaml` configures build, the
  pre-deploy `db:migrate`, the start command and `/health` check.
- Set `DATABASE_URL` and `DATABASE_APP_URL` (from step 1) in the dashboard.
  `JWT_SECRET` is auto-generated.
- After the first deploy, seed the demo tenant **once** from the Render Shell:
  ```
  npm run db:seed
  ```
  (Skip the seed if you want an empty tenant.)
- Note your service URL, e.g. `https://rios-server.onrender.com`.

## 3. Frontend - Vercel

- New Project → import this repo. `vercel.json` sets the install/build/output
  and the SPA fallback.
- Add an environment variable:
  ```
  VITE_API_URL = https://rios-server.onrender.com
  ```
  The SPA reads this at build time and calls the Render backend (the server has
  CORS enabled). Without it the app would call Vercel's own origin and 404.
- Redeploy after setting the variable so it is baked into the build.

## 4. Smoke test

- Open the Vercel URL → log in with a demo account (if you seeded):
  `admin@demo.rios` / `demo1234`, tenant `demo`.
- Check `https://rios-server.onrender.com/health` returns `{ "status": "ok" }`.

## Pilot caveats (do before real go-live)

- Set a strong `rios_app` DB password (not the seed default).
- KMS master key currently derives from `JWT_SECRET` - wire a managed KMS.
- Email/SMS/Kafka/OCR/speech are in-process stubs - wire real providers.
- Cold starts: Render `free` and Neon scale-to-zero add first-request latency;
  use paid tiers to keep warm.
