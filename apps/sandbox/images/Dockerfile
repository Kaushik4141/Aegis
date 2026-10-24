# Single base image for both the agent container and the network-observer
# sidecar. procps -> ps, iproute2 -> ss, iptables -> enforce-mode rules.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl procps iproute2 iptables iputils-ping \
  && rm -rf /var/lib/apt/lists/*

# TypeScript agents run with zero project deps (the repo agents are plain TS).
RUN npm install -g tsx

# The official node image ships a `node` user with uid/gid 1000; agents run as
# that unprivileged user (supervisor drops privileges by uid).

WORKDIR /workspace
