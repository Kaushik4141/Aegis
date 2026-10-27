#!/usr/bin/env bash
# One-time setup for an Aegis cloud VM: dependencies, database migrations,
# and the sandbox base image. Run from the repository root.
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "▸ Checking Docker…"
docker version --format 'Docker {{.Server.Version}}' >/dev/null || {
  echo "✗ Docker is required. Install it first: https://docs.docker.com/engine/install/" >&2
  exit 1
}

echo "▸ Installing dependencies…"
npm install --no-audit --no-fund

echo "▸ Applying local D1 migrations…"
npm run db:migrate

echo "▸ Building the sandbox base image (claude, codex, tsx, instrumentation)…"
docker build -t aegis-sandbox-base:latest -f apps/sandbox/images/Dockerfile apps/sandbox

echo "✓ VM ready. Start the stack with:"
echo "  docker compose -f deploy/cloud/docker-compose.yml up -d"
