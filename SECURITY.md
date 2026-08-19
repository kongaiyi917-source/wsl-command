# Security Policy

## Supported Versions

We provide security updates and patches for the following versions of **WSL Command**:

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2.0 | :x:                |

## Security Model & Architecture

**WSL Command** is designed to run strictly on `localhost` (127.0.0.1) inside the local WSL2 / Linux subsystem.

- **Localhost Binding**: By default, the HTTP daemon binds exclusively to local loopback addresses to prevent unauthorized external network access.
- **Process & Command Execution**: Actions triggered through the dashboard (such as starting, restarting, or stopping services) run under the current user's unprivileged WSL context.
- **Zero Remote Dependencies**: The core server uses only Python standard library modules without third-party dependencies, minimizing supply chain vulnerabilities.

## Reporting a Vulnerability

If you discover a security vulnerability in WSL Command, please follow responsible disclosure guidelines:

1. **Do not** report security vulnerabilities via public GitHub issues.
2. Please report findings privately via **GitHub Security Advisories** (navigate to `Security` -> `Advisories` -> `New draft advisory` on this repository) or email the primary maintainer directly.
3. Include details:
   - Steps to reproduce the issue.
   - The operating environment (Windows version, WSL2 distro, Python version).
   - Potential impact and proof of concept if applicable.

We will acknowledge receipt of your vulnerability report within 48 hours and provide a timeline for triage and resolution.
