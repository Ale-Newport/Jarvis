# Jarvis: developer entry points. The desktop app lives in app/, the Python sidecar in backend/.
APP      := app
MOCK_PORT  ?= 8765
MOCK_TOKEN ?= devtoken

.PHONY: help install dev ui mock build test test-ui test-rust test-backend typecheck clean

help:
	@echo "make dev      Tauri dev app (Rust shell + Vite). Starts the real backend via 'uv run'."
	@echo "              Use the mock instead:  JARVIS_BACKEND_CMD=\"node app/dev/mock-backend.mjs\" make dev"
	@echo "make ui       Vite dev server only (browser at http://127.0.0.1:1420, needs ?backend=…&token=…)"
	@echo "make mock     Mock backend on port $(MOCK_PORT) (token '$(MOCK_TOKEN)') for UI development"
	@echo "make build    Package the backend (scripts/package-backend.sh) and build Jarvis.app"
	@echo "make test     UI unit tests, Rust tests and (if present) backend tests"
	@echo "make clean    Remove build output"

install:
	pnpm --dir $(APP) install

dev: install
	pnpm --dir $(APP) tauri dev

ui: install
	VITE_JARVIS_BACKEND=http://127.0.0.1:$(MOCK_PORT) VITE_JARVIS_TOKEN=$(MOCK_TOKEN) pnpm --dir $(APP) dev

mock: install
	JARVIS_PORT=$(MOCK_PORT) JARVIS_TOKEN=$(MOCK_TOKEN) node $(APP)/dev/mock-backend.mjs

build: install
	@if [ -x scripts/package-backend.sh ]; then ./scripts/package-backend.sh; \
	elif [ -f scripts/package-backend.sh ]; then bash scripts/package-backend.sh; \
	else echo "note: scripts/package-backend.sh not found; building the app without a packaged backend"; fi
	pnpm --dir $(APP) tauri build --bundles app

typecheck:
	pnpm --dir $(APP) typecheck

test: test-ui test-rust test-backend

test-ui: install
	pnpm --dir $(APP) typecheck
	pnpm --dir $(APP) test

test-rust:
	cd $(APP)/src-tauri && cargo test

test-backend:
	@if [ -f backend/pyproject.toml ]; then cd backend && uv run pytest; else echo "no backend/ to test"; fi

clean:
	rm -rf $(APP)/dist $(APP)/src-tauri/target
	find $(APP)/backend-dist/jarvis-backend -mindepth 1 ! -name .gitkeep -delete 2>/dev/null || true
