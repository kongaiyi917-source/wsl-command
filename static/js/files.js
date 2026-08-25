'use strict';
/* ============================================================
   files.js — 文件浏览视图：项目树 + 文件列表 + 预览抽屉
              + 上传/下载/删除/三态锁/回收站
   ============================================================ */
import { $, el, setText, setChildren, state, icon, escapeHtml,
  openLayer, closeLayer, toast, act, post, truncateMiddle } from './core.js';
import { t, getLang } from './i18n.js';
import { fmtSize } from './overview.js';
import { openDrawer, setDrawerHtml, closeDrawer } from './widgets.js';
import { openConfirm } from './overlays.js';

const fileTree = $('#fileTree'), fileCrumbs = $('#fileCrumbs'),
  fileList = $('#fileList'), fileEmpty = $('#fileEmpty');

let currentPath = null;
let loadSeq = 0;             // 目录加载序号：只允许最后一次导航的响应落地渲染
const treeOpen = new Set();   // 已展开的目录路径
const loadedDirs = new Set(); // 已加载过子项（懒加载缓存）
const dirCache = new Map();   // path -> 目录数据
let showHidden = localStorage.getItem('dsh-show-hidden') !== '0';  // 默认显示隐藏

const homeOf = () => (state.data && state.data.home) || '~';

/* 请求参数：显示隐藏 */
const treeQuery = (path) => '/api/tree?path=' + encodeURIComponent(path) +
  (showHidden ? '&show_hidden=1' : '');

/* ---------------- 工具栏（显示隐藏开关 + 刷新） ---------------- */
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
  /* 显示隐藏开关（放在项目树面板标题栏） */
  const toggle = $('#showHiddenToggle');
  if (toggle) {
    toggle.checked = showHidden;
    toggle.addEventListener('change', () => {
      showHidden = toggle.checked;
      localStorage.setItem('dsh-show-hidden', showHidden ? '1' : '0');
      /* 清缓存重新加载 */
      loadedDirs.clear();
      dirCache.clear();
      currentPath = null;
      renderFiles(state.data);
    });
  }
  const refreshBtn = $('#fileRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadedDirs.clear();
      dirCache.clear();
      renderFiles(state.data);
    });
  }
  /* 上传 */
  const uploadBtn = $('#uploadBtn');
  const uploadInput = $('#uploadInput');
  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', () => {
      uploadFiles(uploadInput.files);
      uploadInput.value = '';
    });
  }
  /* 新建文件夹 */
  const mkdirBtn = $('#mkdirBtn');
  if (mkdirBtn) mkdirBtn.addEventListener('click', openMkdir);
  const mkdirOk = $('#mkdirOk');
  if (mkdirOk) mkdirOk.addEventListener('click', doMkdir);
  const mkdirCancel = $('#mkdirCancel');
  if (mkdirCancel) mkdirCancel.addEventListener('click', () => closeLayer($('#mkdirMask')));
  const mkdirInput = $('#mkdirInput');
  if (mkdirInput) mkdirInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') doMkdir();
  });

  /* 回收站 */
  const trashBtn = $('#trashBtn');
  if (trashBtn) trashBtn.addEventListener('click', openTrash);
  const trashEmptyBtn = $('#trashEmpty');
  if (trashEmptyBtn) trashEmptyBtn.addEventListener('click', emptyTrash);
  const trashCloseBtn = $('#trashClose');
  if (trashCloseBtn) trashCloseBtn.addEventListener('click', () => closeLayer($('#trashMask')));

  /* 拖拽上传（仅在文件视图内生效）；多重保险确保遮罩绝不挂死 */
  const filesView = $('#view-files');
  const dropMask = $('#dropMask');
  const showMask = () => { if (dropMask) dropMask.hidden = false; };
  const hideMask = () => { if (dropMask) dropMask.hidden = true; };
  if (filesView && dropMask) {
    document.addEventListener('dragenter', e => {
      if (!e.dataTransfer || state.view !== 'files') return;
      if ([...e.dataTransfer.types].includes('Files')) showMask();
    });
    document.addEventListener('dragover', e => {
      if (state.view === 'files' && dropMask && !dropMask.hidden) e.preventDefault();
    });
    /* 离开文档（relatedTarget 为空/不在文档内）才隐藏；元素间移动不误关 */
    document.addEventListener('dragleave', e => {
      const rel = e.relatedTarget;
      if (!rel || rel === document || rel === window ||
          !(rel instanceof Node) || !document.contains(rel)) hideMask();
    });
    /* 任何 drop 都先关遮罩，再决定是否上传 */
    document.addEventListener('drop', e => {
      if (state.view === 'files') e.preventDefault();
      hideMask();
      if (state.view === 'files' && e.dataTransfer && e.dataTransfer.files.length) {
        uploadFiles(e.dataTransfer.files);
      }
    });
    /* 兜底：拖拽结束 / Esc 键 强制隐藏 */
    document.addEventListener('dragend', hideMask);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') hideMask();
    });
  }
}

