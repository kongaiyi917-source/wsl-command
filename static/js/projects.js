'use strict';
/* ============================================================
   projects.js — 项目视图：卡片网格 + 筛选 + 标注
   ============================================================ */
import { $, el, setText, setChildren, state, icon, escapeHtml,
  openLayer, closeLayer, post, toast, act, fmtUptime, truncateMiddle } from './core.js';
import { t, getLang } from './i18n.js';
import { openConfirm } from './overlays.js';
import { fmtSize } from './overview.js';
import { startProject, stopProject, openProjectLogs, stopProjectAll, isProjectBusy } from './control.js';

const projGrid = $('#projGrid');

export const projectFilterState = { filter: 'all', kw: '', pendingLabel: null };

function createCard() {
  const card = el('article', 'app-card');
  card.tabIndex = 0;

  const head = el('div', 'app-head');
  const iconBox = el('div', 'app-icon');
  const iconTxt = el('span', 'app-icon-letter');
  iconBox.appendChild(iconTxt);
  const meta = el('div', 'app-meta');
  const name = el('div', 'app-name');
  const status = el('div', 'app-status');
  const dot = el('span', 'status-dot');
  const stText = el('span', 'st-text');
  const stUp = el('span', 'st-up');
  status.append(dot, stText, stUp);
  meta.append(name, status);
  head.append(iconBox, meta);

  const bPin = el('button', 'app-pin-btn');
  bPin.type = 'button';
  bPin.title = t('pin');
  bPin.setAttribute('aria-label', t('pin'));
  bPin.appendChild(icon('pin', 14));

  const cmd = el('div', 'app-cmd');

  const actions = el('div', 'app-actions');
  const primary = el('button', 'btn app-primary');
  primary.type = 'button';
  const bEdit = el('button', 'btn b-edit');
  bEdit.type = 'button';
  bEdit.title = t('edit');
  bEdit.setAttribute('aria-label', t('edit'));
  setChildren(bEdit, icon('pencil', 14), document.createTextNode(t('edit')));
  const sub = el('div', 'app-sub-actions');
  const bCopy = el('button', 'ibtn');
  bCopy.type = 'button';
  bCopy.title = t('copyPath');
  bCopy.setAttribute('aria-label', t('copyPath'));
  bCopy.appendChild(icon('copy', 15));
  const bLogs = el('button', 'ibtn');
  bLogs.type = 'button';
  bLogs.title = t('viewLogs');
  bLogs.setAttribute('aria-label', t('viewLogs'));
  bLogs.appendChild(icon('file-text', 15));
  bLogs.hidden = true;
  sub.append(bCopy, bLogs);
  actions.append(primary, bEdit, sub);

  card.append(bPin, head, cmd, actions);
  card._r = { iconTxt, name, status, dot, stText, stUp, cmd, primary, bEdit, bPin, bCopy, bLogs };
  return card;
}

