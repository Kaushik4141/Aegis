# Single base image for both the agent container and the network-observer
# sidecar. procps -> ps, iproute2 -> ss, iptables -> enforce-mode rules.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl procps iproute2 iptables iputils-ping \
  && rm -rf /var/lib/apt/lists/*

# Agent-ready: TypeScript agents run with zero project deps, and the common
# coding agents are preinstalled so users drop straight into their normal tools.
RUN npm install -g tsx @anthropic-ai/claude-code @openai/codex

# Google Antigravity CLI (terminal-first agent surface); installer targets
# the invoking user's ~/.local, so relocate to a shared path readable by the
# unprivileged agent user.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
 && cp -r /root/.local /opt/antigravity \
 && chmod -R a+rX /opt/antigravity \
 && ln -sf /opt/antigravity/bin/agy /usr/local/bin/agy

# Instrumentation is baked in (not bind-mounted) so the same image works
# against any Docker daemon — local or remote.
COPY src/supervisor.cjs /aegis/supervisor.cjs
COPY src/netwatch.cjs /aegis/netwatch.cjs

# The official node image ships a `node` user with uid/gid 1000; agents run as
# that unprivileged user (supervisor drops privileges by uid).

WORKDIR /workspace
