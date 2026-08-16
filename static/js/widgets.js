'use strict';
/* ============================================================
   widgets.js — 右侧信息栏与导航轨
   实时动态（进程启动/停止差分事件流，首帧静默建立基线）、
   活跃项目 / 进程资源 TOP5、小贴士、快捷操作、日志中心、设置中心、预览抽屉
   ============================================================ */
import { $, el, setText, setChildren, icon, state, fmtClock,
  openLayer, closeLayer, act, post, toast, escapeHtml, applyTheme } from './core.js';
import { t, getLang } from './i18n.js';
import { openConfirm } from './overlays.js';

const FEED_CAP = 50;
let feedSeq = 0;
let feedEvents = [];
let prevSnap = null;

export function resetFeedBaseline() { prevSnap = null; }

const feedListL = $('#feedListL'), feedListS = $('#feedListS');
const topProjL = $('#topProjL'), topResS = $('#topResS'), resTabs = $('#resTabs');
const tipsText = $('#tipsText'), tipsAction = $('#tipsAction');
const railConnDot = $('#railConnDot'), railConnText = $('#railConnText');
const railVer = $('#railVer');
let resMetric = 'cpu';

/* ---------------- 初始化 ---------------- */
export function initWidgets() {
  document.querySelectorAll('[data-qa-icon]').forEach(node => {
    setChildren(node, icon(node.dataset.qaIcon, 13));
  });
  setChildren($('#tipsIcon'), icon('brain', 14));

  /* 快捷操作代理 */
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-qa]');
    if (!btn) return;
    const action = btn.dataset.qa;
    if (action === 'refresh') {
      fetch('/api/scan', { method: 'POST' }).catch(() => {});
      if (window.__poll) window.__poll();
    }
    else if (action === 'logs') openLogsCenter();
    else if (action === 'settings') openSettingsCenter();
    else if (action === 'copy-home') {
      const home = (state.data && state.data.home) || '~';
      window.__copyText(home);
    } else if (action === 'goto-files') {
      document.querySelector('.nav-btn[data-view="files"]')?.click();
    }
  });

  /* 导航轨动作按钮 */
  document.querySelectorAll('.rail-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'logs') openLogsCenter();
      else if (btn.dataset.action === 'settings') openSettingsCenter();
    });
  });
  setChildren($('#railIconLogs'), icon('file-text', 19));
  setChildren($('#railIconSettings'), icon('settings', 19));

  $('#logsMaskClose').addEventListener('click', closeLogsCenter);
  $('#logsMask').addEventListener('mousedown', e => {
    if (e.target === $('#logsMask')) closeLogsCenter();
  });
  $('#settingsMaskClose').addEventListener('click', closeSettingsCenter);
  $('#settingsMask').addEventListener('mousedown', e => {
    if (e.target === $('#settingsMask')) closeSettingsCenter();
  });
  $('#setAppearance').addEventListener('click', e => {
    const tab = e.target.closest('.mini-tab');
    if (!tab) return;
    const mode = tab.dataset.appearance;
    if (mode === 'auto') localStorage.removeItem('console-theme');
    else localStorage.setItem('console-theme', mode);
    applyTheme();
    syncSettings();
  });

  $('#ignoreAdd').addEventListener('click', addIgnoreRule);
  $('#ignoreInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addIgnoreRule();
  });

  $('#feedClearL').addEventListener('click', clearFeed);
  $('#feedClearS').addEventListener('click', clearFeed);
  resTabs.addEventListener('click', e => {
    const tab = e.target.closest('.mini-tab');
    if (!tab) return;
    resMetric = tab.dataset.metric === 'mem' ? 'mem' : 'cpu';
    for (const t of resTabs.querySelectorAll('.mini-tab')) {
      t.classList.toggle('active', t === tab);
    }
    if (state.data) renderTopRes(state.data);
  });

  /* 连接状态跟随横幅 */
  const banner = $('#banner');
  const syncConn = () => {
    const down = banner.classList.contains('show');
    railConnDot.classList.toggle('running', !down);
    railConnDot.classList.toggle('danger', down);
    setText(railConnText, down ? (getLang() === 'en' ? 'Disconnected' : '连接中断') : (getLang() === 'en' ? 'Connected' : '已连接'));
  };
  new MutationObserver(syncConn)
    .observe(banner, { attributes: true, attributeFilter: ['class'] });
  syncConn();

  tipsAction.addEventListener('click', () => {
    const tab = document.querySelector('.nav-btn[data-view="projects"]');
    if (tab) tab.click();
  });

  /* 预览抽屉关闭 */
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('mousedown', e => {
    if (e.target === $('#drawerMask')) closeDrawer();
  });
}

