# WSL Command

<p align="center">
  <a href="README.md">English</a> •
  <a href="README_zh.md">中文说明</a>
</p>

<p align="center">
  <strong>An ultra-lightweight, zero-dependency local project dashboard & process orchestration console for WSL2 / Windows.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10+-3776AB.svg?style=flat&logo=python&logoColor=white" alt="Python 3.10+" />
  <img src="https://img.shields.io/badge/WSL2-Ubuntu%20%7C%20Debian-0078D6.svg?style=flat&logo=windows" alt="WSL2" />
  <img src="https://img.shields.io/badge/Dependencies-Zero%20(Standard%20Lib)-success.svg" alt="Zero Dependencies" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License MIT" />
</p>

<p align="center">
  <img src="static/assets/preview-launchpad.png" alt="WSL Command Launchpad" width="880" style="max-width: 100%; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.12);" />
</p>

<p align="center">
  <img src="static/assets/preview-overview.png" alt="WSL Command Overview Telemetry" width="880" style="max-width: 100%; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.12);" />
</p>

---

## 🚀 Overview

**WSL Command** is an ultra-fast, standalone local workspace dashboard designed for developers using WSL2 on Windows. It eliminates the friction of managing dozens of local repositories, mystery background processes, and Docker containers across the Windows-Linux subsystem boundary.

Open a single web page to gain complete visibility and control over your development environment.

### ✨ Key Features

- 📊 **Dashboard / Telemetry**: Live CPU / Memory sparklines, project count, total files, disk footprints, and active background threads.
- 📁 **Launchpad & Card Pinning**: Automatic discovery of workspace projects under `$HOME`, intelligent startup script inference (`npm`, `python`, `sh`, `docker-compose`), custom notes/labels, and **quick-access card pinning** with prioritized state sorting.
- ⚙️ **Process Telemetry**: Real-time process inspection across all users (including `root` and Docker containers), memory/CPU usage, project-level grouping, and one-click filtering.
- ▶️ **One-Click Lifecycle Management**: Start, stop, and restart individual project services or entire process groups with safe confirmation prompts and graceful teardown.
- 🐳 **Docker Integration**: Live inspection of all local containers, active ports, runtime states, and unified start/stop triggers.
- 📂 **Explorer & Path Conversion**: Interactive directory tree, instant file preview, dotfile toggle, and one-click copy for both Linux (`/home/...`) and Windows (`\\wsl.localhost\...`) paths.
- 🌐 **Full Internationalization (i18n)**: Seamless instant English / 中文 bilingual switching with automatic OS language detection.
- 🎨 **Adaptive Themes & Command Palette**: Dark / Light / System auto modes with full `⌘K` / `Ctrl+K` keyboard navigation.

### ⚡ Quick Start

Zero installation, zero third-party packages, zero npm/build steps. Powered strictly by Python's standard library and modern native ES modules.

```bash
# 1. Clone to your WSL2 home directory
git clone https://github.com/kongaiyi917-source/wsl-command.git ~/wsl-command

# 2. Start the local server (Requires Python 3.10+, zero pip dependencies)
cd ~/wsl-command
python3 server.py
```

Open **http://localhost:9600** in your Windows or Linux browser. (Automatically falls back to `9601`–`9609` if the port is occupied).

> *Note: Windows host can access localhost directly thanks to WSL2's built-in port forwarding.*

### 🛠️ Architecture & Philosophy

| Component | Stack & Architecture |
|---|---|
| **Backend** | Python 3.10+ Standard Library (`http.server`, `subprocess`, `os`), strictly bound to `127.0.0.1` |
| **Frontend** | Vanilla ES Modules, CSS Custom Properties, native SVG icon subset (Zero npm, zero CDN, 100% offline) |
| **Storage** | Safe JSON configuration at `~/.config/wsl-command/config.json`, runtime logs in `logs/` |

### 🔒 Security Boundary

- **Localhost Only**: Strictly binds to `127.0.0.1`. Never expose to public networks or port-forwarding without authentication.
- **Path Traversal Guard**: File and directory APIs are strictly confined within `$HOME` with `realpath` boundary checks.
- **Process Isolation**: Process termination uses exact process group tokens and PID validation to prevent killing unrelated system tasks.

### 📄 License

This project is licensed under the [MIT License](LICENSE).