function updateCard(card, p) {
  const r = card._r;
  const running = p.running || 0;

  setText(r.iconTxt, [...p.name][0] || '?');
  setText(r.name, p.name + (p.labeled ? '' : ''));
  card.title = p.path;
  if (p.labeled) {
    r.name.classList.add('labeled');
    const tag = el('span', 'name-tag');
    tag.textContent = p.dir_name;
    r.name.replaceChildren(document.createTextNode(p.name), tag);
  } else {
    r.name.classList.remove('labeled');
  }

  r.dot.classList.toggle('running', running > 0);
  const ctrl = p.controlled || {};
  const ctrlRunning = !!(ctrl.running && ctrl.pid);
  if (ctrlRunning) {
    setText(r.stText, (getLang() === 'en' ? 'Running (Managed) · PID ' : '指挥中心运行中 · PID ') + ctrl.pid);
    r.stText.classList.add('ctrl-badge');
    setText(r.stUp, '●');
  } else if (running > 0) {
    setText(r.stText, getLang() === 'en' ? `Running (${running} procs, unmanaged)` : `运行中 ${running} 进程（非受控）`);
    r.stText.classList.remove('ctrl-badge');
    setText(r.stUp, '●');
  } else {
    setText(r.stText, p.type_hint || (getLang() === 'en' ? 'Stopped' : '已停止'));
    r.stText.classList.remove('ctrl-badge');
    setText(r.stUp, '');
  }

  /* 命令区：路径 + 统计 */
  r.cmd.replaceChildren();
  const pathLine = el('div', 'cmd-line mono');
  pathLine.textContent = truncateMiddle(p.path.replace(/^\/home\/[^/]+/, '~'), 52);
  r.cmd.appendChild(pathLine);
  if (p.note) {
    const noteLine = el('div', 'cmd-note');
    noteLine.textContent = p.note;
    r.cmd.appendChild(noteLine);
  }
  const fileUnit = getLang() === 'en' ? ' files' : ' 文件';
  if (p.git) {
    const statLine = el('div', 'cmd-stats mono');
    statLine.textContent = (p.file_count ?? 0).toLocaleString() + fileUnit + ' · ' +
      fmtSize(p.size_bytes) + ' · ' + p.git.date + ' ' + p.git.hash;
    r.cmd.appendChild(statLine);
  } else {
    const statLine = el('div', 'cmd-stats mono');
    statLine.textContent = (p.file_count ?? 0).toLocaleString() + fileUnit + ' · ' + fmtSize(p.size_bytes);
    r.cmd.appendChild(statLine);
  }
  if (p.cmd) {
    const cmdLine = el('div', 'cmd-stats mono cmd-start');
    const src = p.cmd_source === 'config'
      ? (getLang() === 'en' ? ' (manual)' : '（手动配置）')
      : (getLang() === 'en' ? ' (auto)' : '（自动检测）');
    cmdLine.textContent = (getLang() === 'en' ? 'Start: ' : '启动: ') + p.cmd + src;
    r.cmd.appendChild(cmdLine);
  } else if (!ctrlRunning && !(running > 0)) {
    const noCmd = el('div', 'cmd-stats mono cmd-nocmd');
    noCmd.textContent = getLang() === 'en' ? 'No start command detected. Click "Start" to configure.' : '尚未抓取到启动命令，点击「▶ 启动」可手动配置';
    r.cmd.appendChild(noCmd);
  }
  /* docker 容器关联标记 */
  const dockers = ((state.data && state.data.docker) || [])
    .filter(c => c.project === p.dir_name);
  if (dockers.length) {
    const dLine = el('div', 'cmd-stats mono docker-line');
    dLine.textContent = '🐳 docker: ' + dockers.map(c => c.name + (c.running ? '' : (getLang() === 'en' ? ' (stopped)' : '（已停止）'))).join(', ');
    r.cmd.appendChild(dLine);
  }

  /* 动作：主按钮 = 启动/暂停（SVG 图标 + 文字，所有项目统一显示） */
  const setPrimary = (ico, label, cls, fn, disabled) => {
    r.primary.classList.remove('btn-accent', 'btn-stop');
    if (cls) r.primary.classList.add(cls);
    r.primary.disabled = !!disabled;
    r.primary.onclick = fn;
    if (ico) {
      setChildren(r.primary, icon(ico, 14), document.createTextNode(label));
    } else {
      setChildren(r.primary, document.createTextNode(label));
    }
  };
  if (isProjectBusy(p.path)) {
    setPrimary(null, t('processing'), 'btn-accent', null, true);
  } else if (ctrlRunning) {
    setPrimary('square', t('stop'), 'btn-stop', () => stopProject(p.path, p.name));
  } else if (running > 0) {
    setPrimary('square', t('stopAll'), 'btn-stop', () => stopProjectAll(p.path, p.name, running));
  } else {
    setPrimary('play', t('start'), 'btn-accent', () => startProject(p.path, p.name));
  }
  r.bEdit.onclick = () => openLabelModal(p.path);
  setChildren(r.bEdit, icon('pencil', 14), document.createTextNode(t('edit')));
  r.bPin.onclick = () => togglePin(p.path, p.pinned);
  r.bPin.classList.toggle('active', !!p.pinned);
  r.bPin.title = p.pinned ? t('unpin') : t('pin');
  r.bPin.setAttribute('aria-label', p.pinned ? t('unpin') : t('pin'));
  r.bCopy.title = t('copyPath');
  r.bCopy.setAttribute('aria-label', t('copyPath'));
  r.bCopy.onclick = () => window.__copyText(p.path);
  r.bLogs.title = t('viewLogs');
  r.bLogs.setAttribute('aria-label', t('viewLogs'));
  r.bLogs.hidden = !ctrlRunning && !p.cmd;
  r.bLogs.onclick = () => openProjectLogs(p.path);

  card.classList.toggle('running', ctrlRunning || running > 0);
  card.classList.toggle('pinned', !!p.pinned);
}

