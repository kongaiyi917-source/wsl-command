'use strict';
/* ============================================================
   app.js — wsl-command 主入口（原生 ES Module，无构建）
   每 2s 轮询 GET /api/state，分发到各视图渲染模块。
   ============================================================ */
import { $, setText, setChildren, setKpi, setKpiUnit, icon, state,
  openLayer, closeLayer, activeLayer, trapLayerFocus, act, post, toast,
  applyTheme, initThemeToggle, applyUiTheme, currentUiTheme, escapeHtml,
  fmtClock, DISCONNECTED_TEXT, reconcilePendingUiTheme, fmtUptime } from './js/core.js';
import { t, getLang, setLang, initI18n } from './js/i18n.js';
import { openConfirm } from './js/overlays.js';
import { initWidgets, renderWidgets, resetFeedBaseline,
  openLogsCenter, openSettingsCenter, syncSettings } from './js/widgets.js';
import { renderOverview } from './js/overview.js';
import { renderProjects, projectFilterState } from './js/projects.js';
import { renderProcesses, processScope } from './js/processes.js';
import { renderFiles, filesInit, openProjectPath } from './js/files.js';

const banner = $('#banner');
const sideNav = $('#sideNav');
const navBtns = [...sideNav.querySelectorAll('.nav-btn')];
const viewTitle = $('#viewTitle');
const viewOverline = $('#viewOverline');
const viewSub = $('#viewSub');
const navCounts = {
  overview: $('#navCountOverview'), projects: $('#navCountProjects'),
  processes: $('#navCountProcesses'), files: $('#navCountFiles'),
};
const sideStats = $('#sideStats');
const cmdkTrigger = $('#cmdkTrigger');
const stopConsoleBtn = $('#stopConsoleBtn');
const stopConsoleLabel = $('#stopConsoleLabel');
const railHost = $('#railHost');
const views = {
  overview: $('#view-overview'), projects: $('#view-projects'),
  processes: $('#view-processes'), files: $('#view-files'),
};
const sideOverview = $('#sideOverview'), sideProc = $('#sideProc');
const railBtns = [...document.querySelectorAll('.rail-btn[data-view]')];

function getViewMeta(v) {
  const metaMap = {
    overview: { title: t('tabOverview'), overline: 'Overview', sub: t('vhOverviewSub') },
    projects: { title: t('tabProjects'), overline: 'Projects', sub: t('vhProjectsSub') },
    processes: { title: t('tabProcesses'), overline: 'Processes', sub: t('vhProcessesSub') },
    files: { title: t('tabFiles'), overline: 'Files', sub: t('vhFilesSub') },
  };
  return metaMap[v] || metaMap.overview;
}

function switchView(v) {
  if (state.view === v) return;
  state.view = v;
  localStorage.setItem('console-view', v);
  applyView();
  const active = views[v];
  active.classList.remove('active');
  void active.offsetWidth;
  active.classList.add('active');
}