/* ---------------- 项目树 ---------------- */
function renderTree() {
  fileTree.replaceChildren();
  const home = homeOf();
  const projects = (state.data && state.data.projects) || [];

  const isEn = getLang() === 'en';
  const homeRow = treeRow(home, '🏠', isEn ? '~ (Home Directory)' : '~ (家目录)', true);
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
          const r = await fetch(treeQuery(path));
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
  const seq = ++loadSeq;      /* 并发守卫：旧请求的响应直接丢弃 */
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
      const r = await fetch(treeQuery(path));
      d = await r.json();
      if (seq !== loadSeq) return;   /* 期间已导航到别处 */
      dirCache.set(path, d);
      loadedDirs.add(path);
    } catch (e) {
      if (seq !== loadSeq) return;
      fileEmpty.hidden = false;
      fileEmpty.querySelector('p').textContent = '无法读取目录';
      return;
    }
  }
  if (seq !== loadSeq) return;
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
    row.dataset.key = item.path;
    const title = el('span', 'c-title');
    const nm = el('span', 'c-cmd' + (isDir ? ' dir-name' : ''));
    nm.textContent = item.name;
    const sub = el('span', 'c-cmd-sub mono');
    sub.textContent = (isDir ? (getLang() === 'en' ? 'Directory' : '目录')
                            : (getLang() === 'en' ? 'File' : '文件'));
    if (item.lock !== 'none') {
      const tag = el('span', 'lock-tag lock-' + item.lock);
      tag.textContent = item.lock === 'hard' ? '🔒' : '🔐';
      tag.title = item.lock === 'hard' ? t('lockedHard') : t('lockedByYou');
      sub.appendChild(tag);
    }
    title.append(nm, sub);
    const size = el('span', 'c-fsize mono');
    size.textContent = isDir ? '—' : fmtSize(item.size);
    const mtime = el('span', 'c-fmtime mono');
    mtime.textContent = fmtDateTime(item.mtime);
    const actBox = el('span', 'c-act');

    /* 下载（文件直接下载，文件夹打包为 ZIP 下载） */
    const bDl = el('button', 'ibtn');
    bDl.type = 'button';
    bDl.title = isDir ? t('downloadZip') : t('download');
    bDl.setAttribute('aria-label', bDl.title);
    bDl.appendChild(icon('download', 14));
    bDl.addEventListener('click', e => { e.stopPropagation(); downloadItem(item); });
    actBox.appendChild(bDl);

    /* 三态锁：hard 红锁无操作 / soft 蓝锁可解锁 / none 灰锁可锁定 */
    const bLock = el('button', 'ibtn b-lock');
    bLock.type = 'button';
    bLock.dataset.lock = item.lock;
    bLock.innerHTML = lockSvg(item.lock);
    if (item.lock === 'hard') {
      bLock.disabled = true;
      bLock.title = t('lockedHard');
    } else {
      bLock.title = item.lock === 'soft' ? t('unlockTip') : t('lockTip');
      bLock.addEventListener('click', e => { e.stopPropagation(); toggleLock(item); });
    }
    actBox.appendChild(bLock);

    /* 复制路径 */
    const bCopy = el('button', 'ibtn');
    bCopy.type = 'button';
    bCopy.title = t('copyPath');
    bCopy.setAttribute('aria-label', t('copyPath'));
    bCopy.appendChild(icon('copy', 14));
    bCopy.addEventListener('click', e => {
      e.stopPropagation();
      window.__copyText(item.path);
    });
    actBox.appendChild(bCopy);

    /* 删除（硬锁/软锁禁用，防止误删） */
    const bDel = el('button', 'ibtn b-del');
    bDel.type = 'button';
    bDel.title = item.lock === 'hard' ? t('lockedHard')
               : item.lock === 'soft' ? t('lockedByYou') : t('delete');
    bDel.setAttribute('aria-label', bDel.title);
    bDel.appendChild(icon('trash-2', 14));
    bDel.disabled = item.lock !== 'none';
    if (item.lock === 'none') {
      bDel.addEventListener('click', e => { e.stopPropagation(); askDelete([item]); });
    }
    actBox.appendChild(bDel);

    row.append(title, size, mtime, actBox);

    row.addEventListener('click', () => {
      if (isDir) loadDir(item.path);
      else togglePreview(item.path);
    });
    return row;
  }

  render();
  updatePreviewHighlight();
}

