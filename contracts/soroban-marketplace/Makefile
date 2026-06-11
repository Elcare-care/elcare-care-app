SHELL := /bin/bash
CONTRACT_NAME := soroban_marketplace
WASM_PATH := target/wasm32v1-none/release/$(CONTRACT_NAME).wasm
OPTIMISED_WASM := target/wasm32v1-none/release/$(CONTRACT_NAME).optimized.wasm

.PHONY: build test clean fmt check optimize

## Build the contract WASM
build:
	cargo build --target wasm32v1-none --release

## Run all unit tests
test:
	cargo test

## Run tests with verbose output
test-verbose:
	cargo test -- --nocapture

## Format source code
fmt:
	cargo fmt --all

## Lint
check:
	cargo clippy --all-targets -- -D warnings

## Shrink the WASM using stellar contract optimize
optimize: build
	stellar contract optimize --wasm $(WASM_PATH) --wasm-out $(OPTIMISED_WASM)
	@echo "Optimised WASM at: $(OPTIMISED_WASM)"
	@wasm-opt --version 2>/dev/null || echo "(install wasm-opt for further size reduction)"

## Clean build artefacts
clean:
	cargo clean
