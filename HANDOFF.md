# HANDOFF — 交接文档（给完全没有上下文的新会话）

> 2026-08 生成，2026-08-19 更新（发布 v0.2.0：项目卡片置顶 + 启动命令推断增强 + 全量中英文 i18n 国际化 + 开源双语文档）。本项目 = **WSL 指挥中心（wsl-command）**，一个运行在 WSL2 的本地项目控制台。
> 用户：panda917，WSL2 Ubuntu。当前模型不支持看图（用 image-describe skill 的 luna 代看）。

---

## 一、我们在做什么

用户要一个 **WSL2 本地控制台**：浏览器打开一个页面，能看到家目录下所有项目（每个文件夹是什么项目、多少文件、多大）、实时进程（含 root 和 Docker 容器进程）、Docker 容器总览，并能**一键启动/暂停项目进程**、管理容器。UI 风格来自开源项目 local-ops（Ops 指挥台风），但代码全部重写。

## 二、项目在哪、怎么跑

- 项目目录：**`/home/panda917/wsl-command`**（注意！不是 wsl-kongzhi，已改名）
- 启动：`cd ~/wsl-command && python3 server.py`（端口 9600，占用自动顺延 9601-9609）
- 访问：Windows 浏览器打开 http://localhost:9600
- 配置数据：`~/.config/wsl-command/config.json`（标注、启动命令、主题、忽略规则）
- 服务日志：`~/.config/wsl-command/logs/console.log`
- **当前服务正在运行**（pid 见 `pgrep -f "python3 server.py"`）

## 三、架构速览（零第三方依赖）

```
server.py              Python 标准库后端（http.server，仅绑 127.0.0.1）
static/index.html      单页应用骨架（支持 data-i18n 动态国际化）
static/app.js          主入口（ES Module）：轮询 /api/state 每 2s、⌘K 面板、路由、i18n 初始化
static/base.css        行为层样式；static/themes/wsl.css 视觉主题
static/js/core.js      工具函数/主题/浮层/toast
static/js/i18n.js      零依赖全量双语字典与动态翻译引擎（支持 EN / 中文 切换与系统语言识别）
static/js/projects.js  项目卡片网格 + 标注弹窗（含右上角 📌 置顶逻辑与启停按钮主逻辑）
static/js/overview.js  概览 KPI + 项目启停列表 + Docker 面板
static/js/processes.js 进程表格
static/js/files.js     文件浏览（树 + 预览抽屉）
static/js/control.js   启停操作（确认弹窗 + busy 加载态）★ 独立模块，避免循环依赖
static/js/widgets.js   右侧动态侧栏、设置/日志中心、预览抽屉
static/assets/         品牌图标与开源文档高清预览图（preview-launchpad.png / preview-overview.png）
```

后端核心 API：`/api/state`（聚合）、`/api/projects/start|stop|stop-all`、`/api/docker/start|stop`、`/api/tree`、`/api/file`、`/api/config`、`/api/scan`。

## 四、已完成（全部可用）

