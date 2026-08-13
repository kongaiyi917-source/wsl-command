'use strict';
/* ============================================================
   files.js — 文件浏览视图：项目树 + 文件列表 + 预览抽屉
   ============================================================ */
import { $, el, setText, setChildren, state, icon, escapeHtml,
  openLayer, closeLayer, toast, act, truncateMiddle } from './core.js';
import { fmtSize } from './overview.js';
import { openDrawer, setDrawerHtml } from './widgets.js';

const fileTree = $('#fileTree'), fileCrumbs = $('#fileCrumbs'),
  fileList = $('#fileList'), fileEmpty = $('#fileEmpty');

let currentPath = null;
const treeOpen = new Set();   // 已展开的目录路径
const loadedDirs = new Set(); // 已加载过子项（懒加载缓存）
const dirCache = new Map();   // path -> 目录数据

const homeOf = () => (state.data && state.data.home) || '~';

/* ---------------- 项目树 ---------------- */
function renderTree() {
  fileTree.replaceChildren();
  const home = homeOf();
  const projects = (state.data && state.data.projects) || [];

  const homeRow = treeRow(home, '🏠', '~ (家目录)', true);
  fileTree.appendChild(homeRow);

  for (const p of projects) {
    const row = treeRow(p.path, '📁', p.name, true);
    if (p.running > 0) {
      const dot = el('span', 'status-dot running');
      row.appendChild(dot);
    }
    fileTree.appendChild(row);
  }
  /* 已展开子目录的懒加载 */
  for (const dir of [...treeOpen]) {
    if (!loadedDirs.has(dir)) continue;
    const data = dirCache.get(dir);
    if (!data) continue;
    const wrap = el('div', 'tree-children');
    for (const d of data.dirs) {
      const sub = treeRow(d.path, '📂', d.name, false);
      wrap.appendChild(sub);
    }
    const parentRow = [...fileTree.querySelectorAll('.tree-row[data-path]')]
      .find(r => r.dataset.path === dir);
    if (parentRow) parentRow.after(wrap);
  }
}

function treeRow(path, glyph, label, isProject) {
  const row = el('div', 'tree-row' + (isProject ? ' tree-proj' : ''));
  row.dataset.path = path;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-label', label);
  const tw = el('span', 'tw');
  tw.textContent = treeOpen.has(path) ? '▾' : '▸';
  const g = el('span', 'tree-glyph');
  g.textContent = glyph;
  const nm = el('span', 'tname');
  nm.textContent = label;
  nm.title = path;
  row.append(tw, g, nm);

  row.addEventListener('click', async () => {
    /* 点击展开/收起（项目行可展开） */
    const isDir = row.dataset.path === path;
    if (isDir && treeOpen.has(path)) {
      treeOpen.delete(path);
    } else if (isDir && !treeOpen.has(path)) {
      treeOpen.add(path);
      if (!loadedDirs.has(path)) {
        try {
          const r = await fetch('/api/tree?path=' + encodeURIComponent(path));
          const d = await r.json();
          if (d.dirs) {
            dirCache.set(path, d);
            loadedDirs.add(path);
          }
        } catch { /* 忽略 */ }
      }
    }
    /* 总是打开该目录内容 */
    loadDir(path);
    renderTree();
    const self = fileTree.querySelector('.tree-row[data-path="' + CSS.escape(path) + '"]');
    if (self) {
      for (const r of fileTree.querySelectorAll('.tree-row')) r.classList.remove('active');
      self.classList.add('active');
    }
  });
  return row;
}

