#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wsl-command · WSL2 本地指挥中心
Python 标准库后端（零第三方依赖）。
仅绑定回环地址，只服务本机当前用户。

运行: python3 server.py   (或 ./start.sh)
"""

import hashlib
import json
import os
import pwd
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
import secrets
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "0.2.1"
APP_NAME = "wsl-command"
HOME = Path.home()
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

CONFIG_DIR = Path(os.environ.get("WSL_KZ_DATA_DIR", "~/.config/wsl-command")).expanduser()
CONFIG_PATH = CONFIG_DIR / "config.json"
CONFIG_BAK_PATH = CONFIG_DIR / "config.json.bak"
LOG_DIR = CONFIG_DIR / "logs"
LOG_PATH = LOG_DIR / "console.log"

DEFAULT_PORT = 9600
MAX_PORT_TRIES = 10
PORT_RANGE = (DEFAULT_PORT, DEFAULT_PORT + MAX_PORT_TRIES - 1)

SCAN_INTERVAL = 120          # 全量文件统计的后台刷新间隔（秒）
SCAN_WORKERS = 8             # 并行扫描线程数
PROCESS_CACHE_TTL = 2.0     # 进程快照缓存（秒）
GIT_INTERVAL = 300          # git 提交信息刷新间隔（秒）
MAX_FILE_PREVIEW = 512 * 1024  # 文本预览最大字节数
MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024   # 上传单文件上限 2GB
UPLOAD_CHUNK = 1024 * 1024                 # 上传/下载流式分块 1MB

WSL_DISTRO = os.environ.get("WSL_DISTRO_NAME", "Ubuntu")

PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
CLK_TCK = os.sysconf("SC_CLK_TCK")
NPROC = os.cpu_count() or 1

# ---------------------------------------------------------------- 默认忽略规则
DEFAULT_IGNORE_NAMES = {
    "node_modules", "venv", ".venv", "env", "__pycache__", "dist", "build",
    ".git", ".cache", ".local", ".config", ".npm", ".rustup", ".cargo",
    ".conda", ".vscode-server", ".nvm", ".gradle", ".m2", ".idea", ".bun",
    ".terraform", "site-packages", "target", ".dart_tool", ".next",
    ".nuxt", ".turbo", "coverage", ".pytest_cache", ".mypy_cache",
    ".DS_Store", "Thumbs.db",
}

DEFAULT_IGNORE_PREFIXES = [
    "go/pkg/mod", "go/bin", ".cache", ".local", ".config",
]

# ---------------------------------------------------------------- 日志
_log_lock = threading.Lock()


def log(msg: str):
    line = "%s [%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                           threading.current_thread().name, msg)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with _log_lock:
            if LOG_PATH.exists() and LOG_PATH.stat().st_size > 1_000_000:
                LOG_PATH.replace(LOG_PATH.with_suffix(".log.old"))
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except OSError:
        pass
    print(line, file=sys.stderr, flush=True)


def tail_log(n=80):
    try:
        lines = LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
        return lines[-n:]
    except OSError:
        return ["(暂无日志)"]


# ---------------------------------------------------------------- 配置
DEFAULT_CONFIG = {
    "schemaVersion": 1,
    "labels": {},      # {abs_path: {"name": str, "note": str}}
    "pins": [],        # [abs_path, ...] 用户置顶的项目路径列表
    "ignores": [],     # 用户额外忽略规则（子串匹配路径组件）
    "theme": "auto",   # auto | light | dark
    "process_notes": {},    # {proc_key: {"note": str}} 进程手动备注（按 项目路径+命令行 持久化）
    "process_history": {},  # {project_path: [{key,comm,cmd,cwd,last_seen}]} 项目进程历史（服务端维护）
    "locked_paths": [],     # [abs_path, ...] 用户手动软锁的文件/目录（锁目录 = 锁整个子树）
}

_config_lock = threading.Lock()
_config = dict(DEFAULT_CONFIG)

# ---- 鉴权守卫 ----
# 每次启动随机生成，仅通过 /api/state 下发给本机前端；
# 敏感写接口要求 X-Auth-Token 匹配，阻止浏览器跨站/本机恶意页面直接调 API。
_AUTH_TOKEN = secrets.token_hex(16)


def _home_path_ok(raw: str) -> bool:
    """严格路径校验：resolve 后必须等于 HOME 或位于 HOME 下（带斜杠前缀）。"""
    try:
        p = Path(raw).resolve()
    except (OSError, ValueError):
        return False
    s = str(p)
    return s == str(HOME) or s.startswith(str(HOME) + "/")


def _hostname_allowed(host: str) -> bool:
    host = host.split(":", 1)[0].strip().strip("[]").lower()
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    try:
        return host == socket.gethostname().lower()
    except OSError:
        return False


def _atomic_write(path: Path, text: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_config():
    global _config
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        cfg = dict(DEFAULT_CONFIG)
        for k in ("labels", "pins", "ignores", "theme",
                  "process_notes", "process_history", "locked_paths"):
            if k in raw and isinstance(raw[k], type(cfg[k])):
                cfg[k] = raw[k]
        _config = cfg
    except (OSError, ValueError):
        _config = dict(DEFAULT_CONFIG)
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        if not CONFIG_PATH.exists():
            save_config()
    except OSError as e:
        log("配置目录不可写: %s" % e)


def save_config():
    with _config_lock:
        text = json.dumps(_config, ensure_ascii=False, indent=2)
        try:
            if CONFIG_PATH.exists():
                _atomic_write(CONFIG_BAK_PATH, CONFIG_PATH.read_text(encoding="utf-8"))
            _atomic_write(CONFIG_PATH, text)
        except OSError as e:
            log("保存配置失败: %s" % e)
            return False
    return True


# ---------------------------------------------------------------- 忽略判断
def _is_hidden(name: str) -> bool:
    return name.startswith(".")


def is_ignored_name(name: str) -> bool:
    if name in DEFAULT_IGNORE_NAMES:
        return True
    for rule in _config["ignores"]:
        rule = rule.strip()
        if not rule:
            continue
        if rule.startswith("/"):
            continue
        if rule in name:
            return True
    return False


def is_ignored_path(rel: str) -> bool:
    """rel: 相对于 HOME 的 posix 路径，判断是否命中忽略（含用户绝对规则）"""
    parts = [p for p in rel.split("/") if p]
    for p in parts:
        if is_ignored_name(p):
            return True
    for rule in _config["ignores"]:
        rule = rule.strip().lstrip("/")
        if not rule:
            continue
        if rel == rule or rel.startswith(rule + "/"):
            return True
        if "/" in rule:
            # 允许规则匹配任意深度的相对路径段
            if rule in rel:
                return True
    return False


# ---------------------------------------------------------------- 文件扫描
scan_lock = threading.Lock()
scan_status = {"state": "idle", "started": None, "finished": None, "message": ""}
projects_cache = {}          # {abs_path(str): dict}
projects_mtime = 0.0
git_cache = {}               # {abs_path: {hash, date, subject}}
git_fetching = False


def _walk_stats(root: Path):
    """递归统计文件数与字节数（跳过忽略目录/隐藏目录），并返回收集到的第一层子目录（用于项目检测）。"""
    file_count = 0
    total_size = 0
    subdirs = []
    try:
        with os.scandir(root) as it:
            for e in it:
                try:
                    if e.is_symlink():
                        continue
                    if e.is_dir():
                        if _is_hidden(e.name) or is_ignored_name(e.name):
                            continue
                        subdirs.append(e.name)
                    elif e.is_file():
                        if _is_hidden(e.name) or is_ignored_name(e.name):
                            continue
                        try:
                            st = e.stat()
                        except OSError:
                            continue
                        file_count += 1
                        total_size += st.st_size
                except OSError:
                    continue
    except OSError:
        pass

    for d in subdirs:
        sub_file, sub_size, _ = _walk_stats(root / d)
        file_count += sub_file
        total_size += sub_size
    return file_count, total_size, subdirs


def _project_type_hint(root: Path) -> str:
    for marker, t in (
        ("package.json", "Node.js"),
        ("pyproject.toml", "Python"),
        ("requirements.txt", "Python"),
        ("Cargo.toml", "Rust"),
        ("go.mod", "Go"),
        ("composer.json", "PHP"),
        ("pom.xml", "Java"),
        ("Makefile", "Make"),
        ("CMakeLists.txt", "CMake"),
        ("Dockerfile", "Docker"),
        ("manage.py", "Django"),
    ):
        if (root / marker).exists():
            return t
    if (root / ".git").exists() or (root / ".hg").exists():
        return "Git 仓库"
    return ""


def _scan_one_project(name: str):
    """扫描单个项目并增量更新缓存/进度（供线程池调用）。
    若项目目录 mtime 与上次一致则跳过重扫。"""
    p = HOME / name
    try:
        mtime_ns = p.stat().st_mtime_ns
    except OSError:
        return
    pj = str(p)
    prev = projects_cache.get(pj)
    if prev and prev.get("_mtime_ns") == mtime_ns:
        with scan_lock:
            scan_status["done_projects"] += 1
        return
    fc, sz, _ = _walk_stats(p)
    info = {
        "path": pj,
        "name": name,
        "file_count": fc,
        "size_bytes": sz,
        "type_hint": _project_type_hint(p),
        "_mtime_ns": mtime_ns,
    }
    with scan_lock:
        projects_cache[pj] = info
        scan_status["done_projects"] += 1
        scan_status["files"] = (scan_status.get("files") or 0) + fc
        scan_status["size"] = (scan_status.get("size") or 0) + sz
        scan_status["message"] = "正在扫描 %s…" % name
    log("项目 %s: %d 个文件, %.1f MB" % (name, fc, sz / 1048576))


def scan_all():
    """全量扫描：家目录第一层文件夹 = 项目；并行统计文件数/大小。
    完成一个项目即更新缓存，前端可渐进看到结果。"""
    global projects_cache, scan_status
    with scan_lock:
        if scan_status["state"] == "scanning":
            return
        scan_status = {"state": "scanning", "started": time.time(),
                       "finished": None, "message": "正在扫描 ~ …",
                       "done_projects": 0, "projects": None,
                       "files": None, "size": None}
    log("开始全量扫描 %s" % HOME)

    names = []
    try:
        for e in sorted(os.scandir(HOME), key=lambda e: e.name.lower()):
            try:
                if e.is_dir() and not e.is_symlink() and not _is_hidden(e.name) \
                        and not is_ignored_name(e.name):
                    names.append(e.name)
            except OSError:
                continue
    except OSError as e:
        log("扫描出错: %s" % e)

    with scan_lock:
        # 清掉已不存在的项目
        for pj in list(projects_cache):
            if Path(pj).name not in names:
                projects_cache.pop(pj, None)

    if names:
        with ThreadPoolExecutor(max_workers=min(SCAN_WORKERS, len(names))) as ex:
            list(ex.map(_scan_one_project, names))

    with scan_lock:
        # 无论增量跳过多少项目，始终从缓存汇总准确总数
        total_f = sum(p.get("file_count", 0) for p in projects_cache.values())
        total_s = sum(p.get("size_bytes", 0) for p in projects_cache.values())
        scan_status.update({
            "state": "done", "finished": time.time(), "message": "",
            "projects": len(projects_cache),
            "files": total_f, "size": total_s,
        })
    log("扫描完成: %d 个项目, %d 个文件, %.1f MB" % (
        len(projects_cache), scan_status.get("files") or 0,
        (scan_status.get("size") or 0) / 1048576))

    threading.Thread(target=fetch_git_info, name="git-worker", daemon=True).start()


def fetch_git_info():
    """后台为有 .git 的项目抓取最近提交信息。"""
    global git_cache, git_fetching
    if git_fetching:
        return
    git_fetching = True
    try:
        with scan_lock:
            paths = list(projects_cache.keys())
        for p in paths:
            try:
                if not (Path(p) / ".git").exists():
                    continue
                out = subprocess.run(
                    ["git", "-C", p, "log", "-1", "--format=%h|%cs|%s"],
                    capture_output=True, text=True, timeout=5,
                ).stdout.strip()
                if out and "|" in out:
                    h, d, s = out.split("|", 2)
                    git_cache[p] = {"hash": h, "date": d, "subject": s[:80]}
                else:
                    git_cache.pop(p, None)
            except (subprocess.TimeoutExpired, OSError):
                git_cache.pop(p, None)
        # 清理已不存在的项目
        for p in list(git_cache):
            if p not in paths:
                git_cache.pop(p, None)
    finally:
        git_fetching = False


def scan_worker():
    while True:
        scan_all()
        time.sleep(SCAN_INTERVAL)


# ---- Docker 容器识别（root 容器进程也能归属到项目） ----
_docker_lock = threading.Lock()
_docker_cache = {"ts": 0.0, "map": {}}   # pid -> {name, ports}
_docker_list_cache = {"ts": 0.0, "list": []}  # 全量容器列表（含停止）
_container_proj_cache = {"ts": 0.0, "map": {}}  # 容器名 -> 项目名


def docker_map():
    """pid -> {name, image, ports}（容器主进程 pid 到容器信息）。缓存 15s。"""
    now = time.time()
    with _docker_lock:
        if now - _docker_cache["ts"] < 15:
            return _docker_cache["map"]
    out = {}
    try:
        r = subprocess.run(["docker", "ps", "-q"], capture_output=True, text=True, timeout=5)
        ids = [x for x in r.stdout.split() if x]
        if ids:
            fmt = "{{.Name}} {{.State.Pid}} {{.Config.Image}} {{range $p, $conf := .NetworkSettings.Ports}}{{$p}} {{end}}"
            r2 = subprocess.run(["docker", "inspect", "-f", fmt] + ids,
                                capture_output=True, text=True, timeout=8)
            for line in r2.stdout.splitlines():
                parts = line.split()
                if len(parts) >= 2:
                    name = parts[0].lstrip("/")
                    try:
                        pid = int(parts[1])
                    except ValueError:
                        continue
                    image = parts[2] if len(parts) > 2 else ""
                    ports = [p.split("/")[0] for p in parts[3:] if "/" in p]
                    out[pid] = {"name": name, "image": image, "ports": ports}
    except (OSError, subprocess.TimeoutExpired):
        pass
    with _docker_lock:
        _docker_cache["ts"] = now
        _docker_cache["map"] = out
    return out


def docker_list():
    """全部容器（含已停止）：name/image/status/ports/created/project/running。缓存 10s。"""
    now = time.time()
    with _docker_lock:
        if now - _docker_list_cache["ts"] < 10 and _docker_list_cache["list"]:
            return _docker_list_cache["list"]
    out = []
    try:
        r = subprocess.run(["docker", "ps", "-a", "--no-trunc", "--format",
                            "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.CreatedAt}}|{{.ID}}"],
                           capture_output=True, text=True, timeout=8)
        for line in r.stdout.splitlines():
            parts = line.split("|", 5)
            if len(parts) < 6:
                continue
            name, image, status, ports, created, cid = parts
            name = name.lstrip("/")
            running = status.startswith("Up")
            # 端口解析：0.0.0.0:8000->8000/tcp → 8000
            port_list = []
            seen_p = set()
            for seg in ports.split(","):
                m = re.search(r":(\d+)->", seg.strip())
                if m and m.group(1) not in seen_p:
                    seen_p.add(m.group(1))
                    port_list.append(m.group(1))
            out.append({
                "name": name,
                "image": image,
                "status": status,
                "running": running,
                "ports": port_list,
                "created": created,
                "id": cid,
                "project": container_project_of(name, image),
            })
    except (OSError, subprocess.TimeoutExpired):
        pass
    with _docker_lock:
        _docker_list_cache["ts"] = now
        _docker_list_cache["list"] = out
    return out


def container_project_of(container_name: str, image: str = ""):
    """容器 → 项目名启发式（全程持锁，避免多线程竞态）：
    1) 精确/二级目录匹配 2) 名称段前缀（maixu-gewe → maixu-robot）
    3) 前缀匹配 4) 镜像关键词（gewe/weixin → wechat-protocol）。缓存 60s。"""
    if not container_name:
        return None
    now = time.time()
    with _docker_lock:
        cached = _container_proj_cache["map"]
        if now - _container_proj_cache["ts"] < 60 and container_name in cached:
            return cached.get(container_name)

        proj_dirs = []
        try:
            for e in os.scandir(HOME):
                if e.is_dir() and not e.is_symlink() and not _is_hidden(e.name) \
                        and not is_ignored_name(e.name):
                    proj_dirs.append(e.name)
        except OSError:
            pass

        result = None
        low = container_name.lower()
        if container_name in proj_dirs:
            result = container_name
        if result is None:
            # 名称段前缀：容器名首段 == 项目名首段（maixu-gewe → maixu-robot）
            seg = low.split("-")[0] if "-" in low else ""
            if len(seg) >= 3:
                for d in proj_dirs:
                    if d.lower().split("-")[0] == seg:
                        result = d
                        break
        if result is None:
            # 前缀匹配：项目名是容器名的前缀（grok2api → 无；flutter-sdk → flutter）
            for d in proj_dirs:
                if len(d) >= 3 and low.startswith(d.lower()):
                    result = d
                    break
        if result is None:
            # 二级目录匹配：HOME/<项目>/<容器名>
            try:
                for e in os.scandir(HOME):
                    if not e.is_dir() or _is_hidden(e.name) or is_ignored_name(e.name):
                        continue
                    try:
                        with os.scandir(e.path) as sub:
                            for s in sub:
                                if s.is_dir() and s.name == container_name:
                                    result = e.name
                                    break
                    except OSError:
                        continue
                    if result:
                        break
            except OSError:
                pass
        if result is None:
            # 镜像关键词：gewe/weixin 镜像 → 微信协议桥
            img_low = (image or "").lower()
            if "gewe" in img_low or "weixin" in img_low:
                for d in proj_dirs:
                    if "wechat" in d.lower() or "weixin" in d.lower() \
                            or "protocol" in d.lower():
                        result = d
                        break
        cached[container_name] = result
        _container_proj_cache["ts"] = now
        return result


# ---------------------------------------------------------------- 进程快照
_proc_lock = threading.Lock()
_proc_cache = {"ts": 0.0, "procs": []}
_prev_cpu = {}  # pid -> (ticks, time)

# ---- 系统 CPU / 内存采样 ----
_sys_lock = threading.Lock()
_sys_cache = {"ts": 0.0, "cpu": 0.0, "mem": 0.0, "history": [], "uptime": 0.0,
              "loadavg": [0.0, 0.0, 0.0]}
_prev_stat = None  # (total, idle) 上次 /proc/stat 采样
HISTORY_CAP = 60


def _sample_sys():
    global _prev_stat
    now = time.time()
    # CPU：/proc/stat 差分
    cpu = _sys_cache["cpu"]
    try:
        for line in Path("/proc/stat").read_text().splitlines():
            if line.startswith("cpu "):
                vals = [int(x) for x in line.split()[1:8]]
                total = sum(vals)
                idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle + iowait
                break
        else:
            vals = None
        if vals is not None:
            if _prev_stat:
                dt = total - _prev_stat[0]
                di = idle - _prev_stat[1]
                if dt > 0:
                    cpu = max(0.0, min(100.0, (dt - di) / dt * 100.0))
            _prev_stat = (total, idle)
    except (OSError, ValueError):
        pass
    # 内存：/proc/meminfo
    mem = _sys_cache["mem"]
    try:
        info = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            parts = line.split(":")
            if len(parts) == 2:
                info[parts[0]] = float(parts[1].strip().split()[0]) * 1024
        if info.get("MemTotal"):
            used = info["MemTotal"] - info.get("MemAvailable", info["MemTotal"])
            mem = max(0.0, min(100.0, used / info["MemTotal"] * 100.0))
    except (OSError, ValueError):
        pass
    # 运行时长
    uptime = 0.0
    try:
        uptime = float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError):
        pass
    # 负载
    loadavg = _sys_cache["loadavg"]
    try:
        loadavg = [float(x) for x in Path("/proc/loadavg").read_text().split()[:3]]
    except (OSError, ValueError):
        pass
    with _sys_lock:
        h = _sys_cache["history"]
        h.append({"t": int(now), "cpu": round(cpu, 1), "mem": round(mem, 1)})
        if len(h) > HISTORY_CAP:
            del h[: len(h) - HISTORY_CAP]
        _sys_cache.update({"ts": now, "cpu": cpu, "mem": mem, "uptime": uptime,
                           "loadavg": loadavg})
    return _sys_cache


def _read_proc(path: str, binary=False):
    try:
        if binary:
            return Path(path).read_bytes()
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _proc_stat_parts(pid: int):
    """解析 /proc/pid/stat，返回 (comm, state, ppid, utime, stime, starttime)"""
    raw = _read_proc(f"/proc/{pid}/stat")
    if not raw:
        return None
    try:
        rp = raw.rfind(")")
        comm = raw[raw.find("(") + 1:rp]
        rest = raw[rp + 2:].split()
        # rest: state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt
        #       cmajflt utime stime cutime cstime ... starttime
        state = rest[0] if len(rest) > 0 else "?"
        ppid = int(rest[1]) if len(rest) > 1 else -1
        utime = int(rest[11]) if len(rest) > 11 else 0
        stime = int(rest[12]) if len(rest) > 12 else 0
        starttime = int(rest[19]) if len(rest) > 19 else 0
        return comm, state, ppid, utime, stime, starttime
    except (ValueError, IndexError):
        return None


def _cpu_usage(pid: int, ticks: int, now: float) -> float:
    prev = _prev_cpu.get(pid)
    _prev_cpu[pid] = (ticks, now)
    if not prev:
        return 0.0
    dt = now - prev[1]
    if dt <= 0:
        return 0.0
    return max(0.0, (ticks - prev[0]) / CLK_TCK / dt * 100.0 / NPROC)


def _boot_time():
    raw = _read_proc("/proc/stat")
    if not raw:
        return 0.0
    for line in raw.splitlines():
        if line.startswith("btime "):
            try:
                return float(line.split()[1])
            except ValueError:
                return 0.0
    return 0.0


def project_of_cwd(cwd: str):
    """把进程 cwd 归到某个项目（家目录第一层），返回项目名或 None。"""
    if not cwd:
        return None
    try:
        rel = Path(cwd).resolve().relative_to(HOME)
    except ValueError:
        return None
    if not rel.parts:
        return None
    top = rel.parts[0]
    if _is_hidden(top) or is_ignored_name(top):
        return None
    return top


def snapshot_processes(force=False):
    with _proc_lock:
        now = time.time()
        if not force and now - _proc_cache["ts"] < PROCESS_CACHE_TTL:
            return _proc_cache["procs"]
        _sample_sys()

        me = os.getuid()
        btime = _boot_time()
        dmap = docker_map()
        procs = []
        try:
            pids = [p for p in os.listdir("/proc") if p.isdigit()]
        except OSError:
            return []
        for pid_s in pids:
            pid = int(pid_s)
            try:
                status = _read_proc(f"/proc/{pid}/status")
                if not status:
                    continue
                uid_line = next((l for l in status.splitlines() if l.startswith("Uid:")), None)
                if uid_line is None:
                    continue
                uid = int(uid_line.split()[1])
                parts = _proc_stat_parts(pid)
                if not parts:
                    continue
                comm, state, ppid, utime, stime, starttime = parts

                cmdline = b""
                try:
                    cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").strip()
                except OSError:
                    pass
                cmd = cmdline.decode("utf-8", errors="replace")[:300] or comm

                try:
                    statm = Path(f"/proc/{pid}/statm").read_text().split()
                    rss = int(statm[1]) * PAGE_SIZE if len(statm) > 1 else 0
                except OSError:
                    rss = 0

                cwd = None
                try:
                    cwd = os.readlink(f"/proc/{pid}/cwd")
                except OSError:
                    pass

                started = btime + starttime / CLK_TCK if btime else 0.0
                container = dmap.get(pid)
                proj = project_of_cwd(cwd)
                if not proj and container:
                    proj = container_project_of(container["name"], container.get("image", ""))
                user = ""
                try:
                    user = pwd.getpwuid(uid).pw_name or ""
                except KeyError:
                    user = str(uid)
                procs.append({
                    "pid": pid,
                    "comm": comm[:40],
                    "cmd": cmd,
                    "ppid": ppid,
                    "state": state,
                    "cpu": _cpu_usage(pid, utime + stime, now),
                    "rss": rss,
                    "started": started,
                    "cwd": cwd,
                    "project": proj,
                    "uid": uid,
                    "user": user,
                    "is_me": uid == me,
                    "container": container["name"] if container else None,
                    "ports": container["ports"] if container else [],
                })
            except (OSError, ValueError):
                continue

        # 清理已退出进程的 CPU 采样
        live = {p["pid"] for p in procs}
        for pid in list(_prev_cpu):
            if pid not in live:
                del _prev_cpu[pid]

        procs.sort(key=lambda p: p["cpu"], reverse=True)
        _proc_cache["ts"] = now
        _proc_cache["procs"] = procs
        return procs


# ---------------------------------------------------------------- 目录树 / 文件预览
def _entry_info(root: Path, name: str):
    p = root / name
    try:
        st = p.stat()
    except OSError:
        return None
    return {
        "name": name,
        "path": str(p),
        "is_dir": p.is_dir() and not p.is_symlink(),
        "size": st.st_size if p.is_file() else 0,
        "mtime": st.st_mtime,
        "lock": lock_type_of(str(p)),   # hard | soft | none
    }


def list_dir(path_str: str, show_hidden=False):
    """列目录；show_hidden=True 时显示点开头隐藏项（忽略规则仅作用于非隐藏项）。"""
    p = Path(path_str).resolve()
    if not p.is_dir():
        return None
    dirs, files = [], []
    try:
        with os.scandir(p) as it:
            for e in it:
                try:
                    if e.is_symlink():
                        continue
                    if _is_hidden(e.name):
                        if not show_hidden:
                            continue
                    elif is_ignored_name(e.name):
                        continue
                    info = _entry_info(p, e.name)
                    if info:
                        (dirs if info["is_dir"] else files).append(info)
                except OSError:
                    continue
    except OSError:
        return None
    dirs.sort(key=lambda x: x["name"].lower())
    files.sort(key=lambda x: x["name"].lower())
    parent = str(p.parent) if p != HOME else None
    return {"path": str(p), "name": p.name, "parent": parent, "dirs": dirs, "files": files}


IMAGE_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
)


def sniff_image(head: bytes) -> str:
    """按魔数识别图片类型；返回 mime 或空串。"""
    for magic, mime in IMAGE_MAGIC:
        if head.startswith(magic):
            return mime
    if head.startswith(b"RIFF") and len(head) >= 12 and head[8:12] == b"WEBP":
        return "image/webp"
    return ""


def read_file_preview(path_str: str):
    p = Path(path_str).resolve()
    if not p.is_file():
        return None
    try:
        st = p.stat()
    except OSError:
        return None
    if st.st_size > MAX_FILE_PREVIEW:
        truncated = True
        size = MAX_FILE_PREVIEW
    else:
        truncated = False
        size = st.st_size
    try:
        with open(p, "rb") as f:
            head = f.read(min(size, 8192))
            f.seek(0)
            data = f.read(size)
    except OSError:
        return None
    # 图片：按魔数识别，返回 mime 供前端渲染
    mime = sniff_image(head)
    if mime:
        return {"image": True, "mime": mime, "size": st.st_size, "path": str(p)}
    binary = b"\x00" in head
    if binary:
        return {"binary": True, "size": st.st_size}
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return {"binary": True, "size": st.st_size}
    # SVG：文本格式但可作图片渲染
    stripped = text.lstrip()[:256].lower()
    if stripped.startswith("<svg") or "<svg" in stripped:
        return {"image": True, "mime": "image/svg+xml", "size": st.st_size, "path": str(p)}
    return {"binary": False, "content": text, "truncated": truncated, "size": st.st_size,
            "path": str(p)}


# ---------------------------------------------------------------- 文件管理：三态锁 / 回收站 / 上传下载

# 硬锁清单：影响 WSL/指挥中心运转的关键项（无解锁按钮，不可删除/覆盖）
HARD_LOCKED_HOME_ENTRIES = {
    ".bashrc", ".bash_profile", ".profile", ".bash_logout", ".ssh",
}

TRASH_DIR = CONFIG_DIR / "trash"
TRASH_FILES_DIR = TRASH_DIR / "files"
TRASH_INDEX_PATH = TRASH_DIR / "index.json"


def is_hard_locked(p: Path) -> bool:
    """硬锁判定：家目录本身 / 家目录外 / 登录环境与密钥 / 指挥中心自身与配置。"""
    s = str(p)
    if s == str(HOME):
        return True                    # 家目录本身（删了就什么都没了）
    if not s.startswith(str(HOME) + "/"):
        return True                    # 家目录外（含系统目录）
    try:
        rel = p.relative_to(HOME)
    except ValueError:
        return True
    if rel.parts and rel.parts[0] in HARD_LOCKED_HOME_ENTRIES:
        return True                    # ~/.bashrc ~/.profile ~/.ssh 等
    bs = str(BASE_DIR)
    if s == bs or s.startswith(bs + "/"):
        return True                    # wsl-command 自身
    cs = str(CONFIG_DIR)
    if s == cs or s.startswith(cs + "/"):
        return True                    # 指挥中心配置与回收站（影响运行）
    return False


def is_soft_locked(path_str: str) -> bool:
    """软锁：用户手动锁定的路径或其父目录被锁（锁目录 = 锁整个子树）。"""
    locked = _config.get("locked_paths", [])
    if not locked:
        return False
    s = str(path_str)
    for lp in locked:
        if s == lp or s.startswith(lp.rstrip("/") + "/"):
            return True
    return False


def lock_type_of(path_str: str) -> str:
    """'hard' | 'soft' | 'none'"""
    try:
        p = Path(path_str).resolve()
    except OSError:
        return "none"
    if is_hard_locked(p):
        return "hard"
    if is_soft_locked(str(p)):
        return "soft"
    return "none"


def sanitize_filename(name: str) -> str:
    """文件名净化：强制 basename、剥路径分隔符与空字符。"""
    n = os.path.basename(str(name).replace("\\", "/")).strip()
    n = n.replace("/", "_").replace("\x00", "")
    if n in ("", ".", ".."):
        return ""
    return n[:200]


def _stat_tree(p: Path):
    """统计目录：返回 (文件数, 字节数)。"""
    files, total = 0, 0
    try:
        for root, dirs, fs in os.walk(p):
            dirs[:] = [d for d in dirs if not (Path(root) / d).is_symlink()]
            for f in fs:
                try:
                    total += (Path(root) / f).stat().st_size
                    files += 1
                except OSError:
                    pass
    except OSError:
        pass
    return files, total


def _trash_index() -> dict:
    try:
        return json.loads(TRASH_INDEX_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _trash_index_save(idx: dict):
    try:
        TRASH_DIR.mkdir(parents=True, exist_ok=True)
        _atomic_write(TRASH_INDEX_PATH, json.dumps(idx, ensure_ascii=False, indent=2))
    except OSError as e:
        log("回收站索引保存失败: %s" % e)


def trash_list():
    """回收站条目列表（新删除在前）。"""
    idx = _trash_index()
    items = []
    for name, e in idx.items():
        exists = (TRASH_FILES_DIR / name).exists()
        items.append({**e, "trash_name": name, "exists": exists})
    items.sort(key=lambda x: x.get("deleted_at", 0), reverse=True)
    return items


def trash_move(p: Path):
    """把文件/目录移入回收站，返回 (ok, 索引条目或错误)。"""
    try:
        TRASH_FILES_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return False, {"error": "回收站不可用: %s" % e}
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = TRASH_FILES_DIR / (stamp + "_" + p.name)
    i = 1
    while dest.exists():
        dest = TRASH_FILES_DIR / ("%s_%d_%s" % (stamp, i, p.name))
        i += 1
    is_dir = p.is_dir() and not p.is_symlink()
    files, size = (0, p.stat().st_size) if not is_dir else _stat_tree(p)
    try:
        shutil.move(str(p), str(dest))
    except OSError as e:
        return False, {"error": "移入回收站失败: %s" % e}
    entry = {"trash_name": dest.name, "orig_path": str(p), "is_dir": is_dir,
             "deleted_at": time.time(), "files": files, "size": size}
    idx = _trash_index()
    idx[dest.name] = entry
    _trash_index_save(idx)
    log("移入回收站 %s -> %s" % (p, dest.name))
    return True, entry


def trash_restore(trash_name: str):
    """从回收站还原。"""
    if not re.fullmatch(r"[0-9]{8}_[0-9]{6}(?:_\d+)?_.+", trash_name or ""):
        return False, {"error": "非法回收站条目名"}
    idx = _trash_index()
    entry = idx.get(trash_name)
    src = TRASH_FILES_DIR / trash_name
    if not entry or not src.exists():
        return False, {"error": "条目不存在"}
    dest = Path(entry.get("orig_path", ""))
    if not str(dest).startswith(str(HOME) + "/") and str(dest) != str(HOME):
        dest = HOME / trash_name.split("_", 2)[-1]     # 原路径已越界则退回家目录
    if not dest.parent.exists():
        dest = HOME / trash_name.split("_", 2)[-1]
    base = dest
    i = 1
    while dest.exists():
        dest = Path(str(base) + ".restored" + (str(i) if i > 1 else ""))
        i += 1
    try:
        shutil.move(str(src), str(dest))
    except OSError as e:
        return False, {"error": "还原失败: %s" % e}
    idx.pop(trash_name, None)
    _trash_index_save(idx)
    log("回收站还原 %s -> %s" % (trash_name, dest))
    return True, {"restored_to": str(dest)}


def trash_empty():
    """清空回收站（彻底释放磁盘）。"""
    try:
        shutil.rmtree(TRASH_FILES_DIR, ignore_errors=True)
        TRASH_FILES_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return False, {"error": "清空失败: %s" % e}
    _trash_index_save({})
    log("回收站已清空")
    return True, {}


def delete_paths(paths, permanent=False):
    """删除一批路径；permanent=False 进回收站，True 彻底删。返回 (ok, info)。"""
    ok_all, removed, trashed, errors = True, 0, 0, []
    for raw in paths:
        p = Path(raw).resolve()
        if not p.exists():
            continue
        if is_hard_locked(p):
            ok_all = False
            errors.append("%s: 系统保护" % p.name)
            continue
        if is_soft_locked(str(p)):
            ok_all = False
            errors.append("%s: 已锁定" % p.name)
            continue
        if permanent:
            try:
                if p.is_dir() and not p.is_symlink():
                    shutil.rmtree(p)
                else:
                    p.unlink()
                removed += 1
                log("彻底删除 %s" % p)
            except OSError as e:
                ok_all = False
                errors.append("%s: %s" % (p.name, e))
        else:
            ok, info = trash_move(p)
            if ok:
                trashed += 1
            else:
                ok_all = False
                errors.append((info or {}).get("error", "失败"))
    return ok_all, {"removed": removed, "trashed": trashed, "errors": errors}


# ---------------------------------------------------------------- 受控进程（启动/暂停）
_controlled_lock = threading.Lock()
_controlled = {}   # path -> {token, pid, pgid, cmd, started_at}
_proc_ctrl_lock = threading.Lock()
_proc_controlled = {}   # proc_key -> {token, pid, pgid, cmd, cwd, started_at}（详情页单进程受控记录）
_history_last_save = 0.0


def _pid_alive(pid):
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def detect_start_cmd(path: str) -> str:
    """从项目标志文件自动推断启动命令（无则返回空串）。
    优先级：包脚本 → 一键脚本 → 框架入口 → 常见 Python/Node 入口。"""
    p = Path(path)
    try:
        # 包管理器脚本（npm/yarn 项目的标准启动方式）
        if (p / "package.json").exists():
            try:
                pkg = json.loads((p / "package.json").read_text(encoding="utf-8", errors="replace"))
            except (ValueError, OSError):
                pkg = None
            if isinstance(pkg, dict) and isinstance(pkg.get("scripts"), dict):
                if pkg["scripts"].get("start"):
                    return "npm start"
                if pkg["scripts"].get("dev"):
                    return "npm run dev"
        # 一键启动脚本（项目自带 start.sh/run.sh 时最贴合实际用法）
        for s in ("start.sh", "run.sh"):
            if (p / s).exists():
                return "bash " + s
        # 框架入口
        if (p / "manage.py").exists():
            return "python3 manage.py runserver"
        if (p / "Cargo.toml").exists():
            return "cargo run"
        if (p / "go.mod").exists():
            return "go run ."
        if (p / "Makefile").exists():
            return "make run"
        if (p / "docker-compose.yml").exists() or (p / "docker-compose.yaml").exists():
            return "docker compose up -d"
        # 常见 Python 入口
        for f in ("main.py", "app.py", "run.py", "bot.py", "index.py"):
            if (p / f).exists():
                return "python3 " + f
        # 常见 Node 入口
        for f in ("server.js", "app.js"):
            if (p / f).exists():
                return "node " + f
    except OSError:
        pass
    return ""


def launch_env():
    """补齐常用运行时的 PATH（shell 启动可能读不到 .bashrc）。"""
    env = dict(os.environ)
    extra = [env.get("PATH", "")]
    for base in (Path.home() / ".nvm/versions/node"), Path.home() / ".local/bin", \
            Path("/usr/local/go/bin"), Path.home() / ".cargo/bin":
        if base.is_dir():
            extra.append(str(base))
        v = base / "bin"
        if v.is_dir():
            extra.append(str(v))
    env["PATH"] = ":".join(x for x in extra if x)
    return env


def project_log_path(path: str) -> Path:
    return LOG_DIR / ("proj_" + Path(path).name + ".log")


def start_project(path: str):
    """启动项目配置的启动命令；返回 (ok, info)。"""
    if not _home_path_ok(path):
        return False, {"error": "非法路径"}
    with _controlled_lock:
        rec = _controlled.get(path)
        if rec and _pid_alive(rec["pid"]):
            return True, {"already": True, "pid": rec["pid"], "cmd": rec["cmd"]}
    labels = _config.get("labels", {}).get(path, {})
    cmd = (labels.get("cmd") or "").strip() or detect_start_cmd(path)
    if not cmd:
        # 兜底：该项目关联的 Docker 容器（已停止的）→ docker start
        containers = [c for c in docker_list()
                      if c["project"] == Path(path).name and not c["running"]]
        if containers:
            names = [c["name"] for c in containers]
            ok_all = True
            for cname in names:
                try:
                    r = subprocess.run(["docker", "start", cname],
                                       capture_output=True, text=True, timeout=30)
                    if r.returncode != 0:
                        ok_all = False
                except (OSError, subprocess.TimeoutExpired):
                    ok_all = False
            with _docker_lock:
                _docker_list_cache["ts"] = 0
                _docker_cache["ts"] = 0
            if ok_all:
                log("容器启动 %s" % names)
                return True, {"docker": names}
            return False, {"error": "容器启动失败，请检查 Docker 状态"}
        return False, {"error": "该项目没有可用的启动命令，请先在标注中填写"}
    logf = project_log_path(path)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(logf, "ab") as f:
            f.write(("\n===== %s 启动: %s =====\n" % (
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"), cmd)).encode())
        stdout = open(logf, "ab")
        proc = subprocess.Popen(
            cmd, shell=True, cwd=path,
            stdout=stdout, stderr=subprocess.STDOUT,
            start_new_session=True,   # 新进程组，便于整体停止
            env=launch_env(),
        )
    except OSError as e:
        return False, {"error": "启动失败: %s" % e}
    rec = {"token": uuid.uuid4().hex, "pid": proc.pid, "pgid": proc.pid,
           "cmd": cmd, "started_at": time.time()}
    try:
        with _controlled_lock:
            _controlled[path] = rec
    except Exception:
        # 记录失败时立即杀掉刚启动的进程组，避免遗留孤儿
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        raise
    log("受控启动 %s: %s (pid=%d)" % (Path(path).name, cmd, proc.pid))
    return True, {"pid": proc.pid, "cmd": cmd}


def stop_project(path: str):
    """停止该项目的受控进程组（只动控制台启动的进程）。"""
    if not _home_path_ok(path):
        return False, {"error": "非法路径"}
    with _controlled_lock:
        rec = _controlled.get(path)
        if not rec:
            return True, {"already": True}
        if not _pid_alive(rec["pid"]):
            _controlled.pop(path, None)
            return True, {"already": True}
        pgid = rec["pgid"]
        token = rec["token"]
        _controlled.pop(path, None)
    log("停止受控进程 %s (pgid=%d)" % (Path(path).name, pgid))
    try:
        os.killpg(pgid, signal.SIGTERM)
    except OSError:
        pass
    # 等待最多 3 秒，仍存活则升级为 SIGKILL
    for _ in range(6):
        alive = False
        try:
            os.killpg(pgid, 0)
            alive = True
        except OSError:
            alive = False
        if not alive:
            break
        time.sleep(0.5)
    if alive:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except OSError:
            pass
    logf = project_log_path(path)
    try:
        with open(logf, "ab") as f:
            f.write(("\n===== %s 已停止 =====\n" % datetime.now().strftime("%Y-%m-%d %H:%M:%S")).encode())
    except OSError:
        pass
    return True, {}


def stop_project_all(path: str):
    """停止项目下所有进程（含外部启动的），排除指挥中心自身进程组。
    返回 (ok, info)。"""
    if not _home_path_ok(path):
        return False, {"error": "非法路径"}
    proj_name = Path(path).name
    procs = snapshot_processes(force=True)
    # 排除指挥中心自身进程；其余全部为目标（含外部启动的）
    targets = [p for p in procs
               if p.get("project") == proj_name and p["pid"] != os.getpid()]
    if not targets:
        with _controlled_lock:
            _controlled.pop(path, None)
        return True, {"already": True, "stopped": 0}
    pids = [p["pid"] for p in targets]
    # Docker 容器进程：用 docker stop 优雅停止（kill root 进程权限不足）
    containers = sorted({p.get("container") for p in targets if p.get("container")})
    for cname in containers:
        log("停止容器 %s" % cname)
        try:
            subprocess.run(["docker", "stop", "--time", "5", cname],
                           capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            pass
    log("停止项目全部进程 %s: %s" % (proj_name, pids))
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    # 等待最多 3 秒，仍存活则 SIGKILL
    for _ in range(6):
        alive = [pid for pid in pids if _pid_alive(pid)]
        if not alive:
            break
        time.sleep(0.5)
    for pid in alive:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    with _controlled_lock:
        _controlled.pop(path, None)
    logf = project_log_path(path)
    try:
        with open(logf, "ab") as f:
            f.write(("\n===== %s 全部进程已停止 (%d) =====\n" % (
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"), len(pids))).encode())
    except OSError:
        pass
    return True, {"stopped": len(pids)}


def cleanup_controlled():
    """清理已退出的受控记录（状态构建时调用）。"""
    with _controlled_lock:
        for path, rec in list(_controlled.items()):
            if not _pid_alive(rec["pid"]):
                _controlled.pop(path, None)


def controlled_pids():
    """当前受控 pid 集合。"""
    with _controlled_lock:
        return {rec["pid"] for rec in _controlled.values()}


# ---------------------------------------------------------------- 进程详情：描述引擎 / 历史 / 单进程启停

def _proc_key(path: str, cmd: str) -> str:
    """进程身份键 = sha1(项目路径 + 命令行)，跨 pid 稳定。"""
    return hashlib.sha1((path + "\n" + cmd).encode("utf-8", errors="replace")).hexdigest()[:16]


def cleanup_proc_controlled():
    """清理已退出的单进程受控记录。"""
    with _proc_ctrl_lock:
        for k, rec in list(_proc_controlled.items()):
            if not _pid_alive(rec["pid"]):
                _proc_controlled.pop(k, None)


# ① 常见服务/工具词典：comm 或命令首词 -> (中文描述, 英文描述)
PROC_DICT = {
    "nginx": ("Web 反向代理", "Web reverse proxy"),
    "caddy": ("Web 服务器", "Web server"),
    "apache2": ("Web 服务器", "Web server"),
    "httpd": ("Web 服务器", "Web server"),
    "redis-server": ("Redis 缓存数据库", "Redis cache database"),
    "mysqld": ("MySQL 数据库", "MySQL database"),
    "mariadbd": ("MariaDB 数据库", "MariaDB database"),
    "postgres": ("PostgreSQL 数据库", "PostgreSQL database"),
    "mongod": ("MongoDB 数据库", "MongoDB database"),
    "clickhouse-server": ("ClickHouse 数据库", "ClickHouse database"),
    "etcd": ("etcd 配置存储", "etcd config store"),
    "rabbitmq-server": ("RabbitMQ 消息队列", "RabbitMQ message queue"),
    "gunicorn": ("Python Web 应用服务", "Python web app server"),
    "uwsgi": ("Python Web 应用服务", "Python web app server"),
    "uvicorn": ("Python ASGI 服务", "Python ASGI server"),
    "celery": ("Celery 异步任务", "Celery task worker"),
    "dockerd": ("Docker 守护进程", "Docker daemon"),
    "containerd": ("容器运行时", "Container runtime"),
    "docker-proxy": ("Docker 端口转发", "Docker port forwarder"),
    "containerd-shim-runc-v2": ("容器 shim", "Container shim"),
    "sshd": ("SSH 服务", "SSH server"),
    "systemd": ("系统服务管理器", "System service manager"),
    "systemd-journald": ("系统日志服务", "System journal logger"),
    "wslhost": ("WSL 宿主服务", "WSL host service"),
    "init": ("系统初始化进程", "System init process"),
    "bash": ("Shell 终端", "Shell terminal"),
    "sh": ("Shell 终端", "Shell terminal"),
    "zsh": ("Shell 终端", "Shell terminal"),
    "fish": ("Shell 终端", "Shell terminal"),
    "node": ("Node.js 运行时", "Node.js runtime"),
    "npm": ("npm 包管理器", "npm package manager"),
    "pnpm": ("pnpm 包管理器", "pnpm package manager"),
    "yarn": ("yarn 包管理器", "yarn package manager"),
    "bun": ("bun 运行时", "bun runtime"),
    "java": ("Java 运行时", "Java runtime"),
    "cargo": ("Rust 构建/运行", "Rust build/run"),
    "rustc": ("Rust 编译器", "Rust compiler"),
    "go": ("Go 工具链", "Go toolchain"),
    "make": ("Make 构建", "Make build tool"),
    "git": ("Git 版本控制", "Git version control"),
    "docker": ("Docker 命令行", "Docker CLI"),
    "code": ("VS Code 编辑器", "VS Code editor"),
    "python": ("Python 解释器", "Python interpreter"),
    "pip": ("pip 包管理器", "pip package manager"),
    "ping": ("网络连通性测试", "Network ping tool"),
    "curl": ("HTTP 请求工具", "HTTP request tool"),
    "wget": ("下载工具", "Download tool"),
    "ssh": ("SSH 客户端", "SSH client"),
    "scp": ("SCP 传输工具", "SCP transfer tool"),
    "rsync": ("rsync 同步工具", "rsync sync tool"),
    "tar": ("打包工具", "Archive tool"),
    "v2ray": ("代理服务", "Proxy service"),
    "xray": ("代理服务", "Proxy service"),
    "frpc": ("内网穿透客户端", "Tunnel client (frp)"),
    "frps": ("内网穿透服务端", "Tunnel server (frp)"),
    "cloudflared": ("Cloudflare 隧道", "Cloudflare tunnel"),
    "tailscaled": ("Tailscale 组网", "Tailscale VPN"),
    # 浏览器与桌面应用
    "chrome": ("Chrome 浏览器", "Chrome browser"),
    "chromium": ("Chromium 浏览器", "Chromium browser"),
    "chromium-browse": ("Chromium 浏览器", "Chromium browser"),
    "firefox": ("Firefox 浏览器", "Firefox browser"),
    "msedge": ("Edge 浏览器", "Edge browser"),
    "chrome_crashpad": ("Chrome 崩溃报告器", "Chrome crash reporter"),
    "crashpad_handle": ("崩溃报告器", "Crash reporter"),
    "electron": ("Electron 桌面应用", "Electron desktop app"),
    "agent-browser": ("浏览器自动化工具", "Browser automation tool"),
    "code": ("VS Code 编辑器", "VS Code editor"),
    # 常用终端工具
    "htop": ("系统监控面板", "System monitor"),
    "btop": ("系统监控面板", "System monitor"),
    "vim": ("文本编辑器", "Text editor"),
    "nvim": ("Neovim 编辑器", "Neovim editor"),
    "nano": ("文本编辑器", "Text editor"),
    "redis-cli": ("Redis 命令行客户端", "Redis CLI client"),
    "mysql": ("MySQL 命令行客户端", "MySQL CLI client"),
    "psql": ("PostgreSQL 客户端", "PostgreSQL client"),
    "sqlite3": ("SQLite 数据库工具", "SQLite database tool"),
    "jupyter": ("Jupyter 笔记本", "Jupyter notebook"),
    "streamlit": ("Streamlit Web 应用", "Streamlit web app"),
    "uvx": ("Python 工具运行器", "Python tool runner (uv)"),
    "pip3": ("pip 包管理器", "pip package manager"),
}

# ①b 前缀兜底：进程名带版本/平台后缀变体时（如 agent-browser-linux）也能命中
PROC_PREFIX_DICT = [
    ("agent-browser", ("浏览器自动化工具", "Browser automation tool")),
    ("code-wrapper", ("VS Code 编辑器", "VS Code editor")),
]

# ② 运行时 -> 描述模板（对 cmd 第二个词做脚本名解析）
RUNTIME_DICT = {
    "python": ("Python 脚本 · {arg}", "Python script · {arg}"),
    "python3": ("Python 脚本 · {arg}", "Python script · {arg}"),
    "node": ("Node.js 程序 · {arg}", "Node.js program · {arg}"),
    "deno": ("Deno 程序 · {arg}", "Deno program · {arg}"),
    "bash": ("Shell 脚本 · {arg}", "Shell script · {arg}"),
    "sh": ("Shell 脚本 · {arg}", "Shell script · {arg}"),
    "java": ("Java 程序 · {arg}", "Java program · {arg}"),
}


# Shell 家族（-c 后首词即命令本体）
SHELL_NAMES = {"bash", "sh", "zsh", "dash", "ksh"}


def describe_process(p):
    """三层规则引擎：词典 -> 运行时解析 -> 容器特征。返回 (zh, en)。全自动零配置。"""
    comm = (p.get("comm") or "").strip().lower()
    cmd = (p.get("cmd") or "").strip()
    parts = cmd.split() if cmd else []
    first = parts[0].rstrip(" :").split("/")[-1].lower() if parts else ""
    if first.endswith(":"):
        first = first[:-1]
    is_shell = first in SHELL_NAMES or comm in SHELL_NAMES

    # ① 词典（先查完整 comm，再查命令首词）
    for cand in (comm, first):
        if cand and cand in PROC_DICT:
            arg = _runtime_arg(parts, is_shell)
            if cand in RUNTIME_DICT and arg:
                tzh, ten = RUNTIME_DICT[cand]
                return tzh.format(arg=arg), ten.format(arg=arg)
            zh, en = PROC_DICT[cand]
            return zh, en

    # ①b 前缀兜底
    for cand in (comm, first):
        if not cand:
            continue
        for pref, val in PROC_PREFIX_DICT:
            if cand.startswith(pref):
                return val

    # ② 运行时 + 入口解析
    if first in RUNTIME_DICT:
        arg = _runtime_arg(parts, is_shell)
        if arg:
            tzh, ten = RUNTIME_DICT[first]
            return tzh.format(arg=arg), ten.format(arg=arg)
        tzh, ten = PROC_DICT.get(first, RUNTIME_DICT[first])
        return tzh, ten
    if first in ("npm", "pnpm", "yarn"):
        sub = parts[1] if len(parts) > 1 else ""
        if sub == "run" and len(parts) > 2:
            sub = parts[2]
        label = (first + " " + sub).strip()
        return f"Node.js 服务 · {label}", f"Node.js service · {label}"

    # ③ 容器特征
    container = p.get("container")
    if container:
        return f"容器进程 · {container}", f"Container process · {container}"

    # 兜底：未知
    return "", ""


def _runtime_arg(parts, is_shell=False):
    """从命令行参数中提取入口文件名。
    shell -c 形式：取 -c 后首词作命令本体；
    python/node 的 -c 是内联代码串，跳过继续找真正的文件参数。"""
    if is_shell and len(parts) > 2 and parts[1] == "-c":
        base = parts[2].rstrip("/").split("/")[-1]
        return base or None
    skip_val = False
    for a in parts[1:]:
        if skip_val:
            skip_val = False
            continue
        if a == "-c":          # 内联代码串，不是入口名
            skip_val = True
            continue
        if a.startswith("-"):
            continue
        base = a.rstrip("/").split("/")[-1]
        return base or None
    return None


_SHELL_WRAP_RE = re.compile(r"^(?:/usr/bin/|/bin/)?(?:ba|z|da|k)?sh\s+-c\s+(.+)$", re.S)


def _strip_shell_wrap(cmd):
    """剥掉 wrapper：/proc 抓到的 'bash -c xxx' 展平串失去引号边界，
    直接重放会改变语义（如 sh -c sleep 300 → sleep 丢失参数）。剥壳后取真实命令串。"""
    m = _SHELL_WRAP_RE.match((cmd or "").strip())
    if m:
        return m.group(1).strip()
    return (cmd or "").strip()


def _upsert_process_history(path_str, procs, ctrl_origin=None):
    """把该项目当前活进程合并进历史（config.process_history），变化时节流写盘。
    规则：活着的保留；曾存活 ≥5s 的长驻进程永久留档；
    短命且已退出超过 60s 的噪音条目自动清除。
    ctrl_origin: {pid: 原始命令}，受控启动的进程记录原始命令供复活使用。"""
    global _history_last_save
    try:
        with _config_lock:
            hist = _config.setdefault("process_history", {})
            entries = hist.setdefault(path_str, [])
            now = time.time()
            changed = False
            by_key = {}
            for e in entries:
                if isinstance(e, dict):
                    by_key[e["key"]] = e
            live_keys = set()
            ctrl_origin = ctrl_origin or {}
            for p in procs:
                cmd = (p.get("cmd") or "").strip()
                if not cmd:
                    continue
                k = _proc_key(path_str, cmd)
                live_keys.add(k)
                e = by_key.get(k)
                if e is None:
                    e = {"key": k, "comm": p.get("comm", ""), "cmd": cmd,
                         "cwd": p.get("cwd") or path_str,
                         "first_seen": now, "last_seen": now}
                    entries.append(e)
                    by_key[k] = e
                    changed = True
                elif now - e.get("last_seen", 0) > 60:
                    e["last_seen"] = now
                    changed = True
                if p.get("cwd") and not e.get("cwd"):
                    e["cwd"] = p["cwd"]
                    changed = True
                oc = ctrl_origin.get(p.get("pid"))
                if oc and e.get("origin_cmd") != oc:
                    e["origin_cmd"] = oc
                    changed = True
            # 噪音清理：非活趧 + 短命（<5s）+ 已死超 60s → 移除
            kept = []
            for e in entries:
                if not isinstance(e, dict):
                    continue
                if e["key"] in live_keys:
                    kept.append(e)
                    continue
                lifespan = e.get("last_seen", 0) - e.get("first_seen", 0)
                gone_for = now - e.get("last_seen", 0)
                if lifespan >= 5 or gone_for <= 60:
                    kept.append(e)
                else:
                    changed = True
            if len(kept) != len(entries):
                entries[:] = kept
            # 每项目最多保留 20 条（按 last_seen 新者优先）
            if len(entries) > 20:
                entries[:] = sorted(entries, key=lambda x: x.get("last_seen", 0), reverse=True)[:20]
                changed = True
        if changed and time.time() - _history_last_save > 5:
            _history_last_save = time.time()
            save_config()
    except Exception as e:
        log("进程历史维护失败: %s" % e)


def project_detail_payload(path_str):
    """项目详情页数据：项目信息 + 活进程（含描述/备注/父子关系）+ 已停止历史。"""
    projs = {p["path"]: p for p in build_projects()[0]}
    pj = projs.get(path_str)
    proj_name = Path(path_str).name
    procs = snapshot_processes(force=True)
    mine = [p for p in procs if p.get("project") == proj_name]
    # 受控 pid -> 原始命令（供历史条目记录 origin_cmd，复活时不失真）
    with _controlled_lock:
        main_ctrl_pid = (_controlled.get(path_str) or {}).get("pid")
        main_ctrl_cmd = (_controlled.get(path_str) or {}).get("cmd")
    ctrl_origin = {}
    if main_ctrl_pid and main_ctrl_cmd:
        ctrl_origin[main_ctrl_pid] = main_ctrl_cmd
    with _proc_ctrl_lock:
        for rec in _proc_controlled.values():
            if rec.get("pid") and rec.get("cmd"):
                ctrl_origin[rec["pid"]] = rec["cmd"]
    _upsert_process_history(path_str, mine, ctrl_origin)
    cleanup_proc_controlled()
    notes = _config.get("process_notes", {})
    hist = _config.get("process_history", {}).get(path_str, [])
    live_keys, out_live, pmap = set(), [], {}
    for p in mine:
        cmd = (p.get("cmd") or "").strip() or p.get("comm", "")
        k = _proc_key(path_str, cmd)
        live_keys.add(k)
        dzh, den = describe_process(p)
        with _proc_ctrl_lock:
            rec = _proc_controlled.get(k)
        managed = bool(rec and _pid_alive(rec["pid"])) or p["pid"] == main_ctrl_pid
        d = {kk: p.get(kk) for kk in ("pid", "ppid", "comm", "state", "cpu",
                                      "rss", "started", "cwd", "user",
                                      "container", "ports")}
        d.update({"cmd": cmd, "key": k, "alive": True,
                  "desc_zh": dzh, "desc_en": den,
                  "note": (notes.get(k) or {}).get("note", ""),
                  "managed": managed})
        out_live.append(d)
        pmap[p["pid"]] = d
    # 父子关系标注（父进程也在本项目列表内时）
    for d in out_live:
        par = pmap.get(d["ppid"])
        if par is not None:
            d["parent_pid"] = par["pid"]
            d["parent_comm"] = par["comm"]
    out_live.sort(key=lambda x: (-x["cpu"], x["pid"]))
    # 历史（已停止）：不在活集合里的才显示，最多 20 条
    out_hist = []
    for e in sorted(hist, key=lambda x: x.get("last_seen", 0), reverse=True)[:20]:
        if not isinstance(e, dict) or e.get("key") in live_keys:
            continue
        dzh, den = describe_process({"comm": e.get("comm", ""), "cmd": e.get("cmd", "")})
        out_hist.append({"key": e["key"], "comm": e.get("comm", ""),
                         "cmd": e.get("cmd", ""), "cwd": e.get("cwd") or "",
                         "last_seen": e.get("last_seen", 0), "alive": False,
                         "cpu": 0, "rss": 0, "pid": None, "ppid": None,
                         "started": None, "user": "", "container": None, "ports": [],
                         "desc_zh": dzh, "desc_en": den,
                         "note": (notes.get(e["key"]) or {}).get("note", ""),
                         "managed": False})
    return {"project": pj, "procs": out_live, "history": out_hist, "ts": time.time()}


def stop_process(path_str, pid):
    """停止单个进程及其子进程树（限本项目内），SIGTERM 优雅退出后升级 SIGKILL。"""
    proj_name = Path(path_str).name
    procs = snapshot_processes(force=True)
    targets_map = {p["pid"]: p for p in procs if p.get("project") == proj_name}
    if pid not in targets_map:
        return False, {"error": "该进程不属于此项目或已退出"}
    root = targets_map[pid]
    children = {pid}
    changed = True
    while changed:
        changed = False
        for p_pid, pp in targets_map.items():
            if pp["ppid"] in children and p_pid not in children:
                children.add(p_pid)
                changed = True
    pids = sorted(children)
    containers = sorted({targets_map[x].get("container") for x in pids
                         if targets_map[x].get("container")} - {None})
    for cname in containers:
        log("停止容器 %s" % cname)
        try:
            subprocess.run(["docker", "stop", "--time", "5", cname],
                           capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            pass
    log("停止单进程 %s 树: %s" % (proj_name, pids))
    for x in pids:
        try:
            os.kill(x, signal.SIGTERM)
        except OSError:
            pass
    alive = pids
    for _ in range(6):
        alive = [x for x in alive if _pid_alive(x)]
        if not alive:
            break
        time.sleep(0.5)
    for x in alive:
        try:
            os.kill(x, signal.SIGKILL)
        except OSError:
            pass
    with _proc_ctrl_lock:
        _proc_controlled.pop(_proc_key(path_str, (root.get("cmd") or "").strip()), None)
    return True, {"stopped": len(pids), "pids": pids}


def start_process(path_str, key):
    """按历史记录原样复活一个进程（受控启动，日志进项目日志）。"""
    if not _home_path_ok(path_str):
        return False, {"error": "非法路径"}
    hist = _config.get("process_history", {}).get(path_str, [])
    entry = next((e for e in hist if isinstance(e, dict) and e.get("key") == key), None)
    if not entry:
        return False, {"error": "找不到该进程的历史记录"}
    # 优先用受控时记录的原始命令；否则对 /proc 展平串剥壳还原
    cmd = (entry.get("origin_cmd") or _strip_shell_wrap(entry.get("cmd")) or "").strip()
    if not cmd:
        return False, {"error": "历史记录缺少启动命令"}
    with _proc_ctrl_lock:
        rec = _proc_controlled.get(key)
        if rec and _pid_alive(rec["pid"]):
            return True, {"already": True, "pid": rec["pid"]}
    cwd = entry.get("cwd") or path_str
    if not os.path.isdir(cwd):
        cwd = path_str
    logf = project_log_path(path_str)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(logf, "ab") as f:
            f.write(("\n===== %s 启动单进程: %s =====\n" % (
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"), cmd)).encode())
        stdout = open(logf, "ab")
        proc = subprocess.Popen(cmd, shell=True, cwd=cwd,
                                stdout=stdout, stderr=subprocess.STDOUT,
                                start_new_session=True, env=launch_env())
    except OSError as e:
        return False, {"error": "启动失败: %s" % e}
    rec = {"token": uuid.uuid4().hex, "pid": proc.pid, "pgid": proc.pid,
           "cmd": cmd, "cwd": cwd, "started_at": time.time()}
    try:
        with _proc_ctrl_lock:
            _proc_controlled[key] = rec
    except Exception:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        raise
    log("受控启动单进程 %s: %s (pid=%d)" % (Path(path_str).name, cmd, proc.pid))
    return True, {"pid": proc.pid, "cmd": cmd}


# ---------------------------------------------------------------- 状态组装
THEMES = [{"id": "wsl", "name": "WSL 指挥台", "author": "wsl-command",
           "desc": "深空蓝黑 · 左侧导航轨 · KPI 图标卡 · 迷你负载条 · 实时动态侧栏",
           "colors": ["#0a0e14", "#131a24", "#5b9dff", "#3ecf8e", "#f5b544"]}]


def build_projects():
    with scan_lock:
        projs = list(projects_cache.values())
        status = dict(scan_status)
    labels = _config["labels"]
    cleanup_controlled()
    with _controlled_lock:
        controlled = {k: dict(v) for k, v in _controlled.items()}
    out = []
    for pj in projs:
        lbl = labels.get(pj["path"], {})
        running = 0
        with _proc_lock:
            for pr in _proc_cache["procs"]:
                if pr.get("project") == pj["name"]:
                    running += 1
        git = git_cache.get(pj["path"])
        ctrl = controlled.get(pj["path"])
        cmd_cfg = (lbl.get("cmd") or "").strip()
        out.append({
            "path": pj["path"],
            "name": lbl.get("name") or pj["name"],
            "dir_name": pj["name"],
            "note": lbl.get("note", ""),
            "pinned": pj["path"] in _config.get("pins", []),
            "labeled": bool(lbl),
            "type_hint": pj["type_hint"],
            "file_count": pj["file_count"],
            "size_bytes": pj["size_bytes"],
            "running": running,
            "git": git,
            "cmd": cmd_cfg or detect_start_cmd(pj["path"]),
            "cmd_source": "config" if cmd_cfg else ("auto" if detect_start_cmd(pj["path"]) else ""),
            "controlled": {
                "running": bool(ctrl and _pid_alive(ctrl["pid"])),
                "pid": ctrl["pid"] if ctrl else None,
                "cmd": ctrl["cmd"] if ctrl else None,
                "started_at": ctrl["started_at"] if ctrl else None,
            } if ctrl else {"running": False, "pid": None, "cmd": None, "started_at": None},
        })
    out.sort(key=lambda x: (x["name"].lower()))
    return out, status


def build_state():
    projs, status = build_projects()
    with _proc_lock:
        procs = list(_proc_cache["procs"])
    ctrl_set = controlled_pids()
    for pr in procs:
        pr["controlled"] = pr["pid"] in ctrl_set
    with _sys_lock:
        sysinfo = dict(_sys_cache)
        sysinfo["history"] = list(sysinfo.get("history", []))
    running_total = len(procs)
    running_projects = len({p["project"] for p in procs if p["project"]})
    total_files = status.get("files", 0) if status.get("state") == "done" else None
    total_size = status.get("size", 0) if status.get("state") == "done" else None
    return {
        "app": {"name": APP_NAME, "version": VERSION},
        "scan": status,
        "kpi": {
            "projects": len(projs),
            "files": total_files,
            "size": total_size,
            "processes": running_total,
            "running_projects": running_projects,
        },
        "projects": projs,
        "processes": procs,
        "docker": docker_list(),
        "sys": sysinfo,
        "themes": THEMES,
        "consolePid": os.getpid(),
        "consolePort": int(os.environ.get("WSL_KZ_PORT", "0")) or None,
        "home": str(HOME),
        "wsl_distro": WSL_DISTRO,
        "theme": _config["theme"],
        "uiTheme": "wsl",
        "version": VERSION,
        "config": _config,
        "token": _AUTH_TOKEN,
    }


# ---------------------------------------------------------------- HTTP 服务
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


def fmt_bytes(n):
    if n is None:
        return "—"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return "%.1f %s" % (n, unit) if unit != "B" else "%d B" % n
        n /= 1024
    return "%d B" % n


class Handler(BaseHTTPRequestHandler):
    server_version = "wsl-command/%s" % VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ---- 工具 ----
    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _ok(self):
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _guard(self, sensitive=False):
        """请求来源守卫：
        - Host 必须是本机（防 DNS rebinding 伪造来源）；
        - 敏感写接口：校验 X-Auth-Token + Origin（空或本机）。
        返回 True 表示放行。"""
        host = self.headers.get("Host") or ""
        if not _hostname_allowed(host):
            return False
        if sensitive:
            if self.headers.get("X-Auth-Token", "") != _AUTH_TOKEN:
                return False
            origin = self.headers.get("Origin") or ""
            if origin:
                try:
                    oh = urllib.parse.urlparse(origin).hostname or ""
                except ValueError:
                    return False
                if not _hostname_allowed(oh):
                    return False
        return True

    def _safe_path(self, raw: str):
        """解析并校验绝对路径，防穿越。"""
        try:
            p = Path(urllib.parse.unquote(raw)).resolve()
        except (OSError, ValueError):
            return None
        if not str(p).startswith(str(HOME) + "/") and str(p) != str(HOME):
            return None
        return p

    # ---- GET ----
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path.startswith("/api/"):
            # Host 校验：防 DNS rebinding（恶意域名解析到 127.0.0.1 时 Host 是攻击域名）
            if not self._guard(sensitive=False):
                self._json({"error": "forbidden"}, 403)
                return
            try:
                self._api(path[5:], qs)
            except BrokenPipeError:
                pass
            except Exception as e:
                log("API 错误 %s: %s" % (path, e))
                try:
                    self._json({"error": str(e)}, 500)
                except Exception:
                    pass
            return

        # 静态资源：static/ 目录作为 Web 根（/themes/*.css、/base.css、/app.js 等）
        if path == "/" or path == "/index.html":
            self._serve_file(STATIC_DIR / "index.html")
        else:
            self._serve_file(STATIC_DIR / path.lstrip("/"))

    def _serve_file(self, p: Path):
        try:
            real = p.resolve()
            if not str(real).startswith(str(STATIC_DIR.resolve())):
                self._send(403, b"forbidden", "text/plain; charset=utf-8")
                return
            data = real.read_bytes()
        except OSError:
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        self._send(200, data, MIME.get(real.suffix.lower(), "application/octet-stream"),
                   {"Cache-Control": "no-store"})

    # ---- API ----
    def _api(self, name, qs):
        if name == "health":
            self._json({"ok": True, "version": VERSION, "app": APP_NAME})
        elif name == "state":
            snapshot_processes()
            self._json(build_state())
        elif name == "projects":
            self._json({"projects": build_projects()[0],
                        "scan": scan_status.copy()})
        elif name == "processes":
            scope = qs.get("scope", ["project"])[0]
            procs = snapshot_processes()
            if scope != "all":
                procs = [p for p in procs if p.get("project")]
            self._json({"processes": procs, "scope": scope, "ts": time.time()})
        elif name == "tree":
            raw = qs.get("path", [""])[0]
            p = self._safe_path(raw)
            if not p:
                self._json({"error": "invalid path"}, 400)
                return
            show_hidden = qs.get("show_hidden", ["0"])[0] in ("1", "true")
            res = list_dir(str(p), show_hidden)
            if res is None:
                self._json({"error": "unreadable"}, 404)
            else:
                self._json(res)
        elif name == "file":
            raw = qs.get("path", [""])[0]
            p = self._safe_path(raw)
            if not p:
                self._json({"error": "invalid path"}, 400)
                return
            res = read_file_preview(str(p))
            if res is None:
                self._json({"error": "unreadable"}, 404)
            else:
                self._json(res)
        elif name == "config":
            self._json({"config": _config, "labels": _config["labels"],
                        "ignores": _config["ignores"], "theme": _config["theme"],
                        "data_dir": str(CONFIG_DIR), "home": str(HOME),
                        "version": VERSION})
        elif name == "project/procs":
            raw = qs.get("path", [""])[0]
            p = self._safe_path(raw)
            if not p:
                self._json({"error": "invalid path"}, 400)
                return
            self._json(project_detail_payload(str(p)))
        elif name == "download":
            self._file_download(qs.get("path", [""])[0])
        elif name == "trash":
            self._json({"items": trash_list()})
        elif name == "logs":
            self._json({"logs": tail_log(80)})
        elif name == "projects/logs":
            raw = qs.get("path", [""])[0]
            p = self._safe_path(raw)
            if not p:
                self._json({"error": "invalid path"}, 400)
                return
            logf = project_log_path(str(p))
            try:
                lines = logf.read_text(encoding="utf-8", errors="replace").splitlines()
                self._json({"logs": lines[-200:], "path": str(logf)})
            except OSError:
                self._json({"logs": [], "path": str(logf)})
        else:
            self._json({"error": "unknown api"}, 404)

    def _file_download(self, raw: str):
        """GET /api/download?path=…：64KB 分块流式发送，禁目录。"""
        p = self._safe_path(raw)
        if p is None or not p.is_file():
            self._json({"error": "invalid file"}, 404)
            return
        try:
            size = p.stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            enc = urllib.parse.quote(p.name)
            self.send_header("Content-Disposition",
                             "attachment; filename*=UTF-8''%s" % enc)
            self.end_headers()
            with open(p, "rb") as f:
                while True:
                    chunk = f.read(UPLOAD_CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            log("下载 %s (%s)" % (p, fmt_bytes(size)))
        except (OSError, ConnectionError, BrokenPipeError) as e:
            log("下载失败 %s: %s" % (p, e))

    # ---- POST ----
    def do_POST(self):
        # 所有写接口：Host + Origin + Token 三重校验
        if not self._guard(sensitive=True):
            self._json({"error": "forbidden"}, 403)
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/config":
            self._post_config()
        elif parsed.path == "/api/console/stop":
            log("收到停止指令，正在退出…")
            self._json({"ok": True})
            threading.Thread(target=stop_server, daemon=True).start()
        elif parsed.path == "/api/ui/theme":
            try:
                n = int(self.headers.get("Content-Length", "0"))
                data = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
                name = data.get("theme", "")
                if re.fullmatch(r"[a-z0-9_-]{1,64}", str(name)):
                    _config["uiTheme"] = str(name)
                    save_config()
            except (ValueError, UnicodeDecodeError):
                pass
            self._json({"ok": True})
        elif parsed.path == "/api/scan":
            threading.Thread(target=scan_all, name="scan-manual", daemon=True).start()
            self._json({"ok": True})
        elif parsed.path == "/api/projects/start":
            self._project_control("start")
        elif parsed.path == "/api/projects/stop":
            self._project_control("stop")
        elif parsed.path == "/api/projects/stop-all":
            self._project_control("stop-all")
        elif parsed.path in ("/api/docker/start", "/api/docker/stop"):
            self._docker_control(parsed.path.endswith("/start"))
        elif parsed.path in ("/api/process/start", "/api/process/stop"):
            self._process_control(parsed.path.rsplit("/", 1)[-1])
        elif parsed.path == "/api/upload":
            self._file_upload(parsed.query)
        elif parsed.path in ("/api/file/stat", "/api/file/delete", "/api/file/lock",
                             "/api/file/mkdir",
                             "/api/trash/restore", "/api/trash/empty"):
            self._file_control(parsed.path.rsplit("/", 1)[-1])
        else:
            self._send(404, b"not found", "text/plain; charset=utf-8")

    def _docker_control(self, start):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except (ValueError, UnicodeDecodeError):
            self._json({"error": "bad json"}, 400)
            return
        name = str(data.get("name", ""))
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name):
            self._json({"error": "invalid name"}, 400)
            return
        cmd = ["docker", "start", name] if start else ["docker", "stop", "--time", "5", name]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
        except (OSError, subprocess.TimeoutExpired) as e:
            self._json({"error": "docker 调用失败: %s" % e}, 500)
            return
        # 清除缓存，下次状态立即反映
        with _docker_lock:
            _docker_list_cache["ts"] = 0
            _docker_cache["ts"] = 0
        if r.returncode == 0:
            log("容器 %s %s" % (name, "启动" if start else "停止"))
            self._json({"ok": True})
        else:
            self._json({"ok": False, "error": (r.stderr or "操作失败").strip()[:200]}, 500)

    def _project_control(self, action):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except (ValueError, UnicodeDecodeError):
            self._json({"error": "bad json"}, 400)
            return
        p = self._safe_path(str(data.get("path", "")))
        if p is None:
            self._json({"error": "invalid path"}, 400)
            return
        path = str(p)
        if action == "start":
            ok, info = start_project(path)
        elif action == "stop":
            ok, info = stop_project(path)
        else:
            ok, info = stop_project_all(path)
        self._json({"ok": ok, **info})

    def _process_control(self, action):
        """详情页单进程启停：start 按 key 复活历史进程；stop 按 pid 杀进程树。"""
        try:
            n = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except (ValueError, UnicodeDecodeError):
            self._json({"error": "bad json"}, 400)
            return
        p = self._safe_path(str(data.get("path", "")))
        if p is None:
            self._json({"error": "invalid path"}, 400)
            return
        path = str(p)
        if action == "start":
            key = str(data.get("key", ""))
            if not re.fullmatch(r"[0-9a-f]{16}", key):
                self._json({"error": "invalid key"}, 400)
                return
            ok, info = start_process(path, key)
        else:
            try:
                pid = int(data.get("pid", 0))
            except (ValueError, TypeError):
                self._json({"error": "invalid pid"}, 400)
                return
            ok, info = stop_process(path, pid)
        self._json({"ok": ok, **info})

    def _file_upload(self, query: str):
        """POST /api/upload?path=<目录>&name=<文件名>[&overwrite=1]
        body = 原始文件字节流。1MB 分块流式写 .part → 校验 → 原子改名。"""
        qs = urllib.parse.parse_qs(query)
        raw_dir = qs.get("path", [""])[0]
        name = qs.get("name", [""])[0]
        overwrite = qs.get("overwrite", ["0"])[0] in ("1", "true")
        d = self._safe_path(raw_dir)
        safe = sanitize_filename(name)
        if d is None or not d.is_dir() or not safe:
            self._json({"error": "invalid target"}, 400)
            return
        lt_dir = lock_type_of(str(d))
        if lt_dir != "none":
            self._json({"error": "目标目录被锁定"}, 403)
            return
        dest = d / safe
        lt_dest = lock_type_of(str(dest))
        if lt_dest != "none":
            self._json({"error": "目标文件被锁定"}, 403)
            return
        if dest.exists() and not overwrite:
            self._json({"error": "exists"}, 409)
            return
        try:
            clen = int(self.headers.get("Content-Length") or -1)
        except ValueError:
            clen = -1
        if clen < 0:
            self._json({"error": "missing content-length"}, 411)
            return
        if clen > MAX_UPLOAD_SIZE:
            self._json({"error": "文件超过 2GB 上限"}, 413)
            return
        # curl 等客户端发 Expect: 100-continue 时先回 100，避免无谓等待
        if self.headers.get("Expect", "").lower() == "100-continue":
            try:
                self.wfile.write(b"HTTP/1.1 100 Continue\r\n\r\n")
                self.wfile.flush()
            except OSError:
                return
        part = dest.with_name(dest.name + "." + uuid.uuid4().hex[:6] + ".part")
        try:
            with open(part, "wb") as f:
                remaining = clen
                while remaining > 0:
                    chunk = self.rfile.read(min(UPLOAD_CHUNK, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
            if remaining != 0:
                part.unlink(missing_ok=True)
                self._json({"error": "传输中断，请重试"}, 400)
                return
            os.replace(part, dest)      # 完整无误才转正
            log("上传 %s (%s)" % (dest, fmt_bytes(clen)))
            self._json({"ok": True, "path": str(dest), "size": clen})
        except OSError as e:
            part.unlink(missing_ok=True)
            self._json({"error": "写入失败: %s" % e}, 500)

    def _file_control(self, action):
        """文件管理动作：stat 统计 / delete 删除 / lock 软锁 / trash-restore / trash-empty。"""
        try:
            n = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except (ValueError, UnicodeDecodeError):
            self._json({"error": "bad json"}, 400)
            return
        if action == "stat":
            entries = []
            for raw in (data.get("paths") or []):
                p = self._safe_path(raw)
                if p is None or not p.exists():
                    continue
                try:
                    is_dir = p.is_dir() and not p.is_symlink()
                    files, size = _stat_tree(p) if is_dir else (0, p.stat().st_size)
                except OSError:
                    continue
                entries.append({"path": str(p), "name": p.name, "is_dir": is_dir,
                                "files": files, "size": size,
                                "lock": lock_type_of(str(p))})
            self._json({"entries": entries})
            return
        if action == "delete":
            safe_paths = []
            for raw in (data.get("paths") or []):
                p = self._safe_path(raw)
                if p is not None:
                    safe_paths.append(str(p))
            if not safe_paths:
                self._json({"error": "no valid paths"}, 400)
                return
            ok, info = delete_paths(safe_paths, bool(data.get("permanent")))
            self._json({"ok": ok, **info})
            return
        if action == "lock":
            p = self._safe_path(data.get("path", ""))
            if p is None:
                self._json({"error": "invalid path"}, 400)
                return
            s = str(p)
            if is_hard_locked(p):
                self._json({"error": "系统保护路径不可锁定"}, 403)
                return
            locked = set(_config.get("locked_paths", []))
            if data.get("locked"):
                locked.add(s)
            else:
                locked.discard(s)
            _config["locked_paths"] = sorted(locked)
            save_config()
            self._json({"ok": True, "lock": lock_type_of(s)})
            return
        if action == "mkdir":
            parent = self._safe_path(data.get("path", ""))
            name = sanitize_filename(data.get("name", ""))
            if parent is None or not parent.is_dir() or not name:
                self._json({"error": "invalid target"}, 400)
                return
            lt = lock_type_of(str(parent))
            if lt != "none":
                self._json({"error": "目录被锁定"}, 403)
                return
            dest = parent / name
            if dest.exists():
                self._json({"error": "exists"}, 409)
                return
            try:
                dest.mkdir()
            except OSError as e:
                self._json({"error": "创建失败: %s" % e}, 500)
                return
            log("新建文件夹 %s" % dest)
            self._json({"ok": True, "path": str(dest)})
            return
        if action == "restore":
            ok, info = trash_restore(str(data.get("name", "")))
            self._json({"ok": ok, **info})
            return
        if action == "empty":
            ok, info = trash_empty()
            self._json({"ok": ok, **info})
            return
        self._json({"error": "unknown action"}, 404)

    def _post_config(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(n) if n else b"{}"
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json({"error": "bad json"}, 400)
            return
        with _config_lock:
            if "labels" in data and isinstance(data["labels"], dict):
                for k, v in data["labels"].items():
                    if self._safe_path(str(k)) is None:
                        continue
                    if v and isinstance(v, dict):
                        _config["labels"][k] = {
                            "name": str(v.get("name", ""))[:60],
                            "note": str(v.get("note", ""))[:300],
                            "cmd": str(v.get("cmd", ""))[:200],
                        }
                    else:
                        _config["labels"].pop(k, None)
            if "process_notes" in data and isinstance(data["process_notes"], dict):
                pn = _config.setdefault("process_notes", {})
                for k, v in data["process_notes"].items():
                    if not re.fullmatch(r"[0-9a-f]{16}", str(k)):
                        continue
                    note = str((v or {}).get("note", "")).strip()[:300] if isinstance(v, dict) else ""
                    if note:
                        pn[str(k)] = {"note": note}
                    else:
                        pn.pop(str(k), None)
            if "pins" in data and isinstance(data["pins"], list):
                _config["pins"] = [x for x in data["pins"]
                                    if self._safe_path(str(x)) is not None]
            if "ignores" in data and isinstance(data["ignores"], list):
                _config["ignores"] = [str(x).strip()[:120] for x in data["ignores"] if str(x).strip()]
            if "theme" in data and data["theme"] in ("auto", "light", "dark"):
                _config["theme"] = data["theme"]
        ok = save_config()
        if ok:
            self._json({"ok": True, "config": _config})
        else:
            self._json({"error": "save failed"}, 500)


_server_httpd = None


def stop_server():
    if _server_httpd:
        _server_httpd.shutdown()


# ---------------------------------------------------------------- 启动
def pick_port():
    for port in range(PORT_RANGE[0], PORT_RANGE[1] + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return None


def main():
    load_config()
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(CONFIG_DIR, 0o700)
        os.chmod(LOG_DIR, 0o700)
    except OSError:
        pass

    port = pick_port()
    if port is None:
        log("端口 %d-%d 均被占用，退出" % PORT_RANGE)
        sys.exit(1)

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    global _server_httpd
    _server_httpd = httpd
    os.environ["WSL_KZ_PORT"] = str(port)

    def shutdown(*_):
        log("收到退出信号")
        threading.Thread(target=httpd.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    log("=" * 56)
    log("  %s v%s 已启动" % (APP_NAME, VERSION))
    log("  访问地址: http://localhost:%d" % port)
    log("  数据目录: %s" % CONFIG_DIR)
    log("  监控目录: %s" % HOME)
    log("  提示: 用 Ctrl+C 退出；仅绑定 127.0.0.1")
    log("=" * 56)

    threading.Thread(target=scan_worker, name="scan-worker", daemon=True).start()
    threading.Thread(target=snapshot_processes, args=(True,),
                     name="proc-warmup", daemon=True).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        log("已退出")


if __name__ == "__main__":
    main()
