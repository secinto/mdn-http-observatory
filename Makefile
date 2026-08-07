# MDN HTTP Observatory — Docker management
# Usage: make [target] [HARDENED=1]

COMPOSE       := docker compose
COMPOSE_FILES := -f docker-compose.yml
PROJECT       := mdn-http-observatory

ifdef HARDENED
COMPOSE_FILES += -f docker-compose.hardened.yml
endif

DC := $(COMPOSE) -p $(PROJECT) $(COMPOSE_FILES)

# Image Compose builds for the observatory service. The service declares only
# `build:`, so Compose names the image <project>-<service>.
OBS_IMAGE := $(PROJECT)-observatory

# Volume holding the scan database. Declared `external` in docker-compose.yml so
# that `down -v` can never destroy the scan history; created on demand below.
PG_VOLUME := $(PROJECT)_postgres_data

# Create the scan-database volume on a fresh install (no-op once it exists).
# Must run before any `up`, since Compose refuses to start with a missing
# external volume.
ENSURE_VOL = @docker volume inspect $(PG_VOLUME) >/dev/null 2>&1 \
	|| (echo "Creating scan database volume $(PG_VOLUME)…" && docker volume create $(PG_VOLUME) >/dev/null)

# Start postgres only when it is not already running.
ENSURE_PG = @docker ps -q --filter "name=$(PROJECT)-postgres-1" --filter "status=running" | grep -q . \
	|| (echo "PostgreSQL not running — starting it…" && $(DC) up -d --wait postgres)

# Warn when the running container is not on the image Compose would deploy.
# `build` only produces an image and `start` only restarts the existing
# container, so a fresh build stays invisible until something *recreates* the
# container. That gap is what left the build host serving a four-month-old
# scanner while a current image sat unused on disk.
WARN_STALE = @running=$$(docker inspect -f '{{.Image}}' $(PROJECT)-observatory-1 2>/dev/null || true); \
	built=$$(docker image inspect -f '{{.Id}}' $(OBS_IMAGE) 2>/dev/null || true); \
	if [ -n "$$running" ] && [ -n "$$built" ] && [ "$$running" != "$$built" ]; then \
		echo ""; \
		echo "  WARNING: the running container uses a stale image."; \
		echo "    running: $$running"; \
		echo "    built:   $$built"; \
		echo "    Run 'make restart' to deploy the image you just built."; \
		echo ""; \
	fi

.PHONY: build rebuild start stop restart up down logs logs-api logs-db \
        status ps health clean destroy-data env shell db help

## ── Lifecycle ───────────────────────────────────────────────

build:          ## Build observatory image (does not deploy — see restart)
	$(DC) build observatory
	$(WARN_STALE)

rebuild:        ## Rebuild image from scratch (no cache) and deploy it
	$(DC) build --no-cache --pull observatory
	$(MAKE) restart

start:          ## Start observatory (keeps its current image)
	$(ENSURE_VOL)
	$(ENSURE_PG)
	$(DC) start observatory
	$(WARN_STALE)

stop:           ## Stop observatory (keeps postgres running)
	$(DC) stop observatory

restart:        ## Recreate observatory on the latest built image (waits for healthy)
	$(DC) stop observatory
	$(ENSURE_VOL)
	$(ENSURE_PG)
	$(DC) up -d --wait observatory

up: env         ## Build and start observatory in detached mode
	$(ENSURE_VOL)
	$(ENSURE_PG)
	$(DC) up -d --build --wait observatory

down:           ## Stop and remove observatory container
	$(DC) stop observatory
	$(DC) rm -f observatory

## ── Observability ───────────────────────────────────────────

logs:           ## Tail all logs (Ctrl-C to quit)
	$(DC) logs -f

logs-api:       ## Tail observatory API logs
	$(DC) logs -f observatory

logs-db:        ## Tail PostgreSQL logs
	$(DC) logs -f postgres

status: ps      ## Alias for ps
ps:             ## Show container status
	$(DC) ps

health:         ## Quick health check against the API
	@curl -sf http://localhost:$${OBSERVATORY_PORT:-3001}/api/v2/version \
		&& echo "" || echo "API not reachable"

## ── Cleanup ─────────────────────────────────────────────────

clean:          ## Stop and remove containers & network (scan database is kept)
	$(DC) down

destroy-data:   ## DANGER: permanently delete the scan database volume
	@printf 'This deletes ALL scan history in $(PG_VOLUME). Type YES to confirm: ' \
		&& read ans && [ "$$ans" = "YES" ] || (echo "Aborted." && exit 1)
	$(DC) down
	docker volume rm $(PG_VOLUME)

## ── Helpers ─────────────────────────────────────────────────

env:            ## Create .env from .env.example if missing
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example")

shell:          ## Open a shell inside the observatory container
	$(DC) exec observatory sh

db:             ## Open psql inside the postgres container
	$(DC) exec postgres psql -U "$${POSTGRES_USER:-postgres}" -d "$${POSTGRES_DB:-observatory}"

help:           ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