/* ---------------- 目录列表 ---------------- */
async function loadDir(path, initial) {
  currentPath = path;
  fileCrumbs.replaceChildren();
  fileList.replaceChildren();

  const home = homeOf();
  const rel = path === home ? '' : path.replace(home + '/', '').replace(home, '');
  const parts = rel ? rel.split('/') : [];
  /* 面包屑 */
  let acc = home;
  const homeCrumb = el('a', 'crumb');
  homeCrumb.textContent = '~';
  homeCrumb.dataset.path = home;
  fileCrumbs.appendChild(homeCrumb);
  for (const [i, part] of parts.entries()) {
    acc += '/' + part;
    const sep = el('span', 'crumb-sep');
    sep.textContent = '/';
    fileCrumbs.appendChild(sep);
    const crumb = el('a', 'crumb' + (i === parts.length - 1 ? ' here' : ''));
    crumb.textContent = part;
    crumb.dataset.path = acc;
    fileCrumbs.appendChild(crumb);
  }
  fileCrumbs.querySelectorAll('a.crumb').forEach(a => {
    a.addEventListener('click', () => loadDir(a.dataset.path));
  });

  let d = dirCache.get(path);
  if (!d) {
    try {
      const r = await fetch('/api/tree?path=' + encodeURIComponent(path));
      d = await r.json();
      dirCache.set(path, d);
      loadedDirs.add(path);
    } catch (e) {
      fileEmpty.hidden = false;
      fileEmpty.querySelector('p').textContent = '无法读取目录';
      return;
    }
  }
  if (d.dirs) dirCache.set(path, d);

  const render = () => {
    fileList.replaceChildren();
    fileEmpty.hidden = (d.dirs.length + d.files.length) > 0;
    for (const dir of d.dirs) {
      fileList.appendChild(fileRow(dir, true));
    }
    for (const f of d.files) {
      fileList.appendChild(fileRow(f, false));
    }
  };

  function fileRow(item, isDir) {
    const row = el('div', 'tr file-tr');
    const title = el('span', 'c-title');
    const nm = el('span', 'c-cmd' + (isDir ? ' dir-name' : ''));
    nm.textContent = item.name;
    const sub = el('span', 'c-cmd-sub mono');
    sub.textContent = isDir ? '目录' : '文件';
    title.append(nm, sub);
    const size = el('span', 'c-fsize mono');
    size.textContent = isDir ? '—' : fmtSize(item.size);
    const mtime = el('span', 'c-fmtime mono');
    mtime.textContent = fmtDateTime(item.mtime);
    const act = el('span', 'c-act');
    const bCopy = el('button', 'ibtn');
    bCopy.type = 'button';
    bCopy.title = '复制路径';
    bCopy.setAttribute('aria-label', '复制路径');
    bCopy.appendChild(icon('copy', 14));
    bCopy.addEventListener('click', e => {
      e.stopPropagation();
      window.__copyText(item.path);
    });
    act.appendChild(bCopy);
    row.append(title, size, mtime, act);

    row.addEventListener('click', () => {
      if (isDir) loadDir(item.path);
      else previewFile(item.path);
    });
    return row;
  }

  render();
}

/* ---------------- 文件预览 ---------------- */
async function previewFile(path) {
  openDrawer(path.replace(/^\/home\/[^/]+/, '~'), '加载中…');
  try {
    const r = await fetch('/api/file?path=' + encodeURIComponent(path));
    const d = await r.json();
    if (d.error) {
      setDrawerHtml('预览', '<div class="preview-msg">' + escapeHtml(d.error) + '</div>');
      return;
    }
    if (d.binary) {
      setDrawerHtml('预览', '<div class="preview-msg">二进制文件（' + fmtSize(d.size) +
        '），不支持文本预览</div>');
      return;
    }
    openDrawer(path.replace(/^\/home\/[^/]+/, '~'),
      (d.truncated ? '⚠ 文件较大，仅显示前 ' + fmtSize(d.size) + '\n\n' : '') + d.content);
  } catch (e) {
    setDrawerHtml('预览', '<div class="preview-msg">读取失败：' + escapeHtml(e.message) + '</div>');
  }
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return (sameDay ? '' : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ') +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/* ---------------- 对外 ---------------- */
export function renderFiles(data) {
  if (!data || state.view !== 'files') return;
  /* 首次进入：渲染树并打开家目录 */
  renderTree();
  if (!currentPath) loadDir(homeOf());
}

export function openProjectPath(path) {
  currentPath = null;  /* 强制刷新 */
  if (path) {
    /* 展开路径上的每一级目录，让树能直接看到 */
    const home = homeOf();
    let acc = home;
    const rel = path.replace(home + '/', '');
    const parts = rel.split('/').filter(Boolean);
    for (const part of parts) {
      acc += '/' + part;
      treeOpen.add(acc);
    }
    renderTree();
    loadDir(path);
  } else {
    loadDir(homeOf());
  }
}

export function filesInit() {
  if (filesInit._done) return;
  filesInit._done = true;
  window.__openProjectPath = openProjectPath;
  /* 抽屉复制按钮 */
  $('#drawerCopy').addEventListener('click', () => {
    if (currentPath) window.__copyText(currentPath);
  });
  $('#drawerCopyWin').addEventListener('click', () => {
    if (currentPath) {
      const winPath = window.__wslWinPath(currentPath);
      window.__copyText(winPath);
    }
  });
}
