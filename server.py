#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wsl-command · WSL2 本地指挥中心
Python 标准库后端（零第三方依赖）。
仅绑定回环地址，只服务本机当前用户。

运行: python3 server.py   (或 ./start.sh)
"""

import json
import os
import pwd
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "0.1.0"
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
    "ignores": [],     # 用户额外忽略规则（子串匹配路径组件）
    "theme": "auto",   # auto | light | dark
}

_config_lock = threading.Lock()
_config = dict(DEFAULT_CONFIG)


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
        for k in ("labels", "ignores", "theme"):
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
    }


def list_dir(path_str: str):
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
                    if _is_hidden(e.name) or is_ignored_name(e.name):
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
    binary = b"\x00" in head
    if binary:
        return {"binary": True, "size": st.st_size}
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return {"binary": True, "size": st.st_size}
    return {"binary": False, "content": text, "truncated": truncated, "size": st.st_size,
            "path": str(p)}


# ---------------------------------------------------------------- 受控进程（启动/暂停）
_controlled_lock = threading.Lock()
_controlled = {}   # path -> {token, pid, pgid, cmd, started_at}


def _pid_alive(pid):
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def detect_start_cmd(path: str) -> str:
    """从项目标志文件自动推断启动命令（无则返回空串）。"""
    p = Path(path)
    try:
        if (p / "package.json").exists():
            pkg = json.loads((p / "package.json").read_text(encoding="utf-8", errors="replace"))
            if isinstance(pkg, dict) and isinstance(pkg.get("scripts"), dict) \
                    and pkg["scripts"].get("start"):
                return "npm start"
        if (p / "manage.py").exists():
            return "python3 manage.py runserver"
        if (p / "Cargo.toml").exists():
            return "cargo run"
        if (p / "go.mod").exists():
            return "go run ."
        if (p / "Makefile").exists():
            return "make run"
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
    if not str(path).startswith(str(HOME)):
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

    def _safe_path(self, raw: str):
        """解析并校验绝对路径，防穿越。"""
        try:
            p = Path(urllib.parse.unquote(raw)).resolve()
        except OSError:
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
            res = list_dir(str(p))
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

    # ---- POST ----
    def do_POST(self):
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
        path = str(data.get("path", ""))
        if not path.startswith(str(HOME)):
            self._json({"error": "invalid path"}, 400)
            return
        if action == "start":
            ok, info = start_project(path)
        elif action == "stop":
            ok, info = stop_project(path)
        else:
            ok, info = stop_project_all(path)
        self._json({"ok": ok, **info})

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
                    if not str(k).startswith(str(HOME)):
                        continue
                    if v and isinstance(v, dict):
                        _config["labels"][k] = {
                            "name": str(v.get("name", ""))[:60],
                            "note": str(v.get("note", ""))[:300],
                            "cmd": str(v.get("cmd", ""))[:200],
                        }
                    else:
                        _config["labels"].pop(k, None)
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
