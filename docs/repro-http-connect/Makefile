# Reproduce the Envoy forward-proxy CONNECT data-tunneling limitation.
#
# Goal: show that HTTP/1.1 CONNECT relays real bytes, while HTTP/2 and HTTP/3
# CONNECT authenticate to 200 but do not relay payload bytes through the tunnel.
#
# Config (override via environment):
#   PROXY_HOST  proxy address (default 170.9.16.247)
#   PROXY_PORT  proxy port     (default 443)
#   PROXY_AUTH  Proxy-Authorization value, e.g. "Basic <base64(user:pass)>"
#   TARGET_HOST host to CONNECT to (default example.com)
#   TARGET_PORT port to CONNECT to (default 80)

# Optional real env file (path only; credentials stay out of git)
ENV_FILE ?=
ifneq ($(ENV_FILE),)
LOAD = -include $(ENV_FILE)
endif

GO      := go
PY      := python3
H1_DIR  := go/h1
H2_DIR  := go/h2
H3_DIR  := py/h3
H3_VENV := $(H3_DIR)/.venv

# ------------------------------------------------------------------ targets

.PHONY: all build run run-h1 run-h2 run-h3 lint-clean

all: build

## build all repro clients (go h1/h2, python venv for h3)
build:
	cd $(H1_DIR) && $(GO) build -o h1 .
	cd $(H2_DIR) && $(GO) build -o h2 .
	@echo "Built $(H1_DIR)/h1 and $(H2_DIR)/h2"
	@if [ ! -d $(H3_VENV) ]; then $(PY) -m venv $(H3_VENV) && $(H3_VENV)/bin/pip install -r $(H3_DIR)/requirements.txt; else echo "venv $(H3_VENV) already present"; fi

## run all three repros sequentially
run: run-h1 run-h2 run-h3

## HTTP/1.1 CONNECT (EXPECTED: 200 + data relayed)
run-h1: build
	cd $(H1_DIR) && PROXY_HOST=$(PROXY_HOST) PROXY_PORT=$(PROXY_PORT) \
	  PROXY_AUTH="$(PROXY_AUTH)" TARGET_HOST=$(TARGET_HOST) TARGET_PORT=$(TARGET_PORT) \
	  ./h1

## HTTP/2 CONNECT (EXPECTED: 200 but NO data relayed -> timeout)
run-h2: build
	cd $(H2_DIR) && PROXY_HOST=$(PROXY_HOST) PROXY_PORT=$(PROXY_PORT) \
	  PROXY_AUTH="$(PROXY_AUTH)" TARGET_HOST=$(TARGET_HOST) TARGET_PORT=$(TARGET_PORT) \
	  ./h2

## HTTP/3 (QUIC) CONNECT (EXPECTED: 200 but NO data relayed -> timeout)
run-h3: build
	cd $(H3_DIR) && PROXY_HOST=$(PROXY_HOST) PROXY_PORT=$(PROXY_PORT) \
	  PROXY_AUTH="$(PROXY_AUTH)" TARGET_HOST=$(TARGET_HOST) TARGET_PORT=$(TARGET_PORT) \
	  .venv/bin/python h3.py

## remove build artifacts and the python venv
clean:
	rm -f $(H1_DIR)/h1 $(H2_DIR)/h2
	rm -rf $(H3_VENV)
	@echo "cleaned"

# defaults (only used when not provided on the command line)
PROXY_HOST ?= 170.9.16.247
PROXY_PORT ?= 443
PROXY_AUTH ?= Basic dXV1OmNlNTNjeFZ1NzZma0RI
TARGET_HOST ?= example.com
TARGET_PORT ?= 80