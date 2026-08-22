# Security Policy

## Supported Versions

We provide security updates and patches for the following versions of **WSL Command**:

| Version  | Supported          | Notes |
| -------- | ------------------ | ----- |
| 0.2.1    | :white_check_mark: | **Security release** — strongly recommended |
| 0.2.0    | :white_check_mark: | Contains known issues fixed in 0.2.1 |
| < 0.2.0  | :x:                | Unsupported — upgrade immediately |

## Security Updates & Upgrade Advisory

> **2026-08: v0.2.1 shipped a security hardening release.** If you deployed any version
> **below 0.2.1**, please upgrade — earlier versions were vulnerable to a local
> **unauthenticated RCE chain** (see below).

Upgrade:

```bash
cd ~/wsl-command && git pull && pkill -f "python3 server.py"
nohup python3 server.py >/dev/null 2>&1 &
```

Then hard-refresh the dashboard in your browser (Ctrl+F5).

### What was fixed in v0.2.1

- **P0 — Unauthenticated RCE chain (fixed):** `POST /api/config` accepted writes without
  any origin validation and could store an arbitrary launch command for any project path;
  combined with `start_project`'s `shell=True`, a malicious page in your browser could
  execute arbitrary commands on your machine.
- **DNS rebinding (fixed):** all `/api/*` endpoints now validate the `Host` header must
  resolve to the local machine (`localhost` / `127.0.0.1` / `::1` / hostname).
- **Weak path validation (fixed):** project-control and config-write paths now use the
  strict `resolve()` + trailing-slash check, closing sibling-directory prefix bypasses
  (e.g. `/home/you-evil`) and symlink traversal.
- **Version skew (fixed):** in-code `VERSION` was 0.1.0 while releases were tagged 0.2.x.

## Security Model & Architecture

**WSL Command** is a local-only dashboard that runs inside your WSL2 / Linux subsystem.
Its security posture is **defense in depth across three layers**:

### 1. Network layer — loopback binding

The HTTP daemon binds exclusively to `127.0.0.1` (ports 9600–9609), which blocks access
from other machines on the network. This alone does **not** protect against requests
originating from your own browser — hence the layers below.

### 2. Request-source layer — Host / Origin / Token

Every `/api/*` request is validated:

- **Host header** must be a local name (`localhost`, `127.0.0.1`, `::1`, or the machine
  hostname). This blocks **DNS rebinding** attacks, where a malicious domain resolves to
  `127.0.0.1` but keeps an attacker-controlled `Host`.
- **All write endpoints** (`/api/config`, `/api/projects/*`, `/api/docker/*`,
  `/api/console/stop`, `/api/scan`, `/api/ui/theme`) additionally require:
  - a valid **`X-Auth-Token`** header — a random token generated at server startup and
    delivered only to the local frontend via `/api/state`; and
  - an **`Origin`** header that is empty or local. Cross-origin pages cannot read the
    token (no CORS headers are emitted), so they cannot forge a valid write request.

### 3. Path layer — strict validation

All path inputs (project control, config writes, file browsing) are normalized with
`Path.resolve()` and must equal `HOME` or live strictly under `HOME/` (trailing slash
required), blocking prefix/sibling bypasses and symlink escapes.

### Process & data model

- Actions triggered through the dashboard (start / stop projects, containers) run under
  the current user's unprivileged WSL context.
- Configuration (labels, pins, ignores) is stored in `~/.config/wsl-command/config.json`
  and written atomically (temp file + rename, mode `0600`).
- The core server uses only the Python standard library — zero third-party runtime
  dependencies, minimizing supply-chain risk.

### Residual risk

- The server intentionally executes user-configured launch commands with `shell=True`.
  Keep the dashboard reachable only from machines/processes you trust; a compromised
  shell account on the same machine already has equivalent power.
- `127.0.0.1` binding does not protect against **malicious code running locally**
  (a rogue browser extension, a tampered page, or another local process). The token /
  Host checks are the primary defense in that scenario.

## Reporting a Vulnerability

If you discover a security vulnerability in WSL Command, please follow responsible
disclosure guidelines:

1. **Do not** report security vulnerabilities via public GitHub issues.
2. Please report findings privately via **GitHub Security Advisories** (navigate to
   `Security` -> `Advisories` -> `New draft advisory` on this repository) or email the
   primary maintainer directly.
3. Include details:
   - Steps to reproduce the issue.
   - The operating environment (Windows version, WSL2 distro, Python version).
   - Potential impact and proof of concept if applicable.

We will acknowledge receipt of your vulnerability report within 48 hours and provide a
timeline for triage and resolution.
