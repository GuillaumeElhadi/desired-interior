.PHONY: setup lint format test build-sidecar clean-sidecar

TARGET_TRIPLE  := $(shell rustc --print host-tuple)
SIDECAR_BINARY := apps/desktop/src-tauri/binaries/interior-vision-api-$(TARGET_TRIPLE)

setup: ## Install dev dependencies and git hooks
	pnpm install
	pre-commit install
	pre-commit install --hook-type commit-msg
	pre-commit install --hook-type pre-push

build-sidecar: ## Build PyInstaller binary and copy to Tauri binaries dir
	cd apps/api && uv run pyinstaller \
		--onefile \
		--name interior-vision-api \
		--distpath dist \
		--workpath /tmp/pyinstaller-build \
		--specpath /tmp/pyinstaller-spec \
		--clean \
		run_server.py
	mkdir -p apps/desktop/src-tauri/binaries
	cp apps/api/dist/interior-vision-api $(SIDECAR_BINARY)
	@echo "Sidecar → $(SIDECAR_BINARY)"

clean-sidecar: ## Remove built sidecar binaries and PyInstaller artifacts
	rm -f apps/desktop/src-tauri/binaries/interior-vision-api-*
	rm -rf apps/api/dist apps/api/build
