/**
 * 音乐播放器：左侧玻璃拟态悬浮卡片。
 *  - 数据源：管理者「音乐播放配置」（getConfig().music），参数值 {{id}} 替换为当前歌曲 ID
 *  - 响应解析：type=song 拿详情（name/singer/picimg）；若详情无音频直链，自动补一次 type=url 请求
 *  - 播放列表：每行一个歌曲 ID；随机模式按 60%-70% 概率取列表内 ID，其余取随机 ID
 *  - 交互：右上角收起按钮（向左水平插入、露出约 10%）、展开状态可拖拽、进度条点击跳转
 *  - 层级最高（z-index 9999），拖拽与下拉刷新期间禁止选中文字
 */
import { toast } from './utils.js';
import { getConfig } from './github.js';
import { getCurrentUser } from './user.js';

const PANEL_ID = 'mpPanel';
const RANDOM_PICK_LIST = 0.65; // 随机模式取列表内歌曲的概率
const FOLD_PEEK = 24; // 收起时露在屏幕外的左缘宽度（px）

let mp = null;

/* force=true 时强制重建卡片（管理者「刷新卡片」按钮 / 播放卡死后用于恢复） */
export function initMusicPanel(force) {
  const existing = document.getElementById(PANEL_ID);
  const m = musicConfig();
  if (!m) {
    /* 配置被停用：移除已渲染的卡片 */
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    if (!force) return;
    existing.remove();
  }
  buildPanel();
}

/* 读取音乐配置：未启用或未配置 API 时不初始化 */
function musicConfig() {
  const cfg = getConfig();
  if (!cfg || !cfg.music) return null;
  const m = cfg.music;
  if (m.enabled === false || !m.url) return null;
  return m;
}

/* ---------- 请求与解析 ---------- */
function buildParams(m, id, overrideType) {
  const params = {};
  (m.params || []).forEach((p) => {
    if (!p || !p.key) return;
    params[p.key] = String(p.value == null ? '' : p.value)
      .replace(/\{\{id\}\}/g, String(id))
      .replace(/\{\{input\}\}/g, String(id));
  });
  if (overrideType) params.type = overrideType;
  return params;
}

async function apiRequest(m, id, overrideType) {
  const params = buildParams(m, id, overrideType);
  const url = String(m.url || '').trim();
  const method = (m.method || 'GET').toUpperCase();
  if (method === 'POST') {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.json();
  }
  const qs = new URLSearchParams(params).toString();
  return fetch(url + (qs ? '?' + qs : '')).then((r) => r.json());
}

/* 按点分路径提取响应内容；未配置 path 时优先取根 data 字段 */
function extractData(json, path) {
  let d = json;
  if (path) {
    for (const seg of String(path).split('.')) {
      if (d == null) return null;
      d = d[seg];
    }
  } else if (json && json.data != null) {
    d = json.data;
  }
  return d;
}

/* 音频直链容错：url 可能是字符串或数组 */
function pickUrl(v) {
  if (Array.isArray(v)) {
    for (const it of v) {
      const u = it && (typeof it === 'object' ? it.url || it.src : it);
      if (typeof u === 'string' && u) return u;
    }
    return null;
  }
  if (typeof v === 'string' && v) return v;
  if (v && typeof v === 'object') return v.url || v.src || v.path || null;
  return null;
}

/* 获取歌曲：先拿详情，无音频直链时自动补 type=url 请求 */
async function fetchSong(id) {
  const m = musicConfig();
  if (!m) throw new Error('音乐未启用');
  let d = extractData(await apiRequest(m, id), m.path);
  if (!d || typeof d !== 'object') d = {};
  let audioUrl = pickUrl(d.url);
  if (!audioUrl) {
    const d2 = extractData(await apiRequest(m, id, 'url'), m.path);
    if (d2 && typeof d2 === 'object') audioUrl = pickUrl(d2.url) || pickUrl(d2);
  }
  return {
    id: d.id || id,
    name: d.name || d.title || '未知歌曲',
    /* BugPk 接口扁平返回：name/ar_name/al_name/pic/url */
    singer: d.singer || d.ar_name || d.artist || d.author || d.singerName || '',
    album: d.al_name || d.album || '',
    picimg: d.picimg || d.picUrl || d.cover || d.pic || d.coverUrl || '',
    url: audioUrl,
  };
}

function randomId() {
  return String(Math.floor(1e8 + Math.random() * 9e8));
}