1. **项目扫描**：家目录第一层目录 = 项目；隐藏目录和 node_modules 等默认忽略（**`.claude` 等隐藏目录不会显示**，用户已接受）；8 线程并行 + mtime 增量，117 万文件 12 秒扫完
2. **概览页**：KPI（项目数/文件数/磁盘/进程/CPU/内存 spark 曲线）+「项目启停」列表（**只显示运行中的**）+ Docker 总览（**只显示运行中的容器**）+ 最近活跃（git）
3. **项目页**：卡片网格（运行中排前），每卡：标注名/备注/文件数/大小/git/启动命令，按钮 = **启停（play/square SVG 图标）+ ✏️ 修改（改名字备注命令）**，无命令项目点启动会引导配置
4. **进程页**：全用户进程（root 也显示）、Docker 容器进程识别（容器名/端口/归属）、排序过滤
5. **启停**：受控进程（token+pgid 识别，只停指挥中心启动的）vs 停止全部（含手动进程，有确认）；操作有确认弹窗 + "⋯ 处理中"加载态
6. **Docker**：全部容器（含停止的）、自动归属项目（目录名/前缀/镜像关键词三级规则）、启停
7. **文件浏览**：目录树懒加载、文本预览、复制 Linux/Windows 路径
8. **启动命令自动检测增强（2026-08-15）**：`detect_start_cmd` 规则扩展——`package.json`（scripts.start→`npm start` / scripts.dev→`npm run dev`）、`start.sh`/`run.sh`→`bash <脚本>`、`manage.py`→`python3 manage.py runserver`、`Cargo.toml`→`cargo run`、`go.mod`→`go run .`、`Makefile`→`make run`、`docker-compose.yml`→`docker compose up -d`、常见 Python 入口（main/app/run/bot/index.py）→`python3 <文件>`、Node 入口（server/app.js）→`node <文件>`；顺带修复坏 JSON 的 package.json 抛 ValueError 的隐患（外层 try 只捕 OSError，会 500）。验证：quant-bot 自动抓到 `bash start.sh`，pi-web 抓到 `npm start`
9. **卡片文案调整（2026-08-15）**：`projects.js` 无命令提示由「未配置启动命令，点击「▶ 启动」可快速配置」改为「尚未抓取到启动命令，点击「▶ 启动」可手动配置」
10. **桌面启动器**：Windows 桌面快捷方式 → `C:\Users\Administrator\wsl-kongzhi-launcher\`（vbs 隐藏运行 bat → wsl 调 start-server.sh）
11. **已开源**：GitHub `kongaiyi917-source/wsl-command`，README 中英双语、MIT、THIRD_PARTY_NOTICES（Lucide ISC / Geist Mono OFL）
12. **项目卡片置顶（2026-08-19）**：卡片右上角独立放置 📌 图钉按钮，同等运行状态内最高优先级（运行中置顶 > 普通运行中 > 未运行置顶 > 普通未运行）。配置保存在 `config.json` 的 `pins` 字段，跨会话与刷新持久化。
13. **全量中英文国际化 (i18n)（2026-08-19）**：新增 `static/js/i18n.js`，顶栏新增 `EN / 中` 一键切换，智能识别系统语言并持久化；全量覆盖 Launchpad、Overview、Processes、Explorer、Widgets、弹窗、Toast 及日志实时翻译。
14. **双语独立文档与高清预览图（2026-08-19）**：英文 `README.md` 与 中文 `README_zh.md` 独立架构，双向跳转；嵌入 `preview-launchpad.png` 与 `preview-overview.png`。

## 五、踩过的坑（⚠️ 绝对不要再踩）

### 后端
1. **`pkill -f "python3 server.py"` 会杀死自己**！pkill 匹配整条命令行，把承载 nohup 的 bash 也杀了。重启服务必须分两条命令执行（先 pkill 单独一行，再 nohup 启动）。
2. **import uuid 后写 `uuid4()` 会 NameError**（要 `uuid.uuid4()`）。更坑的是：那次 Popen 已先执行，进程成了**孤儿**（无记录，stop 管不到）。教训：启动进程的代码出错时立即 killpg 清理；改完先 py_compile。
3. **stop_project_all 不要按进程组过滤**（me_pgid 排除法误伤——同一终端环境所有进程共享 pgid，外部进程全被跳过）。只排除 `os.getpid()`。
4. **scan_all 增量跳过项目时 files/size 会归零**（KPI 文件总数变 "—"）。修复：done 时始终从 `projects_cache` 汇总总数。
5. **container_project_of 缓存竞态**：缓存 map 只存了第一个解析的容器，后续全返回 None。修复：锁内解析 + 按容器名命中缓存。
6. **docker start 不支持 `--time`**（只有 stop 支持）。
7. **目录改名要连配置一起迁**：`wsl-kongzhi`→`wsl-command` 时 CONFIG_DIR 跟着变，但 `~/.config/wsl-kongzhi/config.json` 的标注/启动命令没迁过去，一度全丢。改名前先迁移 config，改后验证 `curl /api/state` 的 cmd 字段。
8. **后端静态服务根路径**：index.html 引用 `/themes/wsl.css`、`/app.js`（根路径不是 /static/）——static 目录是 Web 根。改路径要同步。
9. **/api/console/stop 是优雅退出**（shutdown），别用 kill -9 测。

### 前端（ES Module 地狱）
10. **import 未导出的名字 = 整个模块链静默失败**！app.js 曾 import widgets.js 未导出的 `syncSettings` → 前端全部 JS 不执行（"点不动"）。**每次改完必须跑 import/export 一致性检查**（node 正则脚本，见下）。
11. **编辑时误删 DOM 挂载行**：createCard 里 `actions.append(primary, sub)` 曾被误删 → 按钮创建了但**不在 DOM**（零报错！）→ 用户看不到按钮。教训：**UI 改动必须用无头浏览器实际验证**，静态检查发现不了这类 bug。
12. **循环依赖**：overview ↔ projects 互相 import，把启停逻辑抽到独立 `control.js` 解决。
13. **浏览器缓存旧版页面**：改 UI 后用户可能还在跑旧 JS（旧 HTML 引用已删除的 ops.css → 404）。服务端已用 `Cache-Control: no-store`；用户侧要**强刷或关标签重开**。
14. **同一行卡片按钮不对齐**：卡片内容行数不同 → 按钮随内容浮动。修复：`.app-card .app-actions { margin-top: auto }` 钉在底部 + 图标统一 Lucide SVG（不要混用 Unicode ⏸/▶ 和 emoji ✏️，渲染尺寸不一）。
15. **置顶按钮 UI 避坑**：卡片底部操作栏空间有限，置顶按钮放在右上角绝对定位，避免挤压底部的「日志」与「复制路径」按钮。
16. **i18n 计数与日志语序**：动态数量（如 `6 projects` / `6 个项目`）需通过 `getLang()` 动态格式化，避免中文量词写死在拼接字符串中。

### Windows 启动器（bat/vbs）
15. **cmd 引号剥离会破坏 `wsl -e bash -lc "长命令"`**（bash 收到残缺引号）。解法：逻辑写进 WSL 侧脚本 `start-server.sh`，bat 只传无引号路径。
16. **bat 必须 CRLF + GBK 编码**（iconv 转），vbs 必须纯 ASCII + CRLF。LF 行尾会让 cmd 解析错乱（`setlocal` 变 `nabledelayedexpansion`）。
17. **bat 里别用 `timeout /t`**：隐藏窗口/管道下报 "Input redirection is not supported"。用 `powershell Start-Sleep`。

### 流程/环境
18. **当前模型不支持看图**：用户贴图用 `bash ~/.pi/agent/skills/image-describe/scripts/describe.sh <图片> "问题"`（luna 代看，走代理）。
19. **网络超时用代理重试**：`socks5://172.20.48.1:10808`（pip/curl 设 HTTPS_PROXY）。
20. **全局规则要求浏览器自动化用 agent-browser**（`npm i -g agent-browser && agent-browser install` + skill）。**Playwright 已按用户要求卸载**（用户嫌它比 agent-browser 重 800MB），**不要再装 Playwright**。
21. **git 历史已抹平**：仓库是单条初始提交。以后正常 commit + push 即可，不要再 force push（除非用户要求）。
22. **pkill 后同一命令行里 nohup 也会被误杀**（同第 1 条，强调两次）。
23. **pkill -f 匹配整条命令行，会连执行它的 bash 一起杀（2026-08-15 再次踩到）**：只要命令行字符串里含关键字（哪怕关键字只是被删文件的名字），当前 bash 就被匹配杀死，导致同一条命令里后续的 rm / nohup / curl 全部不执行（且几乎无报错）。教训：pkill 永远单独一行；要删文件/启动服务时，先单独 pkill，再分开执行下一步；或改用 `pgrep -f 精确模式` 先看 PID 再 kill。