/* ---------------- 实时动态 ---------------- */
function snapshotMaps(data) {
  const procs = new Map();
  for (const p of data.processes || []) {
    procs.set(p.pid, {
      cmd: p.cmd || p.comm || '(内核?)',
      project: p.project || null,
      cpu: p.cpu || 0,
      rss: p.rss || 0,
    });
  }
  const projects = new Map();
  for (const p of data.projects || []) {
    projects.set(p.path, { name: p.name, running: p.running || 0 });
  }
  return { procs, projects, scanning: (data.scan || {}).state === 'scanning' };
}

function pushEvent(level, title, sub) {
  feedEvents.unshift({ seq: ++feedSeq, at: new Date(), level, title, sub });
  if (feedEvents.length > FEED_CAP) feedEvents.length = FEED_CAP;
}

function diffSnapshot(prev, next) {
  for (const [pid, p] of next.procs) {
    const before = prev.procs.get(pid);
    if (!before) continue;
    if (p.project && before.cpu < 1 && p.cpu >= 1) {
      /* 高负载变化不产生告警；这里只关心启停 */
    }
  }
  for (const [pid, p] of next.procs) {
    if (!prev.procs.has(pid)) {
      pushEvent('info', (p.project ? p.project + ' · ' : '') + shortCmd(p.cmd),
        'PID ' + pid + ' 启动');
    }
  }
  for (const [pid, p] of prev.procs) {
    if (!next.procs.has(pid)) {
      pushEvent('info', (p.project ? p.project + ' · ' : '') + shortCmd(p.cmd),
        'PID ' + pid + ' 结束');
    }
  }
  for (const [path, pj] of next.projects) {
    const before = prev.projects.get(path);
    if (!before) continue;
    if (before.running === 0 && pj.running > 0) {
      pushEvent('ok', pj.name + ' 项目开始活跃', pj.running + ' 个进程');
    } else if (before.running > 0 && pj.running === 0) {
      pushEvent('warn', pj.name + ' 项目进程已全部结束', '');
    }
  }
  if (!prev.scanning && next.scanning) {
    pushEvent('warn', '开始全量扫描', '正在统计文件与磁盘占用');
  } else if (prev.scanning && !next.scanning) {
    pushEvent('ok', '扫描完成', '项目统计已更新');
  }
}

function shortCmd(cmd) {
  const s = String(cmd || '').trim();
  return s.length > 42 ? s.slice(0, 42) + '…' : s;
}

function feedItem(ev) {
  const item = el('div', 'feed-item');
  const dot = el('span', 'feed-dot lvl-' + ev.level);
  dot.setAttribute('aria-hidden', 'true');
  const main = el('div', 'feed-main');
  const title = el('div', 'feed-title');
  title.textContent = ev.title;
  main.appendChild(title);
  if (ev.sub) {
    const sub = el('div', 'feed-sub');
    sub.textContent = ev.sub;
    main.appendChild(sub);
  }
  const time = el('span', 'feed-time mono');
  time.textContent = fmtClock(ev.at).slice(0, 5);
  item.append(dot, main, time);
  return item;
}

function renderFeedInto(list, events, emptyText) {
  list.replaceChildren();
  if (!events.length) {
    const empty = el('div', 'feed-empty');
    empty.textContent = emptyText;
    list.appendChild(empty);
    return;
  }
  for (const ev of events.slice(0, 12)) list.appendChild(feedItem(ev));
}

