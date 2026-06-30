# RIOS - Deployment & Operations Runbook

> Phase 14 (Deployment) of the build brief. Covers containerisation, local
> full-stack, Kubernetes/Helm, configuration, observability, and backup/DR.
> **Status:** the artifacts (Dockerfiles, compose, Helm chart, CI) are real and
> reviewed; cluster-specific values (registry, hostnames, managed Postgres,
> secrets) must be supplied per environment.

## 1. Artifacts

| Artifact | Path | Purpose |
|---|---|---|
| API image | `Dockerfile.server` | Node 22 runtime, runs the Fastify API |
| Web image | `Dockerfile.web` | Multi-stage Vite build → nginx static + API proxy |
| Local full stack | `docker-compose.full.yml` | db + redis + migrate + server + web |
| Helm chart | `infra/helm/rios/` | Kubernetes deployment (server, web, ingress, HPA, migrate hook) |
| CI pipeline | `.github/workflows/ci.yml` | typecheck, tests, migrate/seed, e2e, image build |

## 2. Build images

Both images build from the **repository root** (they need the workspace):

```bash
docker build -f Dockerfile.server -t ghcr.io/your-org/rios/server:0.1.0 .
docker build -f Dockerfile.web    -t ghcr.io/your-org/rios/web:0.1.0 .
docker push ghcr.io/your-org/rios/server:0.1.0
docker push ghcr.io/your-org/rios/web:0.1.0
```

## 3. Local full stack

```bash
docker compose -f docker-compose.full.yml up --build
```

This starts PostgreSQL, Redis, runs migrations + seed (the `migrate` one-shot),
starts the API, and serves the web app at **http://localhost:8080**. Log in with
`admin@demo.rios` / `demo1234` / tenant `demo`.

## 4. Kubernetes (Helm)

```bash
helm template rios ./infra/helm/rios            # render & review
helm upgrade --install rios ./infra/helm/rios \
  --namespace rios --create-namespace \
  --set image.registry=ghcr.io/your-org \
  --set database.url='postgres://USER:PASS@HOST:5432/rios' \
  --set database.appUrl='postgres://rios_app:PASS@HOST:5432/rios' \
  --set secrets.jwtSecret="$(openssl rand -hex 24)" \
  --set ingress.host=rios.your-domain.com
```

What the chart deploys:
- **server** Deployment + Service, with `/live` liveness and `/ready` readiness
  probes and a CPU **HorizontalPodAutoscaler** (2–8 replicas by default).
- **web** Deployment + Service (nginx) and an **Ingress** routing `/api` → server
  and everything else → the SPA.
- A **pre-install/pre-upgrade Job** that runs migrations before rollout.
- ConfigMap (non-secret env) + Secret (JWT, optional Anthropic key).
- Prometheus scrape annotations on the server pods (`/metrics`).

Production notes: point `database.*` at a **managed PostgreSQL** (the chart does
not provision a database); supply secrets via a sealed-secret/external-secrets
operator rather than `--set`; pin image tags to immutable digests.

## 5. Configuration

All configuration is environment-driven (brief §14). Key variables:

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | migrations/seed | owner role; bypasses RLS |
| `DATABASE_APP_URL` | runtime | low-privilege `rios_app`; RLS enforced |
| `JWT_SECRET` | API | 32+ chars; rotate per environment |
| `PORT` | API | default 4000 |
| `ANTHROPIC_API_KEY` | API (optional) | assistant LLM enrichment; platform works without it |
| `RIOS_VERSION` / `RIOS_COMMIT` | API | surfaced at `/version` and in `/metrics` |

## 6. Observability

The API exposes (no auth, for infra/probes):
- `GET /live` - liveness (process up).
- `GET /ready` - readiness (checks DB connectivity; 503 when the DB is down).
- `GET /metrics` - Prometheus exposition: `rios_http_requests_total`,
  `rios_http_request_duration_seconds` (histogram), in-flight requests, process
  memory/uptime, and `rios_build_info`. Route labels are low-cardinality
  (ids collapsed to `:id`).
- `GET /version` - build info.

Structured request logs are emitted by Fastify's pino logger (JSON) for
aggregation. Wire `/metrics` to Prometheus (scrape annotations are set) and the
logs to your log stack; alert on readiness failures and p95 latency.

## 7. Backup, restore & DR (RTO/RPO)

- **Backup:** use the managed PostgreSQL automated backups + WAL archiving for
  point-in-time recovery. For self-managed, schedule `pg_dump`/`pg_basebackup`.
- **Restore drill:** restore a snapshot into a scratch database, run
  `npm run db:migrate` to confirm schema parity, and run the server integration
  suite against it.
- **Tenant export/offboarding:** every table is tenant-scoped; a per-tenant
  export is a filtered dump by `tenant_id` (see `docs/security.md`).
- **DR:** the app tier is stateless and horizontally scaled; recovery time is
  bounded by database restore. Define RTO/RPO with the managed-DB SLA.

## 8. Release flow

1. CI runs on every push: typecheck → domain tests → migrate/seed → server tests
   → web build → e2e smoke (see `.github/workflows/ci.yml`).
2. Tag a release; build & push images with that tag.
3. `helm upgrade --install` with the new tag; the migrate Job runs first, then a
   rolling update of server and web with zero-downtime probes.
4. Verify `/ready` and `/version` on the new pods; watch `/metrics` error rate.

## Open items
Provision-side concerns intentionally left to the operator: managed Postgres,
secret management (sealed-secrets/Vault), TLS issuance (cert-manager), a real
container registry, network policies, and a Prometheus/Grafana/Loki stack. The
chart and probes are built to plug into these.
