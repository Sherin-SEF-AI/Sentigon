.PHONY: help install install-dev test eval lint migrate up down

help:
	@echo "Targets:"
	@echo "  install      Install backend runtime dependencies"
	@echo "  install-dev  Install backend + test dependencies"
	@echo "  test         Run the backend test suite (needs a test Postgres)"
	@echo "  eval         Run the perception accuracy benchmark over fixtures"
	@echo "  migrate      Apply database migrations (alembic upgrade head)"
	@echo "  up / down    Start / stop the production docker-compose stack"

install:
	pip install -r requirements.txt

install-dev:
	pip install -r requirements-dev.txt

test:
	pytest -ra

eval:
	python -m backend.eval.perception_eval

migrate:
	alembic upgrade head

up:
	docker compose -f docker-compose.prod.yml up -d --build

down:
	docker compose -f docker-compose.prod.yml down
