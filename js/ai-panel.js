/**
 * AI 球形助手（v2）：
 *  - 收起态：小球体（44px），可自由拖拽；松手后自动判断距左/右哪侧更近，
 *    从快到慢贴向侧壁（贴壁侧圆角取消成半圆）。
 *  - 拖拽过程中始终保持圆球形态（不做正方形/长方形）。
 *  - 双击展开：球先弹向屏幕中央（保持球）→ 球体原地膨胀放大成圆 →
 *    垂直拉长展开为面板（圆角平滑过渡），全程以“球”的形式展开。
 *  - 收起：严格按打开的逆序 —— 先减小高度（面板压回圆形）→ 再缩小宽度（圆缩回球体）→ 贴壁。
 *  - 定位使用 transform: translate3d，走 GPU 合成器，不触发重排。
 */
const ORB = 44;            // 球形尺寸（略小）
const PANEL_W = 340;       // 展开面板宽
const PANEL_H = 460;       // 展开面板高
const TOP = 76;            // 顶部留白（导航栏下方）
const MARGIN = 14;         // 侧边 / 底部留白

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

import { getConfig } from './github.js';
import { toast } from './utils.js';
import { getCurrentUser } from './user.js';

/* 会话内首次请求才注入 AI 守则；「新对话」按钮会重置 */
let aiSessionStarted = false;

