#!/bin/sh
set -e
DIR="${DATA_DIR:-/data}"
mkdir -p "$DIR"
chown -R node:node "$DIR"
chmod 700 "$DIR"
exec runuser -u node -- node /app/server.js