function applyView() {
  const v = state.view;
  navBtns.forEach(b => {
    const active = b.dataset.view === v;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
    b.tabIndex = active ? 0 : -1;
  });
  railBtns.forEach(b => {
    const active = b.dataset.view === v;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  sideOverview.hidden = v === 'processes';
  sideProc.hidden = v !== 'processes';
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle('active', key === v);
    el.setAttribute('aria-hidden', String(key !== v));
  }
  const meta = getViewMeta(v);
  setText(viewTitle, meta.title);
  setText(viewOverline, meta.overline);
  setText(viewSub, meta.sub);
  document.documentElement.dataset.view = v;
  if (v === 'projects') renderProjects(state.data);
  else if (v === 'processes') renderProcesses(state.data);
  else if (v === 'files') renderFiles(state.data);
  else if (v === 'overview') renderOverview(state.data);
}

// 全局视图刷新接口（供语言切换等使用）
window.__refreshAllViews = () => {
  applyView();
  if (state.data) {
    renderWidgets(state.data);
  }
};

navBtns.forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
railBtns.forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
sideNav.addEventListener('keydown', e => {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  let index = navBtns.indexOf(document.activeElement);
  if (index < 0) return;
  if (e.key === 'Home') index = 0;
  else if (e.key === 'End') index = navBtns.length - 1;
  else index = (index + ((e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1) + navBtns.length) % navBtns.length;
  switchView(navBtns[index].dataset.view);
  navBtns[index].focus();
});

/* ============================================================
   轮询
   ============================================================ */
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 7000;
let pollPromise = null;
let pollController = null;
let pollTimer = null;
let firstRender = true;

function render() {
  const data = state.data;
  if (!data) return;

  /* 顶栏统计 */
  const projs = data.projects || [];
  const procs = data.processes || [];
  const mine = procs.filter(p => p.project);
  setText(navCounts.overview, projs.length ? String(projs.length) : '');
  setText(navCounts.projects, projs.length ? String(projs.length) : '');
  setText(navCounts.processes, procs.length ? String(procs.length) : '');
  setText(navCounts.files, '');
  const isEn = getLang() === 'en';
  setText(sideStats, isEn
    ? `${projs.length} projects · ${procs.length} procs` + (data.scan && data.scan.state === 'scanning' ? ' · scanning' : '')
    : '项目 ' + projs.length + ' · 进程 ' + procs.length + (data.scan && data.scan.state === 'scanning' ? ' · 扫描中' : ''));
  setText(railHost, (data.home || '~').replace(/^\/home\/[^/]+/, '~'));
  setText(stopConsoleLabel, state.stopping ? (isEn ? 'Stopping…' : '停止中') : (isEn ? 'Stop' : '停止'));
  stopConsoleBtn.disabled = state.stopping;

  applyUiTheme(currentUiTheme());

  renderOverview(data);
  renderProjects(data);
  renderProcesses(data);
  renderFiles(data);
  renderWidgets(data);
  firstRender = false;
}

function setConnected(ok, message = '') {
  if (ok) {
    banner.classList.remove('show');
    banner.setAttribute('aria-hidden', 'true');
  } else {
    banner.classList.add('show');
    banner.setAttribute('aria-hidden', 'false');
  }
}

/* 轮询单飞：避免上一请求未返回时叠加下一请求 */
function poll(force = false) {
  if (pollPromise) {
    if (force) {
      if (pollController) pollController.abort();
      pollController = null;
      pollPromise = null;
    } else {
      return pollPromise;
    }
  }
  const controller = new AbortController();
  pollController = controller;
  const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  pollPromise = fetch('/api/state', { signal: controller.signal })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(data => {
      if (pollController !== controller) return null;
      state.data = reconcilePendingUiTheme(data);
      render();
      setConnected(true);
      /* 全量扫描刚完成（或完成进度变化）时立即再拉一轮 */
      const scan = data.scan || {};
      if (scan.state === 'scanning' || (scan.finished && Date.now() - scan.finished * 1000 < 4000)) {
        return poll(true);
      }
      return null;
    })
    .catch(e => {
      if (e.name === 'AbortError') return null;
      if (pollController !== controller) return null;
      setConnected(false);
      return null;
    })
    .finally(() => {
      clearTimeout(timer);
      if (pollController === controller) {
        pollController = null;
        pollPromise = null;
      }
    });
  return pollPromise;
}
window.__poll = () => poll(true);

function schedulePoll(delay = POLL_INTERVAL_MS) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => poll(), delay);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    if (pollController) pollController.abort();
  } else {
    resetFeedBaseline();
    poll(true);
  }
});

/* ============================================================
   停止服务
   ============================================================ */
