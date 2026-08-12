/**
 * 登录设备记录页：
 *  - 卡片宽度撑满界面区域 70%（devices-shell 宽 70%）
 *  - 虚拟滚动懒加载：只渲染可视区域 + 前后缓存窗口，向下滑实时渲染新卡片并带翻折动画
 *  - 滚动阻尼回弹：顶部/底部过冲后自动归位（transform 合成器，不触发重排）
 *  - 底部文字提示「=^.^= 已经到底啦～ =^.^=」，跟随回弹区域移动
 *  - 兼容鼠标滚轮 / 手机触摸 / 鼠标左键按住拖动（拖动时禁止选中文本）
 *  - 右侧纵向滑动条
 */
import { switchPage } from './pages.js';
import { getCurrentUser } from './user.js';
import { toast } from './utils.js';
import { openAuthModal } from './auth-ui.js';

const DVC_CARD_H = 76;      // 卡片高度
const DVC_GAP = 10;         // 卡片间距（不宜过宽）
const DVC_CACHE = 3;        // 可视区外缓存项数
const DVC_STAGGER = 100;    // 卡片翻折动画间隔 ms
const DVC_END_H = 40;       // 底部提示预留高度

const dvcClamp = (v, min, max) => Math.min(Math.max(v, min), max);

let dvcList = [];
let dvcPos = 0;
let dvcMax = 0;
let dvcH = 480;
let dvcVel = 0;
let dvcTicking = false;
let dvcRendered = new Map();   // index -> element
let dvcWin = { first: -1, last: -1 };

let scrollEl = null;
let listEl = null;
let endEl = null;
let barEl = null;
let thumbEl = null;

let pDrag = null;              // 鼠标拖动
let tStart = null;             // 触摸
let tLast = null;              // 触摸速度采样

export function initDevices() {
  scrollEl = document.getElementById('devicesScroll');
  if (!scrollEl) return;
  listEl = document.getElementById('devicesList');
  endEl = document.getElementById('devicesEnd');
  barEl = document.getElementById('devicesScrollbar');
  thumbEl = document.getElementById('devicesThumb');

  document.getElementById('devicesBackBtn').addEventListener('click', () => switchPage('profileSettings'));

  /* 鼠标滚轮 */
  scrollEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    dvcVel = 0;
    dvcPos += e.deltaY;
    startTicker();
  }, { passive: false });

  /* 手机触摸滑动 */
  scrollEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    dvcVel = 0;
    tStart = { y: e.touches[0].clientY, pos: dvcPos };
    tLast = { y: e.touches[0].clientY, t: performance.now() };
  }, { passive: false });
  scrollEl.addEventListener('touchmove', (e) => {
    if (!tStart) return;
    e.preventDefault();
    const y = e.touches[0].clientY;
    const now = performance.now();
    const dt = Math.max(1, now - tLast.t);
    tLast = { y, t: now };
    dvcVel = ((tLast.y - tStart.y - (dvcPos - tStart.pos)) / dt) * 0.0003;
    dvcPos = tStart.pos - (y - tStart.y);
    startTicker();
  }, { passive: false });
  scrollEl.addEventListener('touchend', () => {
    if (!tStart) return;
    tStart = null;
  }, { passive: false });

  /* 鼠标左键按住拖动（阻止选中文本） */
  scrollEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target.closest('button')) return;
    e.preventDefault();
    dvcVel = 0;
    pDrag = { y: e.clientY, pos: dvcPos, t: performance.now() };
  });
  window.addEventListener('pointermove', (e) => {
    if (!pDrag || e.pointerType !== 'mouse') return;
    const now = performance.now();
    const dt = Math.max(1, now - pDrag.t);
    pDrag.t = now;
    dvcVel = ((e.clientY - pDrag.y - (dvcPos - pDrag.pos)) / dt) * 0.0003;
    dvcPos = pDrag.pos - (e.clientY - pDrag.y);
    startTicker();
  });
  window.addEventListener('pointerup', () => {
    pDrag = null;
  });

  /* 右侧滚动条拖动 */
  initScrollbar();
}

/* 打开设备记录页：读取当前用户设备历史，进入页面并初始化滚动 */
export function openDevicesPage() {
  const user = getCurrentUser();
  if (!user) {
    toast('请先登录');
    openAuthModal();
    return;
  }
  dvcList = (user.devices || []).map((d) => ({
    ip: String(d.ip || '未知IP'),
    ua: String(d.ua || ''),
    time: Number(d.time) || 0,
    action: String(d.action || 'login'),
  }));
  switchPage('devices');
  resetDevices();
}

/* 测试 / 调试钩子：直接滚动到指定偏移（像素） */
export function devicesScrollTo(pos) {
  if (!scrollEl) return;
  dvcPos = dvcClamp(pos, -320, dvcMax + 320);
  startTicker();
}

function resetDevices() {
  dvcPos = 0;
  dvcVel = 0;
  dvcRendered.clear();
  dvcWin = { first: -1, last: -1 };
  listEl.innerHTML = '';
  const sh = scrollEl.clientHeight || Math.max(300, window.innerHeight * 0.6);
  dvcH = sh;
  const step = DVC_CARD_H + DVC_GAP;
  const total = dvcList.length ? dvcList.length * step - DVC_GAP + DVC_END_H : 0;
  listEl.style.height = total + 'px';
  endEl.style.top = (dvcList.length ? dvcList.length * step - DVC_GAP + 6 : 0) + 'px';
  dvcMax = Math.max(0, total - dvcH);
  startTicker();
}

