.PHONY: setup lint format test

setup: ## Install dev dependencies and git hooks
	pnpm install
	pre-commit install
	pre-commit install --hook-type commit-msg