/* 锁图标（Lucide lock / lock-open，颜色由 CSS 按 lock 状态控制） */
function lockSvg(state) {
  const base = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  const body = state === 'none'
    ? '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'
    : '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
  return base + body + '</svg>';
}

/* ---------------- 文件操作：下载 / 删除 / 锁定 / 上传 / 回收站 ---------------- */

function downloadItem(item) {
  const isDir = item.is_dir === true || item.type === 'dir';
  const a = document.createElement('a');
  a.href = '/api/download?path=' + encodeURIComponent(item.path);
  a.download = isDir ? (item.name + '.zip') : item.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function toggleLock(item) {
  const target = item.lock !== 'soft';
  const res = await act(post('/api/file/lock', { path: item.path, locked: target }));
  if (res && res.ok !== false) {
    toast(target ? (getLang() === 'en' ? 'Locked' : '已锁定')
                 : (getLang() === 'en' ? 'Unlocked' : '已解锁'));
    reloadDir();
  }
}

async function askDelete(items) {
  const isEn = getLang() === 'en';
  let entries = [];
  try {
    const r = await post('/api/file/stat', { paths: items.map(x => x.path) });
    entries = (r && r.entries) || [];
  } catch (e) { /* 统计失败则直接提示 */ }
  const deletable = entries.filter(e => e.lock === 'none');
  const blocked = entries.length - deletable.length;
  if (!deletable.length) {
    toast(isEn ? 'All selected items are protected' : '所选项目均受保护，无法删除');
    return;
  }
  const totalFiles = deletable.reduce((s, e) => s + (e.files || (e.is_dir ? 0 : 1)), 0);
  const totalSize = deletable.reduce((s, e) => s + e.size, 0);
  const names = deletable.map(e => e.name).join('、');
  const dirCount = deletable.filter(e => e.is_dir).length;
  const warn = dirCount
    ? '<div class="confirm-detail">' +
      (isEn ? 'Will delete ' : '将删除 ') + '<b>' + totalFiles.toLocaleString() + '</b>' +
      (isEn ? ' files / ' : ' 个文件 / ') + '<b>' + fmtSize(totalSize) + '</b>' +
      (blocked ? (isEn ? ' (' + blocked + ' protected skipped)' : '（' + blocked + ' 项受保护已跳过）') : '') +
      '</div>'
    : (blocked ? '<div class="confirm-detail">' + (isEn ? blocked + ' protected item(s) skipped' : blocked + ' 项受保护已跳过') + '</div>' : '');
  openConfirm({
    title: isEn ? 'Delete Confirmation' : '删除确认',
    bodyHtml: '<b>' + escapeHtml(names) + '</b>' + warn,
    okText: t('delete'),
    tone: 'danger',
    checkLabel: t('permanentlyDelete'),
    onOk: async (permanent) => {
      const res = await act(post('/api/file/delete', {
        paths: deletable.map(e => e.path), permanent,
      }));
      if (res && res.ok !== false) {
        const n = (res.trashed || 0) + (res.removed || 0);
        toast(isEn ? 'Deleted ' + n + ' item(s)' : '已删除 ' + n + ' 项' +
          (permanent ? '' : (isEn ? ' (in Trash)' : '（已入回收站）')));
        reloadDir();
        renderTree();
      }
    },
  });
}

function reloadDir() {
  if (!currentPath) return;
  dirCache.delete(currentPath);
  loadDir(currentPath);
}

/* ---------------- 上传（XHR 逐文件 + 进度） ---------------- */

function uploadFiles(fileList) {
  if (!currentPath) return;
  const files = [...fileList];
  if (!files.length) return;
  const isEn = getLang() === 'en';
  const status = $('#uploadStatus');
  let i = 0, failed = 0;
  const next = () => {
    if (i >= files.length) {
      if (status) status.textContent = '';
      toast(failed
        ? (isEn ? 'Uploaded ' + (files.length - failed) + '/' + files.length : '上传完成 ' + (files.length - failed) + '/' + files.length + ' 个')
        : (isEn ? 'All files uploaded' : '全部上传完成'));
      reloadDir();
      renderTree();
      return;
    }
    const f = files[i++];
    uploadOne(f, status, () => next(), () => { failed++; next(); });
  };
  next();
}

function uploadOne(file, status, onDone, onFail) {
  const isEn = getLang() === 'en';
  const run = (overwrite) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?path=' + encodeURIComponent(currentPath) +
      '&name=' + encodeURIComponent(file.name) + (overwrite ? '&overwrite=1' : ''));
    if (state.token) xhr.setRequestHeader('X-Auth-Token', state.token);
    xhr.upload.onprogress = e => {
      if (status && e.lengthComputable) {
        status.textContent = (isEn ? 'Uploading ' : '上传中 ') + file.name + ' ' +
          Math.round(e.loaded / e.total * 100) + '%';
      }
    };
    xhr.onload = () => {
      if (xhr.status === 409) {
        openConfirm({
          title: t('fileExists'),
          bodyHtml: '<b>' + escapeHtml(file.name) + '</b>' +
            (isEn ? ' already exists. Overwrite?' : ' 已存在，是否覆盖？'),
          okText: isEn ? 'Overwrite' : '覆盖',
          tone: 'danger',
          onOk: () => run(true),
        });
        return;
      }
      if (xhr.status >= 400) {
        let msg = 'HTTP ' + xhr.status;
        try { msg = (JSON.parse(xhr.responseText) || {}).error || msg; } catch (e) { /* 忽略 */ }
        toast(msg);
        onFail();
        return;
      }
      onDone();
    };
    xhr.onerror = () => { toast(isEn ? 'Upload failed' : '上传失败'); onFail(); };
    xhr.send(file);
  };
  run(false);
}