stopConsoleBtn.addEventListener('click', () => {
  openConfirm({
    title: '停止服务',
    bodyHtml: '确定要停止 wsl-command 服务吗？<div class="confirm-detail">停止后本页面将无法再访问。可通过 <b>python3 server.py</b> 重新启动。</div>',
    okText: '停止',
    tone: 'danger',
    onOk: async () => {
      state.stopping = true;
      setText(stopConsoleLabel, '停止中');
      const result = await act(post('/api/console/stop', {}));
      if (!result || result.ok === false) {
        state.stopping = false;
        setText(stopConsoleLabel, '停止');
      }
    },
  });
});

/* ============================================================
   命令面板
   ============================================================ */
const paletteMask = $('#paletteMask'), paletteInput = $('#paletteInput');
const paletteList = $('#paletteList');
let paletteItems = [];
let paletteSel = -1;

function paletteActions() {
  const items = [
    { icon: 'layout-grid', title: t('cmdOpenOverview'), hint: t('cmdHintView'),
      run: () => switchView('overview') },
    { icon: 'folder', title: t('cmdOpenProjects'), hint: t('cmdHintView'),
      run: () => switchView('projects') },
    { icon: 'activity', title: t('cmdOpenProcesses'), hint: t('cmdHintView'),
      run: () => switchView('processes') },
    { icon: 'folder-git-2', title: t('cmdOpenFiles'), hint: t('cmdHintView'),
      run: () => switchView('files') },
    { icon: 'sun', title: t('cmdToggleTheme'), hint: t('cmdHintAppearance'),
      run: () => { localStorage.setItem('console-theme',
        document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); applyTheme(); } },
    { icon: 'copy', title: t('qaCopyHome'), hint: t('cmdHintTools'),
      run: async () => {
        const home = (state.data && state.data.home) || '~';
        await copyText(home);
      } },
    { icon: 'refresh-cw', title: t('qaRefresh'), hint: t('cmdHintTools'),
      run: () => { fetch('/api/scan', { method: 'POST' }).catch(() => {}); poll(true); } },
    { icon: 'file-text', title: t('qaLogs'), hint: t('cmdHintModal'),
      run: openLogsCenter },
    { icon: 'settings', title: t('cmdOpenSettings'), hint: t('cmdHintModal'),
      run: openSettingsCenter },
  ];
  /* 项目动态项 */
  for (const p of (state.data && state.data.projects) || []) {
    items.push({
      icon: 'folder', title: (getLang() === 'en' ? 'Browse: ' : '浏览: ') + p.name, hint: p.path,
      run: () => { switchView('files'); openProjectPath(p.path); },
    });
    items.push({
      icon: 'pencil', title: (getLang() === 'en' ? 'Label: ' : '标注: ') + p.name, hint: getLang() === 'en' ? 'Edit name and notes' : '编辑名称与备注',
      run: () => { switchView('projects'); projectFilterState.pendingLabel = p.path; renderProjects(state.data); },
    });
  }
  return items;
}

function paletteFiltered() {
  const kw = paletteInput.value.trim().toLowerCase();
  return paletteActions().filter(it =>
    !kw || it.title.toLowerCase().includes(kw) || (it.hint || '').toLowerCase().includes(kw));
}

function renderPalette() {
  paletteItems = paletteFiltered();
  paletteSel = paletteItems.length ? 0 : -1;
  paletteList.replaceChildren();
  paletteItems.forEach((it, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pi' + (i === paletteSel ? ' sel' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === paletteSel));
    row.id = 'paletteItem' + i;
    const ic = icon(it.icon, 15);
    const label = document.createElement('span');
    label.className = 'pi-label';
    label.textContent = it.title;
    row.append(ic, label);
    if (it.hint) {
      const hint = document.createElement('span');
      hint.className = 'pi-hint mono';
      hint.textContent = it.hint;
      row.appendChild(hint);
    }
    row.addEventListener('click', () => execPalette(i));
    paletteList.appendChild(row);
  });
  syncPaletteSel();
}

function syncPaletteSel() {
  const rows = paletteList.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('sel', i === paletteSel);
    rows[i].setAttribute('aria-selected', String(i === paletteSel));
  }
  if (paletteSel >= 0 && rows[paletteSel]) {
    paletteInput.setAttribute('aria-activedescendant', 'paletteItem' + paletteSel);
    rows[paletteSel].scrollIntoView({ block: 'nearest' });
  }
}

