'use strict';
/* ============================================================
   project-detail.js — 项目详情视图：进程级启停 + 自动含义描述 + 备注
   入口：项目卡片「详情」按钮 → 卡片 3D 翻转 → 整页视图
   ============================================================ */
import { $, el, setText, setChildren, state, icon, escapeHtml,
  openLayer, closeLayer, post, toast, act, fmtClock, truncateMiddle, reconcile } from './core.js';
import { t, getLang } from './i18n.js';
import { openConfirm } from './overlays.js';
import { fmtSize } from './overview.js';

export const detailState = { path: null, _fetching: false, _flipCard: null };

const FLIP_MS = 380;

function fmtMem(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

/* ---------------- 进入 / 返回（卡片 3D 翻转转场） ---------------- */

export function openProjectDetail(path, cardEl) {
  detailState.path = path;
  detailState._flipCard = cardEl || null;
  const doSwitch = () => {
    if (cardEl) {
      cardEl.classList.remove('flip-out');
      void cardEl.offsetWidth;          /* 让 flip-in 能重新触发 */
      cardEl.classList.add('flip-in');
      setTimeout(() => cardEl.classList.remove('flip-in'), FLIP_MS + 120);
    }
    window.__gotoView('detail');
    const view = $('#view-detail');
    if (view) {
      view.classList.add('flip-view-out-enter');
      setTimeout(() => view.classList.remove('flip-view-out-enter'), FLIP_MS + 120);
    }
    renderProjectDetail(true);
  };
  if (cardEl && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cardEl.classList.add('flip-out');
    setTimeout(() => { cardEl.classList.remove('flip-out'); doSwitch(); }, FLIP_MS);
  } else {
    doSwitch();
  }
}

function backToProjects() {
  const path = detailState.path;
  const view = $('#view-detail');
  const finish = () => {
    window.__gotoView('projects');
    if (!path) return;
    let card = null;
    for (const c of $('#projGrid').children) {
      if (c.dataset && c.dataset.key === path) { card = c; break; }
    }
    if (card) {
      card.classList.remove('flip-in', 'flip-out');
      void card.offsetWidth;
      card.classList.add('flip-in');
      setTimeout(() => card.classList.remove('flip-in'), FLIP_MS + 120);
    }
  };
  if (view && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    view.classList.add('flip-view-exit');
    setTimeout(() => { view.classList.remove('flip-view-exit'); finish(); }, FLIP_MS - 40);
  } else {
    finish();
  }
}

/* ---------------- 数据拉取与渲染 ---------------- */

export function renderProjectDetail(force = false) {
  if (!state || state.view !== 'detail' || !detailState.path) return;
  if (detailState._fetching) return;
  detailState._fetching = true;
  fetch('/api/project/procs?path=' + encodeURIComponent(detailState.path))
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(data => {
      if (state.view !== 'detail') return;
      renderDetailBody(data);
    })
    .catch(() => {})
    .finally(() => { detailState._fetching = false; });
}

function renderDetailBody(data) {
  const pj = data.project || {};
  const isEn = getLang() === 'en';

  /* 头部 */
  setText($('#detailIconLetter'), [...(pj.name || '?')][0] || '?');
  setText($('#detailName'), pj.name || '—');
  setText($('#detailPath'), (pj.path || '').replace(/^\/home\/[^/]+/, '~'));
  $('#detailLogs').onclick = () => openProjectLogsSafe(pj.path);

  /* 信息头：类型 / 文件数 / 大小 / git / 启动命令 */
  const stats = $('#detailStats');
  stats.replaceChildren();
  const addStat = (label, value, cls) => {
    const box = el('div', 'dstat' + (cls ? ' ' + cls : ''));
    const lab = el('span', 'dstat-label');
    lab.textContent = label;
    const val = el('span', 'dstat-value mono');
    val.textContent = value || '—';
    box.append(lab, val);
    stats.appendChild(box);
  };
  if (pj.type_hint) addStat(isEn ? 'Type' : '类型', pj.type_hint);
  addStat(isEn ? 'Files' : '文件数', (pj.file_count ?? 0).toLocaleString());
  addStat(isEn ? 'Size' : '大小', fmtSize(pj.size_bytes));
  if (pj.git) addStat(isEn ? 'Git' : 'Git', (pj.git.branch ? pj.git.branch + ' · ' : '') + (pj.git.hash || '') + ' ' + (pj.git.date || ''), 'tone-git');
  addStat(isEn ? 'Start Cmd' : '启动命令', pj.cmd || (isEn ? '(auto-detect on start)' : '（启动时自动检测）'));

  /* 进程表 */
  const rows = [
    ...(data.procs || []).map(p => ({ ...p, _live: true })),
    ...(data.history || []).map(p => ({ ...p, _live: false })),
  ];
  setText($('#detailProcCount'),
    isEn
      ? `${(data.procs || []).length} running · ${rows.length} total`
      : `运行中 ${(data.procs || []).length} · 共 ${rows.length} 条`);
  $('#detailEmpty').hidden = rows.length > 0;
  arrangeTreeRows(rows);
  reconcile($('#detailProcList'), rows,
    r => r.key + ':' + (r.alive ? 'a' : 'h'),
    createProcRow, updateProcRow, false);
}

/* 按进程树聚排：父下紧跟子孙，子行带 _depth 缩进；历史条目排在末尾 */
function arrangeTreeRows(rows) {
  const liveRows = rows.filter(r => r._live);
  const histRows = rows.filter(r => !r._live);
  const byPid = new Map(liveRows.map(r => [r.pid, r]));
  const childrenOf = new Map();
  const roots = [];
  for (const r of liveRows) {
    const par = byPid.get(r.ppid);
    if (par && par !== r) {
      if (!childrenOf.has(par.pid)) childrenOf.set(par.pid, []);
      childrenOf.get(par.pid).push(r);
    } else {
      roots.push(r);
    }
  }
  const cmp = (a, b) => (b.cpu || 0) - (a.cpu || 0) || (a.pid - b.pid);
  roots.sort(cmp);
  for (const list of childrenOf.values()) list.sort(cmp);
  const out = [];
  const seen = new Set();
  const walk = (r, depth) => {
    if (seen.has(r.key)) return;          /* 防 ppid 环形引用死循环 */
    seen.add(r.key);
    r._depth = depth;
    out.push(r);
    for (const c of childrenOf.get(r.pid) || []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const r of liveRows) {             /* 兕底：环上的节点也入列表 */
    if (!seen.has(r.key)) walk(r, 0);
  }
  for (const h of histRows) { h._depth = 0; out.push(h); }
  rows.length = 0;
  rows.push(...out);
}

/* ---------------- 行渲染 ---------------- */

function createProcRow() {
  const row = el('div', 'tr dproc');
  const dot = el('span', 'c-dot');
  const dotInner = el('span', 'status-dot');
  dot.appendChild(dotInner);

  const title = el('span', 'c-title');
  const cmdLine = el('span', 'c-cmd');
  const sub = el('span', 'c-cmd-sub mono');
  title.append(cmdLine, sub);

  const desc = el('span', 'c-desc');
  const descText = el('span', 'desc-text');
  const noteBtn = el('button', 'ibtn ibtn-inline');
  noteBtn.type = 'button';
  noteBtn.appendChild(icon('square-pen', 13));
  desc.append(descText, noteBtn);

  const pid = el('span', 'c-pid mono');
  const load = el('span', 'c-load');
  const mem = el('span', 'c-mem mono');
  const up = el('span', 'c-up mono');

  const act = el('span', 'c-act');
  const bToggle = el('button', 'btn btn-sm');
  bToggle.type = 'button';
  act.append(bToggle);

  row.append(dot, title, desc, pid, load, mem, up, act);
  row._r = { dotInner, cmdLine, sub, descText, noteBtn, pid, load, mem, up, bToggle, row };
  return row;
}

function updateProcRow(row, p) {
  const r = row._r;
  const isEn = getLang() === 'en';
  const live = !!p._live;

  row.classList.toggle('stopped-row', !live);
  r.dotInner.classList.toggle('running', live);
  r.dotInner.classList.toggle('danger', p.state === 'Z');

  /* 主行：树形缩进 + L 形连线 + 命令行；副行：用户/容器/端口/父进程 */
  r.cmdLine.replaceChildren();
  row.classList.toggle('tree-child', p._depth > 0);
  if (p._depth > 0) {
    const pad = el('i', 'tree-pad');
    pad.style.width = ((Math.min(p._depth, 6) - 1) * 30 + 8) + 'px';
    const guide = el('i', 'tree-guide');
    r.cmdLine.append(pad, guide);
  }
  r.cmdLine.appendChild(document.createTextNode(truncateMiddle(p.cmd || p.comm || '', 64)));
  if (p.managed) {
    const badge = el('span', 'mini-badge managed');
    badge.textContent = isEn ? 'Managed' : '受控';
    r.cmdLine.appendChild(badge);
  }
  const tags = [];
  if (p.user && !p.is_me) tags.push('[' + p.user + ']');
  if (p.container) tags.push((isEn ? '[container ' : '[容器 ') + p.container + ']');
  if (p.ports && p.ports.length) tags.push(p.ports.map(x => ':' + x).join(' '));
  if (p.parent_pid) tags.push('↑ ' + (p.parent_comm || '') + ' (' + p.parent_pid + ')');
  setText(r.sub, tags.join(' '));

  /* 描述列：备注优先 → 自动描述 → 未识别引导 */
  r.descText.replaceChildren();
  const autoDesc = (isEn ? p.desc_en : p.desc_zh) || '';
  if (p.note) {
    const n = el('span', 'note-chip');
    n.textContent = p.note;
    n.title = (isEn ? 'Note: ' : '备注：') + p.note;
    r.descText.appendChild(n);
  } else if (autoDesc) {
    const a = el('span', 'auto-desc');
    a.textContent = autoDesc;
    r.descText.appendChild(a);
  } else {
    const u = el('span', 'auto-desc unknown');
    u.textContent = isEn ? 'Unrecognized — click ✏ to describe it' : '未识别进程 — 点 ✏ 补个说明';
    r.descText.appendChild(u);
  }
  r.noteBtn.title = t('pdNoteModalTitle');
  r.noteBtn.setAttribute('aria-label', t('pdNoteModalTitle'));
  r.noteBtn.onclick = () => openNoteModal(p);

  setText(r.pid, p.pid != null ? String(p.pid) : '—');

  /* 负载条 */
  r.load.replaceChildren();
  const cpu = Math.min(100, Math.max(0, p.cpu || 0));
  const bar = el('span', 'ld-bar');
  const fill = el('i');
  fill.style.width = cpu.toFixed(1) + '%';
  bar.appendChild(fill);
  const val = el('span', 'ld-val mono');
  val.textContent = live ? cpu.toFixed(1) + '%' : '—';
  r.load.append(bar, val);

  setText(r.mem, live ? fmtMem(p.rss) : '—');
  setText(r.up, p.started ? fmtClock(new Date(p.started * 1000)) : (p.last_seen ? fmtClock(new Date(p.last_seen * 1000)) : '—'));

  /* 操作按钮：运行中 = 停止；已停止 = 启动 */
  r.bToggle.className = 'btn btn-sm ' + (live ? 'btn-stop' : 'btn-accent');
  r.bToggle.disabled = false;
  if (live) {
    setChildren(r.bToggle, icon('square', 12), document.createTextNode(t('stop')));
    r.bToggle.onclick = () => stopOneProcess(p);
  } else {
    setChildren(r.bToggle, icon('play', 12), document.createTextNode(t('start')));
    r.bToggle.onclick = () => startOneProcess(p, r.bToggle);
  }
}

/* ---------------- 单进程启停 ---------------- */

const procBusy = new Set();

function stopOneProcess(p) {
  const isEn = getLang() === 'en';
  openConfirm({
    title: isEn ? 'Stop Process' : '停止进程',
    bodyHtml: (isEn ? 'Stop <b>' : '确定停止 <b>') + escapeHtml(truncateMiddle(p.cmd || '', 60)) +
      '</b> (PID ' + p.pid + ')' +
      (isEn ? '?<div class="confirm-detail">Its child processes will be stopped too.</div>'
           : '?<div class="confirm-detail">将同时停止它派生的子进程。</div>'),
    okText: t('stop'),
    tone: 'danger',
    onOk: async () => {
      try {
        const res = await act(post('/api/process/stop', { path: detailState.path, pid: p.pid }));
        if (res && res.ok !== false) toast(isEn ? `Stopped ${res.stopped ?? 1} process(es)` : `已停止 ${res.stopped ?? 1} 个进程`);
        renderProjectDetail(true);
        if (window.__poll) window.__poll();
      } catch (e) { /* act 已 toast */ }
    },
  });
}

async function startOneProcess(p, btn) {
  const isEn = getLang() === 'en';
  if (procBusy.has(p.key)) return;
  procBusy.add(p.key);
  btn.disabled = true;
  const oldHtml = btn.innerHTML;
  setChildren(btn, document.createTextNode(t('processing')));
  try {
    const res = await post('/api/process/start', { path: detailState.path, key: p.key });
    if (res && res.ok !== false) {
      toast(res.already ? (isEn ? 'Already running' : '该进程已在运行')
                        : (isEn ? 'Started (PID ' + res.pid + ')' : '已启动 (PID ' + res.pid + ')'));
    }
  } finally {
    procBusy.delete(p.key);
    btn.disabled = false;
    btn.innerHTML = oldHtml;
    renderProjectDetail(true);
    if (window.__poll) window.__poll();
  }
}

function openProjectLogsSafe(path) {
  import('./control.js').then(m => m.openProjectLogs(path));
}

/* ---------------- 备注弹窗 ---------------- */

const noteMask = () => $('#pdNoteMask');
const noteCtx = { key: null };

function openNoteModal(p) {
  noteCtx.key = p.key;
  $('#pdNoteCmd').value = truncateMiddle(p.cmd || '', 80);
  $('#pdNoteAuto').value = (getLang() === 'en' ? p.desc_en : p.desc_zh)
    || (getLang() === 'en' ? '(unrecognized)' : '（未识别）');
  $('#pdNoteInput').value = p.note || '';
  openLayer(noteMask(), $('#pdNoteInput'));
  $('#pdNoteInput').focus();
}

async function saveNote(clear = false) {
  const key = noteCtx.key;
  if (!key) return;
  const notes = JSON.parse(JSON.stringify((state.config && state.config.process_notes) || {}));
  if (clear) delete notes[key];
  else notes[key] = { note: $('#pdNoteInput').value.trim() };
  const result = await act(post('/api/config', { process_notes: notes }));
  if (result && result.ok !== false) {
    state.config = state.config || {};
    state.config.process_notes = notes;
    toast(clear ? (getLang() === 'en' ? 'Note cleared' : '已清除备注')
                : (getLang() === 'en' ? 'Note saved' : '备注已保存'));
    closeLayer(noteMask());
    renderProjectDetail(true);
  }
}

export function detailInit() {
  if (detailInit._done) return;
  detailInit._done = true;
  $('#detailBack').addEventListener('click', backToProjects);
  $('#pdNoteSave').addEventListener('click', () => saveNote(false));
  $('#pdNoteCancel').addEventListener('click', () => closeLayer(noteMask()));
  $('#pdNoteClear').addEventListener('click', () => saveNote(true));
}