/* ---------------- 回收站 ---------------- */

async function openTrash() {
  try {
    const r = await fetch('/api/trash');
    const d = await r.json();
    renderTrashList(d.items || []);
  } catch (e) {
    $('#trashList').replaceChildren();
  }
  openLayer($('#trashMask'), $('#trashClose'));
}

function renderTrashList(items) {
  const isEn = getLang() === 'en';
  const list = $('#trashList');
  list.replaceChildren();
  if (!items.length) {
    const empty = el('p', 'trash-empty');
    empty.textContent = isEn ? 'Trash is empty' : '回收站是空的';
    list.appendChild(empty);
    return;
  }
  for (const it of items) {
    const row = el('div', 'trash-item');
    const info = el('div', 'trash-info');
    const nm = el('div', 'trash-name');
    nm.textContent = it.is_dir ? '📁 ' : '📄 ';
    nm.append(document.createTextNode((it.orig_path || '').split('/').pop() || it.trash_name));
    const meta = el('div', 'trash-meta mono');
    meta.textContent = (it.orig_path || '').replace(/^\/home\/[^/]+/, '~') + ' · ' +
      fmtDateTime(it.deleted_at) + ' · ' + (it.is_dir ? (it.files || 0) + ' files / ' : '') + fmtSize(it.size);
    info.append(nm, meta);
    const actBox = el('div', 'trash-acts');
    const bRestore = el('button', 'btn btn-sm');
    bRestore.type = 'button';
    bRestore.textContent = isEn ? 'Restore' : '恢复';
    bRestore.onclick = async () => {
      const res = await act(post('/api/trash/restore', { name: it.trash_name }));
      if (res && res.ok !== false) {
        toast(isEn ? 'Restored' : '已恢复');
        const r2 = await fetch('/api/trash');
        renderTrashList(((await r2.json()).items) || []);
        reloadDir();
        renderTree();
      }
    };
    actBox.appendChild(bRestore);
    row.append(info, actBox);
    list.appendChild(row);
  }
}

