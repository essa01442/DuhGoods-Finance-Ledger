#!/usr/bin/env bash

# basically uses electron's node to prevent
# mismatch in NODE_MODULE_VERSION when running
# better-sqlite3

export TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}'
export ELECTRON_RUN_AS_NODE=true
./node_modules/.bin/electron -r ts-node/register -r tsconfig-paths/register "$@"