/* 查看项目启动日志（预览抽屉） */


export function renderProjects(data) {
  if (!data || state.view !== 'projects') return;
  projectsInit();
  const projects = data.projects || [];
  const { filter, kw } = projectFilterState;

  let list = projects;
  if (filter === 'running') list = list.filter(p => p.running > 0);
  else if (filter === 'git') list = list.filter(p => p.git);
  else if (filter === 'unlabeled') list = list.filter(p => !p.labeled);
  if (kw) {
    const k = kw.toLowerCase();
    list = list.filter(p =>
      p.name.toLowerCase().includes(k) ||
      (p.note || '').toLowerCase().includes(k) ||
      p.path.toLowerCase().includes(k));
  }
  /* 排序：运行状态绝对优先（运行中在前），同状态下置顶在前，其余按名称 */
  list = [...list].sort((a, b) => {
    const ra = (a.running || 0) > 0 || (a.controlled && a.controlled.running) ? 1 : 0;
    const rb = (b.running || 0) > 0 || (b.controlled && b.controlled.running) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return a.name.localeCompare(b.name, 'zh');
  });

  setText($('#projSecCount'), projects.length ? (getLang() === 'en' ? `${projects.length} projects` : String(projects.length) + ' 个项目') : '');

  /* 卡片原地更新 */
  const keys = new Map(list.map(p => [p.path, p]));
  const existing = new Map();
  for (const child of projGrid.children) {
    if (child.dataset.key) existing.set(child.dataset.key, child);
  }
  list.forEach((p, i) => {
    let card = existing.get(p.path);
    if (!card) {
      card = createCard();
      card.dataset.key = p.path;
      card.classList.add('anim-in');
      card.style.setProperty('--d', Math.min(i * 30, 600) + 'ms');
    }
    updateCard(card, p);
    if (projGrid.children[i] !== card) projGrid.insertBefore(card, projGrid.children[i] || null);
  });
  for (const [key, card] of existing) {
    if (!keys.has(key)) card.remove();
  }

  if (!list.length) {
    const empty = el('div', 'grid-empty');
    const iconBox = el('div', 'grid-empty-icon');
    iconBox.appendChild(icon('folder', 28));
    const txt = el('p');
    txt.textContent = projects.length
      ? (getLang() === 'en' ? 'No matching projects found. Try changing filters.' : '没有匹配的项目，试试调整筛选条件')
      : (getLang() === 'en' ? 'No projects found under home directory. Waiting for scan…' : '家目录下还没有项目，等待扫描完成…');
    empty.append(iconBox, txt);
    projGrid.appendChild(empty);
  }

  /* 命令面板触发的标注 */
  if (projectFilterState.pendingLabel) {
    const path = projectFilterState.pendingLabel;
    projectFilterState.pendingLabel = null;
    openLabelModal(path);
  }
}