async function emptyTrash() {
  const isEn = getLang() === 'en';
  openConfirm({
    title: isEn ? 'Empty Trash' : '清空回收站',
    bodyHtml: isEn ? 'All trashed files will be permanently deleted.'
                   : '回收站内所有文件将被彻底删除，无法恢复。',
    okText: isEn ? 'Empty' : '清空',
    tone: 'danger',
    onOk: async () => {
      const res = await act(post('/api/trash/empty', {}));
      if (res && res.ok !== false) {
        toast(isEn ? 'Trash emptied' : '回收站已清空');
        renderTrashList([]);
      }
    },
  });
}

/* ---------------- 文件预览（点击切换/再点关闭） ---------------- */
let previewingPath = null;

function updatePreviewHighlight() {
  const drawer = $('#logDrawer');
  const open = !!(drawer && drawer.classList.contains('open'));
  const current = open ? previewingPath : null;
  for (const row of document.querySelectorAll('#fileList .file-tr')) {
    if (current && row.dataset.key === current) {
      row.classList.add('is-previewing');
    } else {
      row.classList.remove('is-previewing');
    }
  }
}

function togglePreview(path) {
  const drawer = $('#logDrawer');
  const open = !!(drawer && drawer.classList.contains('open'));
  /* 点当前正在预览的文件 = 关闭抽屉 */
  if (open && previewingPath === path) {
    closeDrawer();
    previewingPath = null;
    updatePreviewHighlight();
    return;
  }
  /* 抽屉关着（或点在别的文件）= 打开/切换内容 */
  previewingPath = path;
  updatePreviewHighlight();
  previewFile(path);
}

async function previewFile(path) {
  openDrawer(path.replace(/^\/home\/[^/]+/, '~'), '加载中…');
  updatePreviewHighlight();
  try {
    const r = await fetch('/api/file?path=' + encodeURIComponent(path));
    const d = await r.json();
    if (d.error) {
      setDrawerHtml('预览', '<div class="preview-msg">' + escapeHtml(d.error) + '</div>');
      return;
    }
    if (d.image) {
      /* 图片：渲染 <img>，URL 走 download 接口（img 标签不受 attachment 头影响） */
      setDrawerHtml('预览', '<div class="preview-image-box">' +
        '<img src="/api/download?path=' + encodeURIComponent(path) + '" alt="预览图片" loading="eager">' +
        '<div class="preview-meta mono">' + escapeHtml(d.mime || 'image') + ' · ' + fmtSize(d.size) + '</div>' +
        '</div>');
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

/* ---------------- 新建文件夹 ---------------- */
function openMkdir() {
  if (!currentPath) return;
  $('#mkdirInput').value = '';
  openLayer($('#mkdirMask'), $('#mkdirInput'));
  $('#mkdirInput').focus();
}

async function doMkdir() {
  const name = $('#mkdirInput').value.trim();
  if (!name) {
    toast(getLang() === 'en' ? 'Folder name is required' : '请输入文件夹名称');
    return;
  }
  const res = await act(post('/api/file/mkdir', { path: currentPath, name }));
  if (res && res.ok !== false) {
    toast(getLang() === 'en' ? 'Folder created' : '文件夹已创建');
    closeLayer($('#mkdirMask'));
    reloadDir();
  } else if (res && res.error) {
    toast(res.error === 'exists'
      ? (getLang() === 'en' ? 'Already exists' : '已存在同名文件夹')
      : res.error);
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
let lastLang = getLang();
export function renderFiles(data) {
  /* 兕底：不在文件视图时，拖拽遮罩强制隐藏（防任何路径挂死） */
  if (!data || state.view !== 'files') {
    const mask = $('#dropMask');
    if (mask && !mask.hidden) mask.hidden = true;
    return;
  }
  /* 首次进入：渲染树并打开家目录 */
  renderTree();
  if (getLang() !== lastLang) {
    lastLang = getLang();
    if (currentPath) reloadDir();   /* 语言切换后重绘当前目录的行内文案 */
  }
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
