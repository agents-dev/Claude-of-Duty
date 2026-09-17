# Claude-of-Duty — `make` entry points (thin wrappers over npm).
#
#   make build    install deps (if needed) and run the production build
#   make dev      start the dev server (http://127.0.0.1:5173)
#   make preview  serve the production build
#   make shot     capture one frame (tools/capture.mjs, SHOT=hero OUT=shots/hero.png)
#
# Low-spec check: open http://127.0.0.1:5173/?q=low (the `low` quality preset
# enables world batch-combining + the cut-down render path).

.PHONY: build dev preview shot install

install:
	npm install

build: install
	npm run build

dev:
	npm run dev

preview: build
	npm run preview

shot:
	node tools/capture.mjs --shot=$(or $(SHOT),default) --out=$(or $(OUT),shots/default.png)