export function initAiPanel() {
  const orb = document.getElementById('aiOrb');
  const fab = document.getElementById('aiOrbFab');
  const head = document.getElementById('aiPanelHead');
  const toggleBtn = document.getElementById('aiToggleBtn');
  const newChatBtn = document.getElementById('aiNewChatBtn');
  const input = document.getElementById('aiInput');
  const sendBtn = document.getElementById('aiSendBtn');
  const chat = document.getElementById('aiChat');
  if (!orb || !fab || !head || !chat) return;

  initWelcome(chat);

  /* ---------- 状态 ---------- */
  const state = {
    x: 0,
    y: 0,
    w: ORB,
    h: ORB,
    dockedSide: 'right',
    expanded: false,
    dragging: false,
    moved: false,
    animating: false,
  };
  let animId = 0;
  let dragStart = null;
  let taps = 0;
  let tapTimer = null;

  const setPos = (x, y) => {
    state.x = x;
    state.y = y;
    orb.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  };
  const setSize = (w, h) => {
    state.w = w;
    state.h = h;
    orb.style.width = w + 'px';
    orb.style.height = h + 'px';
  };

  const applyShape = () => {
    orb.classList.toggle('docked-right', !state.expanded && state.dockedSide === 'right');
    orb.classList.toggle('docked-left', !state.expanded && state.dockedSide === 'left');
  };

  /* ---------- 动画（rAF，x/y/w/h 同步过渡，从快到慢） ---------- */
  function animate(to, dur, ease, onDone) {
    cancelAnimationFrame(animId);
    const from = { x: state.x, y: state.y, w: state.w, h: state.h };
    state.animating = true;
    const t0 = performance.now();
    const step = (now) => {
      let t = (now - t0) / dur;
      if (t >= 1) t = 1;
      const e = ease ? ease(t) : t;
      setPos(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      setSize(from.w + (to.w - from.w) * e, from.h + (to.h - from.h) * e);
      if (t < 1) {
        animId = requestAnimationFrame(step);
      } else {
        state.animating = false;
        if (onDone) onDone();
      }
    };
    animId = requestAnimationFrame(step);
  }

  /* 松手贴边：判断距左/右哪侧近，从快到慢靠岸，贴壁侧变半圆 */
  function dock() {
    const side = state.x + ORB / 2 < window.innerWidth / 2 ? 'left' : 'right';
    const tx = side === 'right' ? window.innerWidth - ORB : 0;
    const ty = clamp(state.y, TOP, window.innerHeight - ORB - MARGIN);
    animate({ x: tx, y: ty, w: ORB, h: ORB }, 540, easeOutExpo, () => {
      state.dockedSide = side;
      applyShape();
    });
  }

  /* 展开面板拖拽后吸附回可视区域 */
  function snapIntoView() {
    const nx = clamp(state.x, MARGIN, window.innerWidth - state.w - MARGIN);
    const ny = clamp(state.y, TOP, window.innerHeight - state.h - MARGIN);
    if (nx !== state.x || ny !== state.y) {
      animate({ x: nx, y: ny, w: state.w, h: state.h }, 240, easeOutCubic);
    }
  }

  /* 展开：弹向中央(球) → 球体膨胀成圆 → 垂直拉长成面板 */
  function expand() {
    if (state.expanded || state.animating) return;
    state.expanded = true;
    orb.classList.add('expanding');

    const cx = (window.innerWidth - ORB) / 2;
    const cy = clamp(state.y, TOP, window.innerHeight - PANEL_H - MARGIN);
    let lx = cx;
    if (lx + PANEL_W > window.innerWidth - MARGIN) lx = window.innerWidth - PANEL_W - MARGIN;
    if (lx < MARGIN) lx = MARGIN;
    const top = clamp(state.y, TOP, window.innerHeight - PANEL_H - MARGIN);
    /* 面板中心：拉长阶段保持圆心与面板中心一致 */
    const pcx = lx + PANEL_W / 2;
    const pcy = top + PANEL_H / 2;
    /* 膨胀圆直径上限：不超过可视高度 */
    const growR = Math.min(PANEL_W, window.innerHeight - TOP - MARGIN * 2);

    /* 阶段1：球弹向中央（保持球体） */
    animate({ x: cx, y: cy, w: ORB, h: ORB }, 420, easeOutExpo, () => {
      /* 阶段2：球体膨胀成圆（w=h=growR，圆心与面板中心对齐，保持圆形） */
      const rx = pcx - growR / 2;
      const ry = pcy - growR / 2;
      animate({ x: rx, y: ry, w: growR, h: growR }, 380, easeOutCubic, () => {
        /* 阶段3：垂直拉长成面板（中心不变，圆角平滑过渡） */
        orb.classList.add('expanded');
        applyShape();
        animate({ x: lx, y: top, w: PANEL_W, h: PANEL_H }, 420, easeOutCubic, () => {
          orb.classList.remove('expanding');
        });
      });
    });
  }

  /* 收起：按打开逆序 —— 先减高度（压回圆）→ 再减宽度（缩回球）→ 贴壁 */
  function collapse() {
    if (!state.expanded || state.animating) return;
    state.expanded = false;
    orb.classList.remove('expanded');
    applyShape();

    const pcx = state.x + state.w / 2;
    const pcy = state.y + state.h / 2;

    /* 阶段1：高度减小 → 压成圆（w 保持 PANEL_W，h 回到 PANEL_W，圆心保持） */
    animate({ x: pcx - PANEL_W / 2, y: pcy - PANEL_W / 2, w: PANEL_W, h: PANEL_W }, 320, easeOutCubic, () => {
      /* 阶段2：宽度减小 → 缩回球体（圆心保持） */
      animate({ x: pcx - ORB / 2, y: pcy - ORB / 2, w: ORB, h: ORB }, 340, easeOutCubic, () => {
        /* 阶段3：贴回侧壁 */
        dock();
      });
    });
  }

  /* ---------- 拖拽 ---------- */
  const canStart = (target) =>
    state.expanded ? !!target.closest('#aiPanelHead') : !!target.closest('#aiOrbFab');

  fab.addEventListener('pointerdown', (e) => {
    if (!canStart(e.target)) return;
    onPointerDown(e);
  });
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.ai-head-actions')) return;
    if (!canStart(e.target)) return;
    onPointerDown(e);
  });

  function onPointerDown(e) {
    if (state.animating) return;
    if (e.pointerType !== 'mouse' && e.button) return;
    e.preventDefault();
    state.dragging = true;
    state.moved = false;
    dragStart = { px: e.clientX, py: e.clientY, ox: state.x, oy: state.y };
    orb.classList.add('dragging');
    /* 拖动中始终保持球体（移除贴壁半圆） */
    orb.classList.remove('docked-right', 'docked-left');
    try {
      orb.setPointerCapture(e.pointerId);
    } catch (err) {}
  }

  function onPointerMove(e) {
    if (!state.dragging) return;
    const dx = e.clientX - dragStart.px;
    const dy = e.clientY - dragStart.py;
    if (!state.moved && Math.hypot(dx, dy) > 4) state.moved = true;
    let nx = dragStart.ox + dx;
    let ny = dragStart.oy + dy;
    if (state.expanded) {
      nx = clamp(nx, MARGIN, window.innerWidth - state.w - MARGIN);
      ny = clamp(ny, TOP, window.innerHeight - state.h - MARGIN);
    } else {
      nx = clamp(nx, 0, window.innerWidth - state.w);
      ny = clamp(ny, TOP, window.innerHeight - state.h - MARGIN);
    }
    setPos(nx, ny);
  }

  function onPointerUp() {
    if (!state.dragging) return;
    state.dragging = false;
    orb.classList.remove('dragging');
    if (state.moved) {
      if (state.expanded) snapIntoView();
      else dock();
    } else {
      handleTap();
    }
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  /* 双击（或触摸连点）识别 */
  function handleTap() {
    taps += 1;
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      taps = 0;
    }, 280);
    if (taps === 2) {
      taps = 0;
      clearTimeout(tapTimer);
      if (state.expanded) collapse();
      else expand();
    }
  }

  /* 收起按钮 */
  toggleBtn.addEventListener('click', () => {
    if (state.expanded) collapse();
  });

  /* 窗口尺寸变化时防止跑出屏幕 */
  window.addEventListener('resize', () => {
    if (state.expanded) {
      snapIntoView();
    } else {
      const nx = clamp(state.x, 0, window.innerWidth - ORB);
      const ny = clamp(state.y, TOP, window.innerHeight - ORB - MARGIN);
      if (nx !== state.x || ny !== state.y) setPos(nx, ny);
      dock();
    }
  });

  /* ---------- 聊天 ---------- */
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    appendMsg(chat, text, 'user');
    input.value = '';
    const ai = getAiConfig();
    if (ai && ai.enabled && ai.url) {
      sendToApi(chat, ai, text);
    } else {
      setTimeout(() => appendMsg(chat, replyFor(text), 'ai'), 600);
    }
  };
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });

  /* 新对话：清空聊天、重置会话（下次请求重新注入守则） */
  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      aiSessionStarted = false;
      chat.innerHTML = '';
      initWelcome(chat);
      toast('已开启新对话');
    });
  }

  /* 初始化形态 */
  state.x = window.innerWidth - ORB;
  state.y = window.innerHeight - ORB - 96;
  setSize(ORB, ORB);
  setPos(state.x, state.y);
  applyShape();
}

