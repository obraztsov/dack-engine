# DACK — a Rust harness (`dack`) + TS side projects (Bun): the runtime bridge (`openclaude-bridge/`),
# the MCP servers + channel adapters (`mcp/`), and the recall servers (`recall-mcp/`).
# The harness spawns these per state invocation / as modules over stdio.
SHELL := /bin/bash
BRIDGE := openclaude-bridge
JS_PROJECTS := openclaude-bridge mcp recall-mcp

.PHONY: all build bridge deps test smoke run fmt lint clean dist help

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | sort

all: build

build: deps ## Release Rust binary + install every JS project's deps
	cargo build --release

deps bridge: ## Install the JS deps (bridge + mcp/ + recall-mcp/)
	@for p in $(JS_PROJECTS); do echo "bun install → $$p"; (cd $$p && bun install --frozen-lockfile); done

test: ## Rust test suite (offline, deterministic)
	cargo test

smoke: ## Live runtime smoke — needs OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
	cargo run --example live_bridge

run: ## Boot the harness (ingestion + consciousness loops)
	cargo run --release -- run

fmt: ## Format Rust
	cargo fmt

lint: ## Clippy, warnings-as-errors
	cargo clippy --all-targets -- -D warnings

clean: ## Remove build artifacts + bridge deps + dist
	cargo clean
	rm -rf $(BRIDGE)/node_modules dist

dist: build ## Assemble a deployable bundle (binary + bridge project)
	rm -rf dist && mkdir -p dist/$(BRIDGE)
	cp target/release/dack dist/
	cp $(BRIDGE)/bridge.ts $(BRIDGE)/package.json $(BRIDGE)/bun.lock dist/$(BRIDGE)/
	cp dack.config.example.yaml dist/
	@echo "dist/ ready: ./dack + $(BRIDGE)/ — on the box run 'cd $(BRIDGE) && bun install --frozen-lockfile'"