function renderFeeds() {
  const isEn = getLang() === 'en';
  renderFeedInto(feedListL, feedEvents, isEn ? 'No activity yet. Process start/stop and scan events will appear here.' : '暂无动态；进程启停与扫描事件会显示在这里');
  renderFeedInto(feedListS,
    feedEvents.filter(ev => ev.level === 'warn' || ev.level === 'error'),
    isEn ? 'All systems operational, no alerts.' : '运行良好，暂无告警');
}

function clearFeed() {
  feedEvents = [];
  renderFeeds();
}

/* ---------------- 活跃项目 TOP5 ---------------- */
function renderTopProj(data) {
  const counts = new Map();
  for (const p of data.processes || []) {
    if (p.project) counts.set(p.project, (counts.get(p.project) || 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  topProjL.replaceChildren();
  if (!rows.length) {
    const empty = el('div', 't5-empty');
    empty.textContent = getLang() === 'en' ? 'No project processes' : '暂无项目相关进程';
    topProjL.appendChild(empty);
    return;
  }
  rows.forEach(([name, n], i) => {
    const row = el('div', 't5-row');
    const rank = el('span', 't5-rank');
    rank.textContent = String(i + 1);
    const pname = el('span', 't5-name');
    pname.textContent = name;
    pname.title = name;
    const tag = el('span', 't5-tag');
    tag.textContent = getLang() === 'en' ? `${n} procs` : `${n} 进程`;
    row.append(rank, pname, tag);
    topProjL.appendChild(row);
  });
}

/* ---------------- 进程资源 TOP5 ---------------- */
function renderTopRes(data) {
  const procs = (data.processes || [])
    .slice()
    .sort((a, b) => (b[resMetric] || 0) - (a[resMetric] || 0))
    .slice(0, 5);
  topResS.replaceChildren();
  if (!procs.length) {
    const empty = el('div', 't5-empty');
    empty.textContent = getLang() === 'en' ? 'No processes' : '暂无进程';
    topResS.appendChild(empty);
    return;
  }
  procs.forEach((p, i) => {
    const row = el('div', 't5-row');
    const rank = el('span', 't5-rank');
    rank.textContent = String(i + 1);
    const name = el('span', 't5-name');
    name.textContent = shortCmd(p.cmd || p.comm);
    name.title = p.cmd || p.comm;
    const val = el('span', 't5-val');
    const pct = resMetric === 'mem'
      ? fmtMemPct(p.rss) : (typeof p.cpu === 'number' ? p.cpu : 0);
    val.textContent = pct;
    const bar = el('span', 't5-bar');
    const fill = el('i');
    const w = resMetric === 'mem' ? memShare(p.rss) : p.cpu;
    fill.style.width = Math.max(2, Math.min(100, w)) + '%';
    bar.appendChild(fill);
    row.append(rank, name, bar, val);
    topResS.appendChild(row);
  });
}

let lastMemTotal = 0;
function memTotal() {
  if (lastMemTotal) return lastMemTotal;
  const info = (state.data && state.data.sys) || {};
  void info;
  return 16 * 1024 * 1024 * 1024; // 兜底 16G，实际由 memShare 修正
}
function memShare(rss) {
  return rss ? Math.min(100, rss / memTotal() * 100) : 0;
}
function fmtMemPct(rss) {
  const gb = (rss || 0) / 1073741824;
  return gb >= 1 ? gb.toFixed(1) + 'G' : Math.round((rss || 0) / 1048576) + 'M';
}

/* ---------------- 小贴士 ---------------- */
function renderTips(data) {
  const scan = data.scan || {};
  let text;
  const isEn = getLang() === 'en';
  if (scan.state === 'scanning') {
    text = isEn ? 'Scanning home directory: computing file count and disk usage.' : '正在全量扫描家目录：统计文件数与磁盘占用（已跳过依赖/缓存目录）。';
  } else if (scan.state === 'done') {
    text = isEn ? `Scanned ${scan.projects || 0} projects · ${scan.files != null ? scan.files.toLocaleString() + ' files' : ''}. Tip: Press ⌘K for command palette.` : ('已扫描 ' + (scan.projects || 0) + ' 个项目 · ' +
      (scan.files != null ? scan.files.toLocaleString() + ' 个文件' : '') +
      '。小技巧：按 ⌘K 打开命令面板快速跳转。');
  } else {
    text = isEn ? 'Ready. Tip: Press ⌘K to open command palette.' : '等待首次扫描完成。小技巧：按 ⌘K 打开命令面板。';
  }
  setText(tipsText, text);
  tipsAction.hidden = true;
}

/* ---------------- 主入口 ---------------- */
export function renderWidgets(data) {
  if (!data) return;
  const next = snapshotMaps(data);
  if (prevSnap) diffSnapshot(prevSnap, next);
  prevSnap = next;
  renderFeeds();
  renderTopProj(data);
  renderTopRes(data);
  renderTips(data);
  setText(railVer, data.version ? 'v' + data.version : 'v—');
}

/* ============================================================
   预览抽屉（文件预览 / 日志查看共用）
   ============================================================ */
const logDrawer = $('#logDrawer'), logBody = $('#logBody'), logPre = $('#logPre');

/* 打开预览抽屉：title 与纯文本内容（文件内容 / 日志） */
export function openDrawer(title, text) {
  setText($('#drawerTitle'), title);
  logPre.textContent = text == null ? '' : String(text);
  logBody.replaceChildren(logPre);
  openLayer(logDrawer, $('#drawerClose'));
}
export function closeDrawer() { closeLayer(logDrawer); }

/* 自定义 HTML 内容（如二进制提示） */
export function setDrawerHtml(title, html) {
  setText($('#drawerTitle'), title);
  logBody.innerHTML = html;
  openLayer(logDrawer, $('#drawerClose'));
}

/* ============================================================
   日志中心：指挥中心自身日志
   ============================================================ */
const logsMask = $('#logsMask'), logsList = $('#logsList');

function renderLogsList() {
  logsList.replaceChildren();
  const row = el('button', 'logs-item');
  row.type = 'button';
  const box = el('span', 'logs-ic');
  box.appendChild(icon('terminal', 14));
  const main = el('span', 'logs-main');
  const isEn = getLang() === 'en';
  const name = el('span', 'logs-name');
  name.textContent = isEn ? 'WSL Command Center Logs' : '指挥中心日志';
  const sub = el('span', 'logs-sub');
  sub.textContent = isEn ? 'System · console.log · Last 80 lines' : '系统 · console.log · 最近 80 行';
  main.append(name, sub);
  row.append(box, main, icon('chevron-right', 14));
  row.addEventListener('click', () => {
    closeLogsCenter();
    openConsoleLog();
  });
  logsList.appendChild(row);
}

export function openLogsCenter() {
  renderLogsList();
  openLayer(logsMask, $('#logsMaskClose'));
}
export function closeLogsCenter() { closeLayer(logsMask); }

let consoleLogTimer = null;
function openConsoleLog() {
  const isEn = getLang() === 'en';
  const view = async () => {
    try {
      const r = await fetch('/api/logs');
      const j = await r.json();
      let logs = j.logs || [];
      if (isEn) {
        logs = logs.map(line => line
          .replace(/开始全量扫描\s+/g, 'Start full scan ')
          .replace(/扫描完成:\s*(\d+)\s*个项目,\s*(\d+)\s*个文件,\s*([\d.]+)\s*MB/g, 'Scan completed: $1 projects, $2 files, $3 MB')
          .replace(/项目开始活跃/g, 'became active')
          .replace(/项目进程已全部结束/g, 'all processes terminated'));
      }
      openDrawer(isEn ? 'WSL Command Center Logs' : '指挥中心日志', logs.join('\n'));
    } catch { /* 忽略，下一轮重试 */ }
  };
  view();
  clearInterval(consoleLogTimer);
  consoleLogTimer = setInterval(() => {
    if (!logDrawer.classList.contains('open')) clearInterval(consoleLogTimer);
    else view();
  }, 2000);
}

/* ============================================================
   设置中心
   ============================================================ */
const settingsMask = $('#settingsMask');
const DEFAULT_IGNORE_CHIPS = ['node_modules', '.venv', '__pycache__',
  'dist', 'build', '.git', '.cache', '.local', '.config', '.npm'];

export function syncSettings() {
  const stored = localStorage.getItem('console-theme');
  const mode = stored === 'dark' ? 'dark' : stored === 'light' ? 'light' : 'auto';
  for (const tab of $('#setAppearance').querySelectorAll('.mini-tab')) {
    tab.classList.toggle('active', tab.dataset.appearance === mode);
  }
  const d = state.data || {};
  setText($('#setVersion'), d.version ? 'v' + d.version : '—');
  setText($('#setPort'), d.consolePort ? ':' + d.consolePort : '—');
  setText($('#setHome'), d.home || '—');
  setText($('#setDataDir'), (d.configDataDir) || '~/.config/wsl-command');
  setText($('#setDistro'), d.wsl_distro || '—');
  const scan = d.scan || {};
  const isEn = getLang() === 'en';
  setText($('#setScan'), scan.state === 'scanning'
    ? (isEn ? 'Scanning…' : '扫描中…') : scan.state === 'done'
      ? (isEn
        ? `${scan.projects || 0} projects · ${(scan.files != null ? scan.files.toLocaleString() : '—')} files`
        : (scan.projects || 0) + ' 项目 · ' + (scan.files != null ? scan.files.toLocaleString() : '—') + ' 文件')
      : '—');

  /* 忽略规则 */
  const chips = $('#ignoreChips');
  chips.replaceChildren();
  const userRules = (state.config && state.config.ignores) || [];
  if (userRules.length === 0) {
    const hint = el('span', 'ignore-hint');
    hint.textContent = isEn ? 'No custom rules' : '暂无自定义规则';
    chips.appendChild(hint);
  }
  userRules.forEach((rule, i) => {
    const chip = el('span', 'ignore-chip');
    chip.textContent = rule;
    const x = el('button', 'ignore-x');
    x.type = 'button';
    x.textContent = '×';
    x.title = '删除规则';
    x.setAttribute('aria-label', '删除规则 ' + rule);
    x.addEventListener('click', async () => {
      const ignores = [...userRules];
      ignores.splice(i, 1);
      await saveIgnores(ignores);
    });
    chip.append(document.createTextNode(rule), x);
    chips.appendChild(chip);
  });
}

async function saveIgnores(ignores) {
  try {
    await post('/api/config', { ignores });
    state.config = state.config || {};
    state.config.ignores = ignores;
    toast('忽略规则已更新');
    syncSettings();
    if (window.__poll) window.__poll();
  } catch (e) {
    toast('保存失败：' + e.message);
  }
}

async function addIgnoreRule() {
  const input = $('#ignoreInput');
  const rule = input.value.trim();
  if (!rule) return;
  const ignores = [...((state.config && state.config.ignores) || []), rule];
  input.value = '';
  await saveIgnores(ignores);
}

export function openSettingsCenter() {
  syncSettings();
  openLayer(settingsMask, $('#settingsMaskClose'));
}
export function closeSettingsCenter() { closeLayer(settingsMask); }

/* ============================================================
   批量停止（预留：进程操作扩展）
   ============================================================ */
export function batchStopConfirm() {
  const procs = ((state.data && state.data.processes) || []).filter(p => p.project);
  if (!procs.length) {
    toast('当前没有项目相关进程');
    return;
  }
  openConfirm({
    title: '提示',
    bodyHtml: '当前版本为只读监控，停止进程的操作功能尚未开放。',
    okText: '知道了',
    tone: 'accent',
  });
}