/* 切换置顶状态 */
async function togglePin(path, currentPinned) {
  const pins = Array.isArray(state.config?.pins) ? [...state.config.pins] : [];
  let nextPins;
  if (currentPinned) {
    nextPins = pins.filter(p => p !== path);
  } else {
    if (!pins.includes(path)) nextPins = [...pins, path];
    else nextPins = pins;
  }
  state.config = state.config || {};
  state.config.pins = nextPins;
  if (state.data && state.data.projects) {
    for (const p of state.data.projects) {
      if (p.path === path) p.pinned = !currentPinned;
    }
  }
  renderProjects(state.data);
  const res = await post('/api/config', { pins: nextPins });
  if (res && res.ok !== false) {
    toast(currentPinned ? '已取消置顶' : '已置顶');
    if (window.__poll) window.__poll();
  }
}

/* ---------------- 标注模态 ---------------- */
const labelMask = $('#labelMask');
let labelPath = null;

export function openLabelModal(path) {
  labelPath = path;
  const pj = (state.data && state.data.projects || []).find(p => p.path === path);
  const lbl = (state.config && state.config.labels) || {};
  const cur = lbl[path] || {};
  $('#labelPath').value = path;
  $('#labelName').value = cur.name || pj?.name || '';
  $('#labelNote').value = cur.note || '';
  $('#labelCmd').value = cur.cmd || '';
  /* 提示自动检测结果 */
  const hint = $('#labelCmdHint');
  if (hint) {
    if (cur.cmd) {
      hint.textContent = '已手动配置，启动时优先使用此命令';
    } else if (pj && pj.cmd) {
      hint.textContent = '自动检测到: ' + pj.cmd + '（留空将使用它）';
    } else {
      hint.textContent = '未检测到常用启动命令，可手动填写；留空则不能一键启动';
    }
  }
  openLayer(labelMask, $('#labelName'));
  $('#labelName').focus();
  $('#labelName').select();
}

function closeLabelModal() { closeLayer(labelMask); }

async function saveLabel() {
  const name = $('#labelName').value.trim();
  const note = $('#labelNote').value.trim();
  const cmd = $('#labelCmd').value.trim();
  const labels = JSON.parse(JSON.stringify((state.config && state.config.labels) || {}));
  if (name || note || cmd) labels[labelPath] = { name, note, cmd };
  else delete labels[labelPath];
  const result = await act(post('/api/config', { labels }));
  if (result && result.ok !== false) {
    state.config = state.config || {};
    state.config.labels = labels;
    toast(name || note || cmd ? '标注已保存' : '已清除标注');
    closeLabelModal();
    if (window.__poll) window.__poll();
  }
}

/* 初始化标注模态按钮（首次进入视图时绑定一次） */
export function projectsInit() {
  if (projectsInit._done) return;
  projectsInit._done = true;
  $('#labelSave').addEventListener('click', saveLabel);
  $('#labelCancel').addEventListener('click', closeLabelModal);
  $('#labelClear').addEventListener('click', async () => {
    const labels = JSON.parse(JSON.stringify((state.config && state.config.labels) || {}));
    delete labels[labelPath];
    const result = await act(post('/api/config', { labels }));
    if (result && result.ok !== false) {
      state.config = state.config || {};
      state.config.labels = labels;
      toast('已清除标注');
      closeLabelModal();
      if (window.__poll) window.__poll();
    }
  });

  /* 筛选 chips */
  $('#projFilter').addEventListener('click', e => {
    const chip = e.target.closest('.fchip[data-f]');
    if (!chip) return;
    for (const c of $('#projFilter').querySelectorAll('.fchip')) {
      c.classList.toggle('active', c === chip);
    }
    projectFilterState.filter = chip.dataset.f;
    renderProjects(state.data);
  });
  const search = $('#projSearch');
  search.addEventListener('input', () => {
    projectFilterState.kw = search.value;
    renderProjects(state.data);
  });
}
