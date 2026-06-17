# Docker Setup for MDN HTTP Observatory

## Quick Start

1. Copy the environment example and adjust secrets or published ports as needed:
   ```bash
   cp .env.example .env
   ```
2. Start the services:
   ```bash
   docker compose up -d --build
   ```
3. Check the logs:
   ```bash
   docker compose logs -f
   ```
4. Verify the service:
   - Open http://localhost:3001/ in your browser
   - Check `http://localhost:3001/api/v2/version`

## Hardened mode

Use the hardened overlay to apply the runtime restrictions introduced during the hardening rollout:

```bash
docker compose -f docker-compose.yml -f docker-compose.hardened.yml config
docker compose -f docker-compose.yml -f docker-compose.hardened.yml up -d --build
```

The hardened overlay currently adds:

- `no-new-privileges` for both services
- `read_only`, `tmpfs`, `cap_drop: [ALL]`, and `pids_limit` for the API container
- an internal API healthcheck against `/api/v2/version`

The image itself already uses `tini` as its entrypoint, so the overlay does not add a second init layer.

## Promotion workflow

The recommended production switchover path is:

1. Launch a parallel hardened stack on alternate loopback ports.
2. Validate `/api/v2/version`, migrations, and representative scan traffic.
3. Stop the old API and database containers that hold the primary ports.
4. Start the hardened stack on the primary ports with the base Compose file plus the hardened overlay.
5. Verify the primary endpoint and container health.

Example parallel validation command:

```bash
POSTGRES_BIND_HOST=127.0.0.1 POSTGRES_PORT=55432 OBSERVATORY_BIND_HOST=127.0.0.1 OBSERVATORY_PORT=3301 HTTPOBS_BASE_URL=http://127.0.0.1:3301 GIT_SHA=$(git rev-parse HEAD) RUN_ID=parallel-validate   docker compose -p mdn-http-observatory-hardened   -f docker-compose.yml   -f docker-compose.hardened.yml   up -d --build
```

Example primary-port promotion command:

```bash
GIT_SHA=$(git rev-parse HEAD) RUN_ID=manual-promote-$(date +%Y%m%d)   docker compose -p mdn-http-observatory   -f docker-compose.yml   -f docker-compose.hardened.yml   up -d --build
```

## Rollback workflow

If the hardened deployment must be rolled back quickly:

1. Stop the promoted hardened stack on the main ports.
2. Restart the previously stopped legacy API and database containers.
3. Re-check `http://127.0.0.1:3001/api/v2/version` and the relevant logs.

The current PostgreSQL service reuses the existing `mdn-http-observatory_postgres_data` volume, so the rollout and rollback path remain tied to the same live data set.

## Commands

### Start services

```bash
docker compose up -d
```

### Start the hardened stack

```bash
docker compose -f docker-compose.yml -f docker-compose.hardened.yml up -d
```

### Stop services

```bash
docker compose down
```

### Stop and remove volumes (fresh start)

```bash
docker compose down -v
```

### View logs

```bash
docker compose logs -f observatory
docker compose logs -f postgres
```

### Rebuild after code changes

```bash
docker compose up -d --build
```

### Access PostgreSQL directly

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

## Configuration

Docker Compose reads variables from `.env` automatically. The most relevant values are:

- `OBSERVATORY_PORT` and `OBSERVATORY_BIND_HOST` for the published API endpoint
- `POSTGRES_PORT`, `POSTGRES_BIND_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` for the database service
- `HTTPOBS_BASE_URL` if the generated `details_url` must point at a public hostname instead of the local default
- `GIT_SHA` and `RUN_ID` if the image metadata returned by `/api/v2/version` should reflect a specific promoted build

For non-Docker development, the application still supports the environment variables in `.env.example` directly.

## CI and image hardening

The CI workflow now validates both the codebase and the image path:

- the test workflow builds the Docker image locally in CI and scans it with Trivy
- the reusable build workflow scans before push and emits SBOM/provenance metadata on published images
- the runtime image is multi-stage and keeps build-only dependencies out of the final container

## Notes

- Database migrations run automatically before the API starts
- PostgreSQL data persists in the `postgres_data` volume
- The base Compose file removes writable host log mounts; use `docker compose logs` for runtime logs
- The PostgreSQL image remains the main special case for a future fully non-root rollout because of the upstream entrypoint lifecycle
- When promoting onto an existing local rootless Docker installation, Docker may warn that `mdn-http-observatory_postgres_data` already exists. That is expected for the live volume reuse case.
