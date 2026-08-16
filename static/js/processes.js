'use strict';
/* ============================================================
   processes.js — 进程视图：实时表格 + 排序 + 筛选
   ============================================================ */
import { $, el, setKpi, setKpiUnit, setText, setChildren, state,
  icon, escapeHtml, fmtClock, fmtUptime } from './core.js';
import { t, getLang } from './i18n.js';

export const processScope = { scope: 'project', kw: '', sortKey: 'cpu', sortDir: -1 };

const procList = $('#procList'), procEmpty = $('#procEmpty');
let lastTimeText = '';

function fmtMem(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function fmtStarted(ts) {
  if (!ts) return '—';
  return fmtClock(new Date(ts * 1000));
}

function sortRows(rows) {
  const { sortKey, sortDir } = processScope;
  return rows.sort((a, b) => {
    let ra, rb;
    if (sortKey === 'pid' || sortKey === 'cpu' || sortKey === 'rss') {
      ra = a[sortKey] || 0; rb = b[sortKey] || 0;
    } else if (sortKey === 'project') {
      ra = (a.project || '\uffff').toLowerCase(); rb = (b.project || '\uffff').toLowerCase();
    } else {
      ra = (a.cmd || '').toLowerCase(); rb = (b.cmd || '').toLowerCase();
    }
    if (ra < rb) return -sortDir;
    if (ra > rb) return sortDir;
    return 0;
  });
}

function createRow(p) {
  const row = el('div', 'tr');
  const dot = el('span', 'c-dot');
  const dotInner = el('span', 'status-dot');
  dot.appendChild(dotInner);
  const title = el('span', 'c-title');
  const cmd = el('span', 'c-cmd');
  const sub = el('span', 'c-cmd-sub mono');
  title.append(cmd, sub);
  const pid = el('span', 'c-pid mono');
  const proj = el('span', 'c-proj');
  const load = el('span', 'c-load');
  const mem = el('span', 'c-mem mono');
  const up = el('span', 'c-up mono');
  const act = el('span', 'c-act');
  const bCopy = el('button', 'ibtn');
  bCopy.type = 'button';
  bCopy.title = '复制命令';
  bCopy.setAttribute('aria-label', '复制命令');
  bCopy.appendChild(icon('copy', 14));
  act.appendChild(bCopy);
  row.append(dot, title, pid, proj, load, mem, up, act);
  row._r = { dotInner, cmd, sub, pid, proj, load, mem, up, bCopy };
  return row;
}

function updateRow(row, p) {
  const r = row._r;
  r.dotInner.classList.toggle('running', true);
  r.dotInner.classList.toggle('danger', p.state === 'Z');
  setText(r.cmd, escapeHtml(p.cmd || p.comm));
  /* 副行：用户 / 容器 / 端口徽标 + 进程名 */
  const tags = [];
  if (!p.is_me) tags.push('[' + (p.user || '其他') + ']');
  if (p.container) tags.push('[容器 ' + p.container + ']');
  if (p.ports && p.ports.length) tags.push(p.ports.map(x => ':' + x).join(' '));
  setText(r.sub, (tags.join(' ') + (tags.length ? ' ' : '') + (p.comm || '')).trim());
  setText(r.pid, String(p.pid));
  r.proj.replaceChildren();
  if (p.project) {
    const chip = el('span', 'proj-chip');
    chip.textContent = p.project;
    r.proj.appendChild(chip);
  }
  /* 负载条 */
  r.load.replaceChildren();
  const cpu = Math.min(100, Math.max(0, p.cpu || 0));
  const bar = el('span', 'ld-bar');
  const fill = el('i');
  fill.style.width = cpu.toFixed(1) + '%';
  bar.appendChild(fill);
  const val = el('span', 'ld-val mono');
  val.textContent = cpu.toFixed(1) + '%';
  r.load.append(bar, val);
  setText(r.mem, fmtMem(p.rss));
  setText(r.up, fmtStarted(p.started));
  r.bCopy.onclick = () => window.__copyText(p.cmd || '');
}

export function renderProcesses(data) {
  if (!data || state.view !== 'processes') return;
  const all = data.processes || [];
  const sys = data.sys || {};

  /* KPI */
  const mine = all.filter(p => p.project);
  setKpi($('#statMine'), String(mine.length));
  setKpi($('#statAll'), String(all.length));
  setKpiUnit($('#statCpu'), (sys.cpu ?? 0).toFixed(1), '%');
  setKpiUnit($('#statMem'), (sys.mem ?? 0).toFixed(1), '%');
  setText($('#statMineSub'), mine.length ? (getLang() === 'en' ? `${mine.length} matched` : `${mine.length} 个归属项目`) : (getLang() === 'en' ? 'Processes in home or docker' : '进程归属家目录项目或容器'));
  const load = sys.loadavg || [];
  setText($('#statCpuSub'), load.length ? (getLang() === 'en' ? 'Load ' + load[0].toFixed(2) : '负载 ' + load[0].toFixed(2)) : (getLang() === 'en' ? 'Load' : '负载'));
  setText($('#statMemSub'), (getLang() === 'en' ? 'Usage ' : '占用 ') + (sys.mem ?? 0).toFixed(1) + '%');
  const nowText = fmtClock(new Date());
  if (nowText !== lastTimeText) {
    setText($('#statTime'), nowText);
    lastTimeText = nowText;
  }

  /* 列表 */
  let rows = all.slice();
  if (processScope.scope === 'project') rows = rows.filter(p => p.project);
  const kw = processScope.kw.toLowerCase();
  if (kw) {
    rows = rows.filter(p =>
      (p.cmd || '').toLowerCase().includes(kw) ||
      (p.project || '').toLowerCase().includes(kw));
  }
  rows = sortRows(rows);

  setText($('#procSecCount'), rows.length ? (getLang() === 'en' ? `${rows.length} procs` : String(rows.length) + ' 个进程') : '');
  const keys = new Set(rows.map(p => p.pid));
  const existing = new Map();
  for (const child of procList.children) {
    if (child.dataset.key) existing.set(child.dataset.key, child);
  }
  rows.forEach((p, i) => {
    let row = existing.get(String(p.pid));
    if (!row) {
      row = createRow(p);
      row.dataset.key = String(p.pid);
      row.classList.add('anim-in');
    }
    updateRow(row, p);
    const target = procList.children[i];
    if (procList.children[i] !== row) procList.insertBefore(row, target || null);
  });
  /* 移除已退出进程行 */
  for (const [key, row] of existing) {
    if (!keys.has(Number(key))) row.remove();
  }
  procEmpty.hidden = rows.length > 0;

  /* 表头排序（事件绑定一次） */
  const ths = document.querySelectorAll('#view-processes .tbl .th > span');
  if (!renderProcesses._sorted) {
    renderProcesses._sorted = true;
    const map = { 进程: 'cmd', PID: 'pid', 项目: 'project', 负载: 'cpu', 内存: 'rss', 启动: 'started' };
    ths.forEach((th, i) => {
      const label = th.textContent.trim();
      if (!map[label]) return;
      th.style.cursor = 'pointer';
      th.title = '点击排序';
      th.addEventListener('click', () => {
        const { sortKey, sortDir } = processScope;
        if (sortKey === map[label]) processScope.sortDir = -sortDir;
        else { processScope.sortKey = map[label]; processScope.sortDir = label === 'PID' ? 1 : -1; }
        renderProcesses(state.data);
      });
    });
  }
}

/* 初始化筛选控件 */
export function processesInit() {
  if (processesInit._done) return;
  processesInit._done = true;
  $('#procFilter').addEventListener('click', e => {
    const chip = e.target.closest('.fchip[data-p]');
    if (!chip) return;
    for (const c of $('#procFilter').querySelectorAll('.fchip')) {
      c.classList.toggle('active', c === chip);
    }
    processScope.scope = chip.dataset.p;
    renderProcesses(state.data);
  });
  const search = $('#procSearch');
  search.addEventListener('input', () => {
    processScope.kw = search.value;
    renderProcesses(state.data);
  });
}