/* rAF 主循环：惯性 + 阻尼回弹 + 渲染窗口 + 滚动条 */
function startTicker() {
  if (dvcTicking) return;
  dvcTicking = true;
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.max(0, Math.min(32, now - last));
    last = now;
    if (dvcVel) {
      dvcPos += dvcVel * dt;
      dvcVel *= Math.pow(0.001, dt / 1000);
      if (Math.abs(dvcVel) < 0.02) dvcVel = 0;
    }
    if (dvcPos < 0 || dvcPos > dvcMax) {
      const t = dvcClamp(dvcPos, 0, dvcMax);
      dvcPos += (t - dvcPos) * Math.min(1, 0.16 * (dt / 16));
      if (Math.abs(t - dvcPos) < 0.4) dvcPos = t;
    }
    applyTransform();
    renderWindow();
    updateScrollbar();
    if (dvcVel || dvcPos < 0 || dvcPos > dvcMax) {
      requestAnimationFrame(tick);
    } else {
      dvcTicking = false;
    }
  };
  requestAnimationFrame(tick);
}

/* 边界阻尼回弹：过冲量压缩 35%，仅 transform 移动列表 */
function applyTransform() {
  const over = dvcPos < 0 ? dvcPos : dvcPos > dvcMax ? dvcPos - dvcMax : 0;
  const base = dvcClamp(dvcPos, 0, dvcMax);
  const off = base + over * 0.35;
  listEl.style.transform = 'translate3d(0,' + (-off) + 'px,0)';
  /* 触底提示：未触底隐藏，触底显示，跟随列表一起被 transform 移动 */
  const atEnd = dvcMax > 0 && dvcPos >= dvcMax - 2;
  endEl.classList.toggle('visible', atEnd);
}

/* 虚拟滚动窗口：可视区前后各缓存 DVC_CACHE 项 */
function renderWindow() {
  const step = DVC_CARD_H + DVC_GAP;
  const first = Math.max(0, Math.floor((dvcPos - DVC_CACHE * step) / step));
  const last = Math.min(dvcList.length - 1, Math.ceil((dvcPos + dvcH + DVC_CACHE * step) / step));
  if (first === dvcWin.first && last === dvcWin.last) return;
  dvcWin = { first, last };
  for (let i = first; i <= last; i++) ensureCard(i);
  for (const [idx, el] of [...dvcRendered]) {
    if (idx < first || idx > last) {
      el.remove();
      dvcRendered.delete(idx);
    }
  }
}

/* 未渲染的项实时渲染，并叠加翻折入场动画（100ms 递增） */
function ensureCard(i) {
  if (dvcRendered.has(i)) return;
  const d = dvcList[i];
  if (!d) return;
  const el = document.createElement('article');
  el.className = 'device-card glass-card';
  el.style.top = i * (DVC_CARD_H + DVC_GAP) + 'px';
  el.style.animationDelay = ((i - dvcWin.first) % 8) * DVC_STAGGER + 'ms';
  el.classList.add('flip-in');
  el.innerHTML = cardHTML(d);
  el.addEventListener('animationend', function handler() {
    el.classList.remove('flip-in');
    el.style.animationDelay = '';
    el.removeEventListener('animationend', handler);
  });
  listEl.appendChild(el);
  dvcRendered.set(i, el);
}

function cardHTML(d) {
  const time = d.time ? fmtTime(d.time) : '—';
  const ua = cleanUA(d.ua);
  const action = d.action === 'login' ? '登录' : esc(d.action || '访问');
  const cls = action === '登录' ? 'ok' : 'warn';
  return `
    <span class="device-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
    </span>
    <div class="device-main">
      <strong>${esc(d.ip)}</strong>
      <span class="device-ua">${esc(ua) || '未知设备'}</span>
      <span class="device-time">${time}</span>
    </div>
    <span class="device-badge ${cls}">${action}</span>`;
}

function cleanUA(ua) {
  const m = String(ua || '').replace(/^\(([^;]+);.*\)$/, '$1').trim();
  return m.slice(0, 40);
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- 右侧纵向滑动条 ---------- */
function initScrollbar() {
  if (!barEl || !thumbEl) return;
  let dragging = null;
  thumbEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = { y: e.clientY, pos: dvcPos };
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const trackH = barEl.clientHeight || 200;
    const th = parseFloat(thumbEl.style.height) || 30;
    const ratio = (e.clientY - dragging.y) / Math.max(1, trackH - th);
    dvcPos = dragging.pos + ratio * dvcMax;
    dvcVel = 0;
    startTicker();
  });
  window.addEventListener('pointerup', () => {
    dragging = null;
  });
}

function updateScrollbar() {
  if (!barEl || !thumbEl) return;
  if (dvcMax <= 0) {
    barEl.classList.remove('visible');
    return;
  }
  barEl.classList.add('visible');
  const trackH = barEl.clientHeight || 200;
  const th = Math.max(28, (dvcH * dvcH) / (dvcMax + dvcH));
  thumbEl.style.height = th + 'px';
  const maxTh = Math.max(0, trackH - th);
  const ratio = dvcClamp(dvcPos, 0, dvcMax) / dvcMax;
  thumbEl.style.transform = 'translate3d(0,' + ratio * maxTh + 'px,0)';
}
