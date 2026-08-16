'use strict';
/* ============================================================
   overview.js — 概览视图：KPI 卡 + 动态列表
   ============================================================ */
import { $, el, setKpi, setKpiUnit, setText, setChildren, state,
  icon, fmtUptime, escapeHtml, fmtClock } from './core.js';
import { t, getLang } from './i18n.js';
import { startProject, stopProject, stopProjectAll, dockerStart, dockerStop, isProjectBusy } from './control.js';

let cpuHistory = [];
let memHistory = [];

function renderSpark(polyline, history, key) {
  if (!polyline) return;
  const data = history.slice(-30);
  if (data.length < 2) { polyline.setAttribute('points', ''); return; }
  const values = data.map(d => d[key]);
  const min = Math.min(...values), max = Math.max(...values);
  const span = Math.max(0.001, max - min);
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * 100;
    const y = 25 - ((d[key] - min) / span) * 22;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  polyline.setAttribute('points', pts);
}

export function renderOverview(data) {
  if (!data) return;
  const kpi = data.kpi || {};
  const scan = data.scan || {};
  const sys = data.sys || {};
  const projects = data.projects || [];
  const processes = data.processes || [];

  /* KPI */
  setKpi($('#ovProjects'), String(kpi.projects ?? 0));
  setText($('#ovProjectsSub'),
    scan.state === 'scanning' ? (getLang() === 'en' ? 'Scanning…' : '扫描中…') :
      scan.state === 'done' ? (getLang() === 'en' ? 'Home: ' : '家目录 ') + (data.home || '~') : (getLang() === 'en' ? 'Waiting scan' : '等待扫描'));
  setKpi($('#ovFiles'), kpi.files == null ? '—' : kpi.files.toLocaleString());
  setText($('#ovFilesSub'),
    scan.state === 'scanning' ? (getLang() === 'en' ? 'Calculating…' : '统计中…') : (getLang() === 'en' ? 'Ignored cache & deps' : '已忽略依赖/缓存目录'));
  setKpiUnit($('#ovSize'), fmtSize(kpi.size), '');
  setKpi($('#ovProcesses'), String(processes.length));
  setText($('#ovProcessesSub'),
    getLang() === 'en' ? `${kpi.running_projects ?? 0} projects active` : `${kpi.running_projects ?? 0} 个项目有活跃进程`);
  setKpiUnit($('#ovCpu'), (sys.cpu ?? 0).toFixed(1), '%');
  setKpiUnit($('#ovMem'), (sys.mem ?? 0).toFixed(1), '%');

  /* 历史数据（spark） */
  if (sys.history && sys.history.length) {
    cpuHistory = sys.history;
    memHistory = sys.history;
  }
  renderSpark($('#sparkCpu'), cpuHistory, 'cpu');
  renderSpark($('#sparkMem'), memHistory, 'mem');

  /* 项目启停列表（仅显示运行中的项目，按状态排序，每行独立启停） */
  const counts = new Map();
  const dockerProj = new Set();
  for (const p of processes) {
    if (p.project) {
      counts.set(p.project, (counts.get(p.project) || 0) + 1);
      if (p.container) dockerProj.add(p.project);
    }
  }
  const runningList = $('#runningList');
  runningList.replaceChildren();
  const ctrlCount = projects.filter(p => p.controlled && p.controlled.running).length;
  setText($('#runningSecCount'),
    ctrlCount ? (getLang() === 'en' ? `${ctrlCount} managed` : `${ctrlCount} 受控运行`) : '');
  /* 只显示运行中的项目 */
  const active = projects.filter(p =>
    (p.running || 0) > 0 || (p.controlled && p.controlled.running));
  if (!active.length) {
    const empty = el('div', 'empty-line');
    empty.textContent = getLang() === 'en' ? 'No projects currently running — go to Projects to start' : '当前没有项目在运行——去「项目」页点击 ▶ 启动';
    runningList.appendChild(empty);
  } else {
    const rank = p => (p.controlled && p.controlled.running ? 2 : ((p.running || 0) > 0 ? 1 : 0));
    const sorted = active.slice().sort((a, b) => rank(b) - rank(a));
    sorted.forEach(p => {
      const n = counts.get(p.name) || counts.get(p.dir_name) || 0;
      const isDocker = dockerProj.has(p.name) || dockerProj.has(p.dir_name);
      const ctrl = p.controlled || {};
      const ctrlRunning = !!(ctrl.running && ctrl.pid);
      const row = el('div', 'dyn-row');
      const dot = el('span', 'status-dot' + (ctrlRunning || n > 0 ? ' running' : ''));
      const nm = el('span', 'dyn-name');
      nm.textContent = p.name;
      nm.title = p.path + (p.cmd ? (getLang() === 'en' ? ' · Start: ' : ' · 启动: ') + p.cmd : '');
      /* docker 徽标：该项目有容器进程 */
      const badge = isDocker ? dockerBadge() : null;
      const cnt = el('span', 'dyn-count mono');
      cnt.textContent = n ? (getLang() === 'en' ? `${n} procs` : `${n} 进程`) : (ctrlRunning ? 'PID ' + ctrl.pid : '—');
      /* 控制按钮：受控运行 → 停止；有进程非受控 → 停止全部；否则 → 启动 */
      let ctrlBtn = null;
      if (isProjectBusy(p.path)) {
        ctrlBtn = el('button', 'btn btn-mini btn-accent');
        ctrlBtn.textContent = t('processing');
        ctrlBtn.disabled = true;
      } else if (ctrlRunning) {
        ctrlBtn = el('button', 'btn btn-mini btn-stop');
        setChildren(ctrlBtn, icon('square', 12), document.createTextNode(t('stop')));
        ctrlBtn.title = getLang() === 'en' ? 'Stop managed process' : '停止由指挥中心启动的进程';
        ctrlBtn.addEventListener('click', () => stopProject(p.path, p.name));
      } else if (n > 0) {
        ctrlBtn = el('button', 'btn btn-mini btn-stop');
        setChildren(ctrlBtn, icon('square', 12), document.createTextNode(t('stopAll')));
        ctrlBtn.title = getLang() === 'en' ? 'Stop all processes for this project' : '停止该项目全部进程（含你手动启动的）';
        ctrlBtn.addEventListener('click', () => stopProjectAll(p.path, p.name, n));
      } else {
        ctrlBtn = el('button', 'btn btn-mini btn-accent');
        setChildren(ctrlBtn, icon('play', 12), document.createTextNode(t('start')));
        ctrlBtn.title = p.cmd ? (getLang() === 'en' ? 'Start: ' : '启动: ') + p.cmd : (getLang() === 'en' ? 'Start project' : '启动项目（未配置命令将引导配置）');
        ctrlBtn.addEventListener('click', () => startProject(p.path, p.name));
      }
      const go = el('button', 'btn btn-mini');
      go.type = 'button';
      go.textContent = t('browse');
      go.addEventListener('click', () => {
        const files = document.querySelector('.nav-btn[data-view="files"]');
        if (files) files.click();
        if (window.__openProjectPath) window.__openProjectPath(p.path);
      });
      row.append(dot, nm);
      if (badge) row.appendChild(badge);
      row.appendChild(cnt);
      if (ctrlBtn) row.appendChild(ctrlBtn);
      row.appendChild(go);
      runningList.appendChild(row);
    });
  }

  function dockerBadge() {
    const b = el('span', 'docker-chip');
    b.textContent = '🐳 docker';
    b.title = '该项目有 Docker 容器进程';
    return b;
  }

  /* Docker 容器总览（仅显示运行中的容器） */
  const dockerList = $('#dockerList');
  dockerList.replaceChildren();
  const containers = (data.docker || []).filter(c => c.running);
  setText($('#dockerSecCount'), containers.length ? (getLang() === 'en' ? `${containers.length} total` : String(containers.length) + ' 个') : '');
  if (!containers.length) {
    const empty = el('div', 'empty-line');
    empty.textContent = getLang() === 'en' ? 'No running containers (stopped ones can be started in Projects)' : '没有运行中的容器（已停止的可在「项目」页启动）';
    dockerList.appendChild(empty);
  } else {
    containers.forEach(c => {
      const row = el('div', 'dyn-row');
      const dot = el('span', 'status-dot running');
      const nm = el('span', 'dyn-name');
      nm.textContent = c.name;
      nm.title = c.image;
      const badge = el('span', 'docker-chip');
      badge.textContent = '🐳 docker';
      badge.title = 'Docker container';
      const info = el('span', 'dyn-info mono');
      const projName = (dirName) => {
        const p = projects.find(x => x.dir_name === dirName);
        return p ? p.name : dirName;
      };
      info.textContent = (c.ports && c.ports.length ? c.ports.map(x => ':' + x).join(' ') : '') +
        (c.project ? ' · ' + projName(c.project) : '');
      const cnt = el('span', 'dyn-count mono');
      cnt.textContent = c.status.replace(/\s+\(.*/, '');
      cnt.title = c.image;
      const actBtn = el('button', 'btn btn-mini btn-stop');
      setChildren(actBtn, icon('square', 12), document.createTextNode(t('stop')));
      actBtn.addEventListener('click', () => dockerStop(c.name));
      row.append(dot, nm, badge, info, cnt, actBtn);
      dockerList.appendChild(row);
    });
  }

  /* 最近活跃项目（按 git 提交日期） */
  const recent = projects
    .filter(p => p.git)
    .sort((a, b) => (b.git.date || '').localeCompare(a.git.date || ''))
    .slice(0, 8);
  const recentList = $('#recentList');
  recentList.replaceChildren();
  setText($('#recentSecCount'), recent.length ? String(recent.length) : '');
  if (!recent.length) {
    const empty = el('div', 'empty-line');
    empty.textContent = getLang() === 'en' ? 'No Git commits recorded' : '暂无 git 提交记录';
    recentList.appendChild(empty);
  } else {
    recent.forEach(p => {
      const row = el('div', 'dyn-row');
      const iconBox = el('span', 'dyn-ico');
      iconBox.appendChild(icon('folder-git-2', 13));
      const nm = el('span', 'dyn-name');
      nm.textContent = p.name;
      nm.title = p.path;
      const info = el('span', 'dyn-info mono');
      info.textContent = (p.git.date || '') + ' · ' + (p.git.hash || '');
      const go = el('button', 'btn btn-mini');
      go.type = 'button';
      go.textContent = t('browse');
      go.addEventListener('click', () => {
        const files = document.querySelector('.nav-btn[data-view="files"]');
        if (files) files.click();
        if (window.__openProjectPath) window.__openProjectPath(p.path);
      });
      row.append(iconBox, nm, info, go);
      recentList.appendChild(row);
    });
  }

  state.lastUpdate = Date.now();
}

export function fmtSize(n) {
  if (n == null || isNaN(n)) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  for (const u of units) {
    v /= 1024;
    if (v < 1024 || u === 'TB') return v.toFixed(1) + ' ' + u;
  }
  return n + ' B';
}
