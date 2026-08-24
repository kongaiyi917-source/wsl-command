'use strict';
/* ============================================================
   overlays.js — 弹层：危险操作确认
   （原项目启动台/端口诊断/应用编辑等弹层随视图改造移除）
   ============================================================ */
import { $, el, setChildren, openLayer, closeLayer } from './core.js';
import { t } from './i18n.js';

const confirmMask = $('#confirmMask');

export function openConfirm({ title = '确认', bodyHtml = '', okText = '确认',
  showForce = false, tone = 'danger', onOk = null, checkLabel = '' } = {}) {
  setChildren($('#confirmTitle'), document.createTextNode(title));
  const body = $('#confirmBody');
  body.replaceChildren();
  if (bodyHtml) {
    const wrap = el('div', 'confirm-html');
    wrap.innerHTML = bodyHtml;
    body.appendChild(wrap);
  }
  /* 可选勾选行：showForce 用默认文案（强制结束），checkLabel 自定义文案 */
  const forceRow = $('#forceRow');
  const showCheck = showForce || !!checkLabel;
  forceRow.hidden = !showCheck;
  const forceCheck = $('#forceCheck');
  forceCheck.checked = false;
  if (showCheck) {
    const span = forceRow.querySelector('span');
    if (span) span.textContent = checkLabel || (showForce ? t('forceKill') : '');
  }
  const ok = $('#confirmOk');
  ok.textContent = okText;
  ok.classList.toggle('btn-stop', tone === 'danger');
  ok.classList.toggle('btn-accent', tone === 'accent');
  ok.onclick = () => {
    closeConfirm();
    if (onOk) onOk(showCheck ? forceCheck.checked : false);
  };
  $('#confirmCancel').onclick = closeConfirm;
  openLayer(confirmMask, $('#confirmCancel'));
}

export function closeConfirm() { closeLayer(confirmMask); }