## 六、常用验证命令

```bash
# 语法 + import/export 一致性（前端每次改动必跑）
node --check static/js/*.js && node --check static/app.js
cd static && node -e "…import/export 检查脚本…"   # 见会话记录，正则匹配 export function/const

# 后端
python3 -m py_compile server.py
curl -s http://localhost:9600/api/state | python3 -m json.tool | head

# UI 验证（如需浏览器：装 agent-browser 后用其截图/console 检查，不要用 Playwright）
```

## 七、用户偏好（重要）

- 中文交流；回复简洁、给方案让用户选，不擅自动手（全局规则）
- 用户嫌"控制/控制面板"掉价 → 现在全叫「**WSL 指挥中心 / wsl-command**」，**不要再出现"控制面板/控制台"字样**
- 概览页只显示运行中的项目/容器（隐藏未运行的），启动入口在项目页
- 启停操作都要确认弹窗 + 加载态；按钮要对齐（已修）
- 用户的真实项目：quant-bot（量化机器人，`python3 quant_bot.py`）、wechat-protocol（微信协议桥）、maixu-robot（麦序机器人）、wsl-command 自身；SDK/工具目录（Android/Flutter/Go/JDK/tools）已标注为工具链
- 已清理：Claude Code（全部）、Playwright、remotepi-adremoval（17GB APK 作业区）、`~/.config/wsl-kongzhi` 旧配置
- 项目收纳（projects/）下只剩两个抖音爬虫（DouYin_Spider-master / new），**用户明确要保留**

## 八、已知限制 / 待办

- 进程级停止/重启未做（只有项目级）——Roadmap 里，用户暂不要求
- weixin-bot 容器归属已按镜像规则归到微信协议桥（用户可接受）
- Roadmap 欢迎 PR：Windows 一键安装脚本、更多主题、配置导入导出
- HANDOFF.md 本身未提交 git（含本机环境信息，避免进开源仓库）
