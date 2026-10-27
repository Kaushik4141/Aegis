# Aegis cloud deployment

Runs the full stack — policy gateway, sandbox service, dashboard — on any
cloud VM with Docker. Sandboxes are real Linux containers on that VM, so the
complete instrumentation (netwatch sidecar, DNS logging, shadow-access
detection, enforce-mode iptables) works exactly as it does locally.

```text
browser ──► :3000 dashboard ──► :8787 gateway (policy, audit, HITL)
                     │
                     └► :8788 sandbox service ──► Docker daemon (VM)
                                                   ├─ agent containers
                                                   └─ netwatch sidecars
```

## One-time VM setup

```bash
# 1. A fresh VM (Ubuntu/Debian/Arch) with Docker installed, then:
git clone <your-repo> aegis && cd aegis
./deploy/cloud/setup.sh        # installs deps, builds image, applies migrations
```

## Run the stack

```bash
docker compose -f deploy/cloud/docker-compose.yml up -d
```

Open `http://<VM-IP>:3000` — the dashboard, gateway, and sandbox terminals
behave exactly like the desktop app. Create an interactive workspace and run
`claude` / `codex` from the terminal inside the browser.

Environment (set in `deploy/cloud/.env` or the compose file):

| Variable | Purpose |
| --- | --- |
| `SENTINEL_ADMIN_TOKEN` | **Set this.** Control-plane auth for a public VM. |
| `SENTINEL_SHADOW_WATCHLIST` | Extra hosts treated as business systems (comma-separated). |
| `AEGIS_PUBLIC_ORIGIN` | Public origin of the VM, used for container event URLs. |

## Remote Docker from an existing control plane

The sandbox service is daemon-agnostic: point `DOCKER_HOST` at any reachable
Docker daemon and sandboxes are created *there*, with events, alerts, and
terminals still flowing through your gateway.

```bash
# Recommended: an SSH tunnel to the VM's daemon, then:
DOCKER_HOST=tcp://localhost:2375 npm run dev:sandbox
```

Workspaces are daemon-side named volumes (`aegis-ws-*`) and the supervisor /
netwatch scripts are baked into the image — nothing on the control-plane host
is path-coupled to the sandbox host.

## Security notes for public exposure

- Terminate TLS in front (Caddy/nginx) and set `NEXT_PUBLIC_SANDBOX_WS_URL`
  to the `wss://` origin so browser terminals reach the service.
- `SENTINEL_ADMIN_TOKEN` protects the gateway control plane; put the same
  token on the sandbox service's gateway client.
- Firewall every port except 3000/8788 (and 22). The gateway (8787) should
  only be reachable from the dashboard and the sandbox service.