function initWelcome(chat) {
  appendMsg(chat, '你好，我是 AI 助手，可以帮你生成函数或解析数学题目。', 'ai');
}

function appendMsg(chat, text, who) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function replyFor(text) {
  if (/函数|y\s*=|f\(x\)|sin|cos|tan|抛物线|直线|二次/.test(text)) {
    return '已收到函数生成指令：将为你绘制对应函数图像（演示环境，绘制结果将在主页面呈现）。';
  }
  if (/题目|解析|求解|方程|不等式|三角/.test(text)) {
    return '正在解析题目：已提取题干关键信息并生成分步解答（演示环境）。';
  }
  return '已收到指令，我会按「分步执行」流程处理（演示环境）。';
}

function getAiConfig() {
  try {
    const cfg = getConfig();
    return (cfg && cfg.ai) || null;
  } catch (e) {
    return null;
  }
}

/* 按配置真实请求 AI 接口：
 *  - 参数值支持 {{input}}（用户输入）、{{rules}}（守则，仅会话首次注入）、{{id}}（当前用户 ID）
 *  - 无 {{input}} 参数时自动补一个 input 参数
 *  - 无 {{rules}} 参数且守则非空时，守则拼接在用户输入内容前（仅首次）
 *  - GET：参数拼 URL query；POST：参数放 JSON body
 *  - 回复按点分路径提取（如 mag.answer），路径留空取响应根
 */
async function sendToApi(chat, ai, text) {
  const first = !aiSessionStarted;
  aiSessionStarted = true;
  const rules = first ? String(ai.rules || '') : '';
  const userId = (getCurrentUser() && getCurrentUser().id) || '';
  const rawParams = (ai.params || []).filter((p) => p.key).map((p) => ({ key: p.key, value: String(p.value || '') }));

  let message = text;
  const hasRulesParam = rawParams.some((p) => /\{\{rules\}\}/.test(p.value));
  if (first && rules && !hasRulesParam) message = rules + '\n' + text;

  const hasInputParam = rawParams.some((p) => /\{\{input\}\}/.test(p.value));
  const params = rawParams.map((p) => ({
    key: p.key,
    value: p.value.replace(/\{\{input\}\}/g, message).replace(/\{\{rules\}\}/g, rules).replace(/\{\{id\}\}/g, userId),
  }));
  if (!hasInputParam) params.push({ key: 'input', value: message });

  const method = ai.method === 'GET' ? 'GET' : 'POST';
  let url = ai.url;
  if (method === 'GET') {
    const qs = params.map((p) => encodeURIComponent(p.key) + '=' + encodeURIComponent(p.value)).join('&');
    if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
  }
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (method === 'POST') {
    const body = {};
    params.forEach((p) => {
      body[p.key] = p.value;
    });
    opts.body = JSON.stringify(body);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let textBody = '';
    try {
      textBody = await res.text();
    } catch (e) {}
    let data;
    try {
      data = JSON.parse(textBody);
    } catch (e) {
      data = textBody;
    }
    const answer = extractPath(data, ai.path);
    if (answer == null || String(answer).trim() === '') {
      throw new Error('未在响应中找到路径「' + (ai.path || '根') + '」');
    }
    appendMsg(chat, String(answer), 'ai');
  } catch (e) {
    const reason = e.name === 'AbortError' ? '请求超时（30s）' : e.message || '未知错误';
    appendMsg(chat, 'AI 请求失败：' + reason, 'ai');
  } finally {
    clearTimeout(timer);
  }
}

function extractPath(data, path) {
  if (!path) return data;
  const keys = String(path).split('.').filter(Boolean);
  let cur = data;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[k];
  }
  return cur;
}
