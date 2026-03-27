# MDN HTTP Observatory — Docker management
# Usage: make [target] [HARDENED=1]

COMPOSE       := docker compose
COMPOSE_FILES := -f docker-compose.yml
PROJECT       := mdn-http-observatory

ifdef HARDENED
COMPOSE_FILES += -f docker-compose.hardened.yml
endif

DC := $(COMPOSE) -p $(PROJECT) $(COMPOSE_FILES)

.PHONY: build rebuild start stop restart up down logs status ps \
        health clean env shell db

## ── Lifecycle ───────────────────────────────────────────────

build:          ## Build images
	$(DC) build

rebuild:        ## Rebuild images from scratch (no cache)
	$(DC) build --no-cache --pull

start:          ## Start existing containers
	$(DC) start

stop:           ## Stop running containers (keep them)
	$(DC) stop

restart:        ## Restart containers
	$(DC) restart

up: env         ## Build and start in detached mode
	$(DC) up -d --build

down:           ## Stop and remove containers & network
	$(DC) down

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

clean:          ## Stop, remove containers, network AND volumes (fresh start)
	$(DC) down -v

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
