.PHONY: help install install-dev test eval benchmark lint migrate up down

help:
	@echo "Targets:"
	@echo "  install      Install backend runtime dependencies"
	@echo "  install-dev  Install backend + test dependencies"
	@echo "  test         Run the backend test suite (needs a test Postgres)"
	@echo "  eval         Run the perception accuracy benchmark over fixtures"
	@echo "  benchmark    Run the real YOLO detector benchmark (recall + FP rate)"
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

benchmark:
	python -m backend.eval.detector_benchmark

migrate:
	alembic upgrade head

up:
	docker compose -f docker-compose.prod.yml up -d --build

down:
	docker compose -f docker-compose.prod.yml down