function openPalette() {
  if (activeLayer()) return;
  renderPalette();
  openLayer(paletteMask, paletteInput);
  paletteInput.focus();
}
function closePalette() { closeLayer(paletteMask); }

function execPalette(i) {
  const it = paletteItems[i];
  if (!it) return;
  closePalette();
  Promise.resolve(it.run()).catch(e => toast('操作失败：' + e.message));
}

paletteInput.addEventListener('input', renderPalette);
paletteInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteSel = paletteSel < paletteItems.length - 1 ? paletteSel + 1 : paletteSel;
    syncPaletteSel();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteSel = paletteSel > 0 ? paletteSel - 1 : paletteSel;
    syncPaletteSel();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    execPalette(paletteSel);
  }
});
paletteList.addEventListener('mousemove', e => {
  const row = e.target.closest('.pi');
  if (!row) return;
  const i = [...paletteList.children].indexOf(row);
  if (i >= 0 && i !== paletteSel) { paletteSel = i; syncPaletteSel(); }
});
paletteMask.addEventListener('mousedown', e => {
  if (e.target === paletteMask) closePalette();
});

cmdkTrigger.addEventListener('click', openPalette);

/* 剪贴板 */
async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    toast('已复制: ' + (txt.length > 42 ? txt.slice(0, 42) + '…' : txt));
  } catch {
    const ta = document.createElement('textarea');
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); }
    catch { toast('复制失败'); }
    ta.remove();
  }
}
window.__copyText = copyText;

/* 通用路径复制工具（供各视图使用） */
export function wslWinPath(p, distro) {
  const d = distro || (state.data && state.data.wsl_distro) || 'Ubuntu';
  return '\\\\wsl$\\' + d + '\\' + String(p).replace(/^\//, '').replace(/\//g, '\\');
}
window.__wslWinPath = wslWinPath;

/* ============================================================
   初始化
   ============================================================ */
function init() {
  document.querySelectorAll('[data-ov-icon]').forEach(node => {
    setChildren(node, icon(node.dataset.ovIcon, 17));
  });
  document.querySelectorAll('[data-qa-icon]').forEach(node => {
    setChildren(node, icon(node.dataset.qaIcon, 13));
  });
  setChildren($('#railIconOverview'), icon('layout-grid', 19));
  setChildren($('#railIconProjects'), icon('folder', 19));
  setChildren($('#railIconProcesses'), icon('activity', 19));
  setChildren($('#railIconFiles'), icon('folder-git-2', 19));
  setChildren($('#navIconOverview'), icon('layout-grid', 15));
  setChildren($('#navIconProjects'), icon('folder', 15));
  setChildren($('#navIconProcesses'), icon('activity', 15));
  setChildren($('#navIconFiles'), icon('folder-git-2', 15));
  setChildren($('#cmdkIcon'), icon('search', 15));
  setChildren($('#paletteIcon'), icon('search', 15));
  setChildren($('#refreshIcon'), icon('refresh-cw', 13));
  setChildren($('#stopConsoleIcon'), icon('power', 13));

  initI18n();
  initThemeToggle();
  initWidgets();
  filesInit();
  applyTheme();

  const stored = localStorage.getItem('console-view');
  state.view = ['overview', 'projects', 'processes', 'files'].includes(stored) ? stored : 'overview';
  applyView();
  applyUiTheme(currentUiTheme());
  poll(true);
  schedulePoll();
  setInterval(() => { if (!document.hidden) poll(); }, POLL_INTERVAL_MS);
}

/* 键盘快捷键 */
document.addEventListener('keydown', e => {
  if (activeLayer()) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    openLogsCenter();
  }
});
document.addEventListener('keydown', trapLayerFocus);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const layer = activeLayer();
  if (layer) closeLayer(layer);
});

init();
