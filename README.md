# WSL 指挥中心 · wsl-command

> 一个运行在 WSL2 里的本地指挥中心：看看你家目录下都有什么项目、每个项目多少文件、谁在运行，还能一键启动 / 暂停项目进程、管理 Docker 容器。

---

**中文说明 · Chinese**

大家好！这是我第一次正经做的开源项目，很多地方肯定没做好，代码、UI、文档都欢迎提意见。希望有经验的朋友帮忙美化界面、补充功能，一起把它做好，让 WSL2 的小白用户都能用上顺手的本地工具 🙏

## 这是什么？

如果你刚用 WSL2，一定遇到过这些问题：

- 家目录下堆了一堆文件夹，分不清哪个是哪个项目
- 想知道哪个项目在跑、跑了什么进程
- 想一键启动 / 停掉项目服务，不想每次开终端敲命令
- Docker 容器启动了没有，也懒得 `docker ps`

这个指挥中心就是解决这些的——**装好后浏览器打开一个页面，全部搞定**。

## 功能一览

- 📊 **概览**：项目数 / 文件总数 / 磁盘占用 / 运行中进程 / CPU / 内存 实时曲线
- 📁 **项目**：自动扫描家目录，标注项目名称和备注，显示文件数、大小、git 最近提交
- ⚙️ **进程**：实时监控所有进程（含 root 与 Docker 容器进程），按项目归类，可排序搜索
- ▶️ **一键启停**：每个项目独立启动 / 暂停（自动识别启动命令，也支持手动配置）
- 🐳 **Docker 容器总览**：所有容器（含已停止的），运行状态、端口、归属项目，一键启停
- 📂 **文件浏览**：目录树 + 文本预览 + 复制 Linux / Windows 路径
- 🎨 深色 / 浅色 / 跟随系统三态主题，⌘K 命令面板，全键盘操作

## 快速开始

```bash
# 1. 克隆（放哪都行，比如家目录）
git clone https://github.com/kongaiyi917-source/wsl-command.git ~/wsl-command

# 2. 运行（只要 Python 3.10+，零第三方依赖）
cd ~/wsl-command
python3 server.py
```

浏览器打开 **http://localhost:9600**（端口被占用会自动顺延 9601-9609）。

> Windows 侧直接访问 localhost 即可（WSL2 默认端口转发）。

## 小白提示

- **项目** = 家目录下的第一层文件夹，新建文件夹后最长 2 分钟自动出现（也可点「刷新」立即扫描）
- **启动命令**：项目卡片点「⚙ 配置」填写（如 `python3 server.py`），或自动检测（package.json → `npm start` 等）
- **暂停安全**：只停止由指挥中心启动的进程；「停止全部」会停项目下所有进程（含手动启动的），有确认框，指挥中心自身进程除外

## 技术栈

| 部分 | 方案 |
|---|---|
| 后端 | Python 标准库（http.server），零第三方依赖，仅绑定 127.0.0.1 |
| 前端 | 原生 HTML / CSS / JavaScript（ES Modules），无构建、无 CDN、无网络请求 |
| 数据 | 配置存 `~/.config/wsl-command/config.json`，日志在 `logs/`，绝不进仓库 |

## 安全边界

- 只绑定回环地址，只服务本机当前用户，请勿反向代理 / 端口映射暴露到公网
- 文件接口限制在 `$HOME` 内，路径经过 realpath 校验
- 进程识别基于 `/proc` 与进程组 token，不会误杀非受控进程
- 容器名 / 项目名均做过注入校验

## 项目结构

```text
server.py           Python 标准库后端
static/index.html   单页应用
static/base.css     行为层样式
static/themes/      WSL 指挥台主题（浅色 / 深色 / 跟随系统）
static/app.js       前端主逻辑（ES Module）
static/js/          视图模块（概览 / 项目 / 进程 / 文件 / 控件）
```

## Roadmap（欢迎 PR）

- [ ] Windows 一键安装脚本 / 桌面启动器
- [ ] 进程级别的停止 / 重启
- [ ] 更多主题配色
- [ ] 配置文件导入导出

## License

[MIT](LICENSE) · 第三方组件见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)

---

**English · English**

Hi there! This is my first open-source project, so it's far from perfect — the code, UI and docs all welcome feedback. If you're experienced, please help polish the UI or add features; I'd love to make this a handy local tool for WSL2 beginners.

**wsl-command** is a local console for your WSL2 environment: it scans your home directory, shows every project folder, file counts, running processes, Docker containers — and lets you start / stop project services with one click.

### Features

- **Overview**: project count, total files, disk usage, live CPU / memory sparklines
- **Projects**: auto-scanned from `~`, label names & notes, file counts, git activity
- **Processes**: real-time table (all users incl. root & containers), sortable & filterable
- **One-click start / stop** per project (auto-detected or custom start command)
- **Docker overview**: all containers (incl. stopped), ports, project mapping, start / stop
- **File browser**: directory tree, text preview, copy Linux / Windows paths
- Dark / light / system themes, ⌘K command palette

### Quick start

```bash
git clone https://github.com/kongaiyi917-source/wsl-command.git ~/wsl-command
cd ~/wsl-command
python3 server.py        # Python 3.10+, no dependencies
```

Open **http://localhost:9600** in your browser (falls back to 9601-9609).

### Stack

- Backend: Python standard library only, loopback-bound
- Frontend: vanilla HTML/CSS/JS, no build step, no CDN
- Config: `~/.config/wsl-command/config.json` (never committed)

### Safety

Loopback-only, current-user only, path-traversal guarded, process-group-token based stop (never kills processes you started yourself).

## License

[MIT](LICENSE) · Third-party components in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)
