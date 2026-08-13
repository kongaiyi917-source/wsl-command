'use strict';
/* ============================================================
   control.js — 项目启动 / 暂停 / 日志（受控进程管理）
   启停操作：确认询问 → 执行 → 按钮加载态（⋯ 处理中）
   ============================================================ */
import { post, toast, act, escapeHtml, state } from './core.js';
import { openConfirm } from './overlays.js';

const busySet = new Set();
export function isProjectBusy(path) { return busySet.has(path); }

/* 执行期间标记 busy 并立即刷新（按钮显示加载态），结束后恢复 */
async function withBusy(path, fn) {
  busySet.add(path);
  if (window.__poll) window.__poll();
  try {
    await fn();
  } finally {
    busySet.delete(path);
    if (window.__poll) window.__poll();
  }
}

function projectByPath(path) {
  return ((state.data && state.data.projects) || []).find(x => x.path === path);
}

/* ---------------- 启动 ---------------- */
export function startProject(path, name) {
  const pj = projectByPath(path);
  const label = name || (pj && pj.name) || path;
  const hasCmd = !!(pj && pj.cmd);
  openConfirm({
    title: '启动项目',
    bodyHtml: '是否启动 <b>' + escapeHtml(label) + '</b>？' +
      (hasCmd
        ? '<div class="confirm-detail">启动命令: ' + escapeHtml(pj.cmd) + '</div>'
        : '<div class="confirm-detail">该项目尚未配置启动命令，确认后将打开配置窗口。</div>'),
    okText: '启动',
    tone: 'accent',
    onOk: () => withBusy(path, async () => {
      const r = await act(post('/api/projects/start', { path }));
      if (r && r.ok !== false) {
        if (r.already) toast('该项目已在运行');
        else if (r.docker) toast('已启动容器: ' + r.docker.join(', '));
        else toast('已启动' + (r.cmd ? ': ' + r.cmd : ''));
      } else if (r && r.error) {
        toast(r.error);
        /* 没有可用命令：引导打开配置 */
        const { openLabelModal } = await import('./projects.js');
        openLabelModal(path);
      }
    }),
  });
}

/* ---------------- 停止（受控进程） ---------------- */
export function stopProject(path, name) {
  const pj = projectByPath(path);
  const label = name || (pj && pj.name) || path;
  openConfirm({
    title: '停止项目',
    bodyHtml: '是否停止 <b>' + escapeHtml(label) + '</b>？' +
      '<div class="confirm-detail">只停止由指挥中心启动的进程，你手动运行的进程不受影响。</div>',
    okText: '停止',
    tone: 'danger',
    onOk: () => withBusy(path, async () => {
      const r = await act(post('/api/projects/stop', { path }));
      if (r && r.ok !== false) toast('已停止');
    }),
  });
}

/* ---------------- 停止全部（含外部进程） ---------------- */
export function stopProjectAll(path, name, count) {
  const pj = projectByPath(path);
  const label = name || (pj && pj.name) || path;
  openConfirm({
    title: '停止项目全部进程',
    bodyHtml: '是否停止 <b>' + escapeHtml(label) + '</b> 的 <b>' +
      (count || '') + '</b> 个进程？' +
      '<div class="confirm-detail">包括你在终端手动启动的进程；指挥中心自身进程除外。</div>',
    okText: '全部停止',
    tone: 'danger',
    onOk: () => withBusy(path, async () => {
      const r = await act(post('/api/projects/stop-all', { path }));
      if (r && r.ok !== false) {
        toast(r.stopped ? '已停止 ' + r.stopped + ' 个进程' : '没有需要停止的进程');
      }
    }),
  });
}

/* ---------------- 项目日志 ---------------- */
export async function openProjectLogs(path) {
  const { openDrawer } = await import('./widgets.js');
  const title = '项目日志 · ' + path.replace(/^\/home\/[^/]+/, '~');
  openDrawer(title, '加载中…');
  try {
    const r = await fetch('/api/projects/logs?path=' + encodeURIComponent(path));
    const d = await r.json();
    openDrawer(title, (d.logs || []).join('\n') || '(暂无日志)');
  } catch (e) {
    openDrawer(title, '读取失败：' + e.message);
  }
}

/* ---------------- Docker 容器启停 ---------------- */
export function dockerStart(name) {
  act(post('/api/docker/start', { name }))
    .then(r => {
      if (r && r.ok !== false) {
        toast('容器 ' + name + ' 已启动');
        if (window.__poll) window.__poll();
      } else if (r && r.error) toast(r.error);
    });
}

export function dockerStop(name) {
  openConfirm({
    title: '停止容器',
    bodyHtml: '是否停止 Docker 容器 <b>' + escapeHtml(name) + '</b>？' +
      '<div class="confirm-detail">将执行 docker stop，容器内服务会终止。</div>',
    okText: '停止',
    tone: 'danger',
    onOk: () => {
      act(post('/api/docker/stop', { name }))
        .then(r => {
          if (r && r.ok !== false) {
            toast('容器 ' + name + ' 已停止');
            if (window.__poll) window.__poll();
          } else if (r && r.error) toast(r.error);
        });
    },
  });
}