/* ---------- 播放列表策略 ---------- */
function currentList() {
  const m = musicConfig();
  return (m && Array.isArray(m.playlist)) ? m.playlist.filter(Boolean) : [];
}

/* 下一首选择：返回 { id, fromList } */
function pickNext() {
  const list = currentList();
  const m = musicConfig();
  if (!list.length) return { id: randomId(), fromList: false };
  if (!m || m.random === false) {
    const next = (mp.idx + 1) % list.length;
    return { id: list[next], fromList: true, next: next };
  }
  if (Math.random() < RANDOM_PICK_LIST) {
    let next = Math.floor(Math.random() * list.length);
    if (list.length > 1 && next === mp.idx) next = (next + 1) % list.length;
    return { id: list[next], fromList: true, next: next };
  }
  return { id: randomId(), fromList: false };
}

function pickPrev() {
  const list = currentList();
  if (!list.length) return { id: randomId(), fromList: false };
  const prev = (mp.idx - 1 + list.length) % list.length;
  return { id: list[prev], fromList: true, next: prev };
}

/* ---------- UI ---------- */
function buildPanel() {
  const card = document.createElement('div');
  card.id = PANEL_ID;
  card.className = 'music-card folded';
  card.innerHTML = `
    <div class="music-card-inner">
      <button class="music-fold" type="button" title="收起播放器">»</button>
      <div class="music-main">
        <img class="music-cover" id="mpCover" alt="封面" />
        <div class="music-info">
          <div class="music-name-wrap"><span class="music-name" id="mpName">未播放</span></div>
          <span class="music-singer" id="mpSinger">点击播放</span>
        </div>
      </div>
      <div class="music-progress">
        <span class="mp-time" id="mpCur">0:00</span>
        <div class="mp-bar" id="mpBar"><div class="mp-bar-fill" id="mpBarFill"></div></div>
        <span class="mp-time" id="mpDur">0:00</span>
      </div>
      <div class="music-controls">
        <button class="mp-btn" id="mpPrev" type="button" title="上一首">⏮</button>
        <button class="mp-btn mp-toggle" id="mpToggle" type="button" title="播放/暂停">▶</button>
        <button class="mp-btn" id="mpNext" type="button" title="下一首">⏭</button>
      </div>
    </div>
    <audio id="mpAudio"></audio>
  `;
  document.body.appendChild(card);

  const audio = document.getElementById('mpAudio');
  const toggleBtn = document.getElementById('mpToggle');
  const cover = document.getElementById('mpCover');
  const nameEl = document.getElementById('mpName');
  const singerEl = document.getElementById('mpSinger');
  const bar = document.getElementById('mpBar');
  const barFill = document.getElementById('mpBarFill');
  const curEl = document.getElementById('mpCur');
  const durEl = document.getElementById('mpDur');

  mp = { idx: 0, playing: false, cur: null, card, audio, busy: false, lastX: null };

  /* 初始垂直居中（用 top 定位，避免与折叠位移互相干扰） */
  const initTop = Math.max(8, Math.min(window.innerHeight - card.offsetHeight - 8, (window.innerHeight - card.offsetHeight) / 2));
  card.style.top = initTop + 'px';
  card.style.transform = 'translateY(0)';

  /* 收起：left 直接移出屏幕外，仅露 FOLD_PEEK 宽（不依赖 transform，拖到任意位置都能收起） */
  const foldCard = () => {
    const w = card.offsetWidth || 320;
    card.style.left = -(w - FOLD_PEEK) + 'px';
    card.classList.add('folded');
  };
  /* 弹出：回到拖拽前（或初始）位置 */
  const expandCard = () => {
    if (mp.lastX == null) mp.lastX = 12;
    card.style.left = mp.lastX + 'px';
    card.classList.remove('folded');
  };

  cover.addEventListener('error', () => {
    cover.classList.add('mp-cover-fallback');
  });

  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    const p = audio.currentTime / audio.duration;
    barFill.style.width = (p * 100).toFixed(2) + '%';
    curEl.textContent = mpFmtTime(audio.currentTime);
    durEl.textContent = mpFmtTime(audio.duration);
  });
  audio.addEventListener('loadedmetadata', () => {
    durEl.textContent = mpFmtTime(audio.duration || 0);
  });
  audio.addEventListener('play', () => {
    mp.playing = true;
    toggleBtn.textContent = '❚❚';
    card.classList.add('mp-playing');
  });
  audio.addEventListener('pause', () => {
    mp.playing = false;
    toggleBtn.textContent = '▶';
    card.classList.remove('mp-playing');
  });
  audio.addEventListener('ended', () => {
    playTarget(pickNext());
  });

  /* 进度条点击跳转 */
  bar.addEventListener('click', (e) => {
    if (!audio.duration) return;
    const r = bar.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    audio.currentTime = p * audio.duration;
  });

  /* 播放控制 */
  toggleBtn.addEventListener('click', () => {
    if (mp.busy) return;
    if (!mp.cur) {
      playTarget({ id: firstId(), fromList: true, next: 0 });
      return;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  document.getElementById('mpPrev').addEventListener('click', () => playTarget(pickPrev()));
  document.getElementById('mpNext').addEventListener('click', () => playTarget(pickNext()));

  /* 收起 / 弹出：折叠用 left 移出屏幕，弹出回到原位置 */
  card.querySelector('.music-fold').addEventListener('click', () => {
    if (card.classList.contains('folded')) expandCard();
    else foldCard();
  });

  /* 展开状态可拖拽（折叠时点击露出的左缘也可弹出并拖动） */
  setupDrag(card);
  /* 初始为收起状态：移出屏幕外只露左缘 */
  foldCard();

  /* 封面/歌名滚动检测：内容超出宽度时开启横向滚动 */
  const checkMarquee = () => {
    const wrap = nameEl.parentElement;
    if (nameEl.scrollWidth > wrap.clientWidth + 2) {
      nameEl.classList.add('scrolling');
      nameEl.style.setProperty('--dist', -(nameEl.scrollWidth - wrap.clientWidth) + 'px');
    } else {
      nameEl.classList.remove('scrolling');
    }
  };
  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(checkMarquee) : null;
  if (ro) ro.observe(nameEl);
  window.addEventListener('resize', checkMarquee);
  mp.checkMarquee = checkMarquee;
}

function firstId() {
  const list = currentList();
  return list.length ? list[0] : randomId();
}

function setupDrag(card) {
  let dragging = false;
  let sx = 0, sy = 0, ox = 0, oy = 0;

  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.target.closest('.mp-bar')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragging = true;
    /* 折叠时点击左缘：先弹出到原位置再开始拖 */
    if (card.classList.contains('folded')) {
      if (mp.lastX == null) mp.lastX = 12;
      card.style.left = mp.lastX + 'px';
      card.classList.remove('folded');
    }
    sx = e.clientX;
    sy = e.clientY;
    ox = card.offsetLeft;
    oy = card.offsetTop;
    /* 拖拽过程禁用 transition，避免位置滞后 */
    card.style.transition = 'none';
    card.setPointerCapture(e.pointerId);
    document.body.classList.add('music-dragging');
    e.preventDefault();
  });

  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const nx = Math.max(8, Math.min(window.innerWidth - card.offsetWidth - 8, ox + (e.clientX - sx)));
    const ny = Math.max(8, Math.min(window.innerHeight - card.offsetHeight - 8, oy + (e.clientY - sy)));
    card.style.left = nx + 'px';
    card.style.top = ny + 'px';
    mp.lastX = nx;
  });

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = '';
    document.body.classList.remove('music-dragging');
  };
  card.addEventListener('pointerup', stop);
  card.addEventListener('pointercancel', stop);
}

/* 播放一首歌：加载 → 设置 UI → 播放 */
async function playTarget(target) {
  if (!mp) return;
  const id = target.id;
  if (mp.busy) return;
  mp.busy = true;
  const toggleBtn = document.getElementById('mpToggle');
  toggleBtn.textContent = '…';
  try {
    const song = await fetchSong(id);
    if (!song.url) throw new Error('no-url');
    mp.cur = song;
    mp.playing = false;
    if (target.fromList && target.next != null) mp.idx = target.next;
    const nameEl = document.getElementById('mpName');
    document.getElementById('mpSinger').textContent = song.singer || '未知歌手';
    nameEl.textContent = song.name;
    const cover = document.getElementById('mpCover');
    if (song.picimg) {
      cover.src = song.picimg;
      cover.classList.remove('mp-cover-fallback');
    } else {
      cover.removeAttribute('src');
      cover.classList.add('mp-cover-fallback');
    }
    if (mp.checkMarquee) mp.checkMarquee();
    mp.audio.src = song.url;
    mp.audio.play().catch(() => {});
  } catch (e) {
    toast('获取音乐失败，可能被风控');
  } finally {
    mp.busy = false;
    if (!mp.cur) toggleBtn.textContent = '▶';
  }
}

function mpFmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}
