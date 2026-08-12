/**
 * 公开作品广场：遍历 shareRoot 全部用户的公开作品并渲染。
 *  - 上方工具条卡片：分类筛选（一次函数/二次函数/反比例函数/动画/旋转/全部）+ 排序（默认=目录名顺序、最新=更新时间倒序）+ 搜索
 *  - 下方作品网格卡片：纵向滚动多行，每行 4 个作品卡片，玻璃拟态磨砂 + 翻折入场动画
 *  - 鼠标左键按住可拖拽滚动（禁止选中文字）；点击作品卡片在新窗口打开
 */
import { requireConfig, buildPath, ghRead, listDirs, listFiles, cdnUrls, fileUrl } from './github.js';
import { GAL_CATEGORIES } from './data.js';
import { showSkeleton, toast, ERR_MSG } from './utils.js';

const GAL_STATE = { category: '全部', sort: 'default', keyword: '', error: '' };
let galWorks = [];

function galEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function galFmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 遍历 shareRoot 全部用户目录 → 每个用户的 share/works.json 分享索引 */
async function loadGalleryWorks() {
  const cfg = requireConfig();
  const users = await listDirs(cfg, cfg.shareRoot);
  const uinfoCache = {};
  const works = [];
  for (const u of users) {
    const uid = u.name;
    let uinfo = uinfoCache[uid];
    if (uinfo === undefined) {
      uinfo = null;
      try {
        const raw = await ghRead(cfg, buildPath(cfg.usersRoot, uid, 'info.json'));
        if (raw) uinfo = JSON.parse(raw);
      } catch (e) {}
      uinfoCache[uid] = uinfo;
    }
    let index = {};
    try {
      const raw = await ghRead(cfg, buildPath(cfg.shareRoot, uid, 'share', 'works.json'));
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object' && !Array.isArray(d)) index = d;
      }
    } catch (e) {}
    for (const folder of Object.keys(index)) {
      const e = index[folder] || {};
      works.push({
        folder,
        userId: uid,
        path: (e && e.path) || '',
        name: (e && e.name) || folder,
        desc: (e && e.desc) || '',
        category: (e && e.category) || '',
        tags: (e && Array.isArray(e.tags)) ? e.tags : [],
        updatedAt: (e && e.updatedAt) || 0,
        author: (e && e.author) || (uinfo && uinfo.name) || uid,
        userName: (uinfo && uinfo.name) || uid,
        avatar: (uinfo && uinfo.avatar) || '',
      });
    }
  }
  return works;
}

/* 筛选 + 排序（默认=目录名顺序，最新=更新时间倒序） */
function filteredWorks() {
  let list = galWorks.slice();
  const cat = GAL_STATE.category;
  if (cat && cat !== '全部') {
    list = list.filter((w) => (w.category || '未分类') === cat);
  }
  const kw = GAL_STATE.keyword.trim().toLowerCase();
  if (kw) {
    list = list.filter((w) =>
      w.name.toLowerCase().includes(kw) ||
      w.desc.toLowerCase().includes(kw) ||
      (w.tags || []).join(',').toLowerCase().includes(kw) ||
      w.userName.toLowerCase().includes(kw)
    );
  }
  if (GAL_STATE.sort === 'latest') {
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } else {
    list.sort((a, b) => String(a.folder).localeCompare(String(b.folder), 'zh'));
  }
  return list;
}

/* 渲染上方工具条卡片（分类按钮组 + 排序下拉 + 搜索框） */
function renderGalToolbar() {
  const box = document.getElementById('galCats');
  if (!box) return;
  box.innerHTML = GAL_CATEGORIES.map(
    (c) => `<button class="gal-cat${c === GAL_STATE.category ? ' active' : ''}" data-cat="${galEsc(c)}">${galEsc(c)}</button>`
  ).join('');
  box.querySelectorAll('.gal-cat').forEach((btn) => {
    btn.addEventListener('click', () => {
      GAL_STATE.category = btn.dataset.cat;
      renderGalToolbar();
      renderGalDeck();
    });
  });
}

/* 渲染下方作品网格卡片（每行 4 个，翻折入场动画，间隔 80ms） */
function renderGalDeck() {
  const deck = document.getElementById('galDeck');
  const empty = document.getElementById('galEmpty');
  if (!deck) return;
  deck.innerHTML = '';
  if (GAL_STATE.error) {
    if (empty) {
      empty.textContent = GAL_STATE.error;
      empty.classList.remove('hidden');
    }
    return;
  }
  const list = filteredWorks();
  if (!list.length) {
    if (empty) {
      empty.textContent = (GAL_STATE.keyword.trim() || GAL_STATE.category !== '全部')
        ? '没有找到匹配的公开作品'
        : '暂无公开作品';
      empty.classList.remove('hidden');
    }
    return;
  }
  if (empty) empty.classList.add('hidden');
  list.forEach((w, i) => {
    const el = document.createElement('article');
    el.className = 'gal-item';
    el.dataset.user = w.userId;
    el.dataset.folder = w.folder;
    el.style.animationDelay = i * 80 + 'ms';
    el.innerHTML = galCardInner(w);
    deck.appendChild(el);
    const img = el.querySelector('.gal-avatar-img');
    const letter = el.querySelector('.gal-avatar-letter');
    if (img && letter) galAvatar(w, img, letter);
  });
}

/* 作品卡片内容：右上角上传时间角标 → 作品名称 → 作品说明 → 作品分类 → 标签 → 用户头像 → 用户名称 */
function galCardInner(w) {
  const tags = (w.tags || []).slice(0, 4).map((t) => `<span class="gal-tag">${galEsc(t)}</span>`).join('');
  const cat = w.category || '未分类';
  return `
    <span class="gal-time">${galFmtTime(w.updatedAt)}</span>
    <h4 class="gal-name">${galEsc(w.name)}</h4>
    ${w.desc ? `<p class="gal-desc">${galEsc(w.desc)}</p>` : ''}
    <span class="gal-cat">${galEsc(cat)}</span>
    ${tags ? `<div class="gal-tags">${tags}</div>` : ''}
    <div class="gal-user">
      <span class="gal-avatar-wrap"><span class="gal-avatar-letter">学</span><img class="gal-avatar-img hidden" alt="" /></span>
      <span class="gal-user-name">${galEsc(w.userName)}</span>
    </div>
  `;
}

/* 头像：命中仓库路径则加载，失败回退文字「学」 */
function galAvatar(work, img, letter) {
  let cfg = null;
  try { cfg = requireConfig(); } catch (e) {}
  if (cfg && work.avatar) {
    img.onload = () => {
      img.classList.remove('hidden');
      letter.classList.add('hidden');
    };
    img.onerror = () => {
      img.classList.add('hidden');
      letter.classList.remove('hidden');
    };
    img.src = fileUrl(cfg, work.avatar);
  } else {
    img.classList.add('hidden');
    letter.classList.remove('hidden');
  }
}

/* 打开公开作品：从索引 path 读取文件夹内文件，优先 index.html */
async function onOpenGallery(item) {
  try {
    const cfg = requireConfig();
    const w = galWorks.find((x) => x.userId === item.dataset.user && x.folder === item.dataset.folder);
    const base = (w && w.path) ? w.path : buildPath(cfg.shareRoot, item.dataset.user, item.dataset.folder);
    const files = await listFiles(cfg, base);
    const html = files.find((f) => /\.html?$/i.test(f.name));
    const target = html
      ? buildPath(base, html.name)
      : files[0]
        ? buildPath(base, files[0].name)
        : base;
    window.open(cdnUrls(cfg, target).raw, '_blank', 'noopener');
  } catch (e) {
    toast(ERR_MSG);
  }
}

/* 第二个卡片：鼠标左键按住拖拽纵向滚动，禁止选中文字 */
function setupGalDrag(deck) {
  let dragging = false;
  let moved = false;
  let startY = 0;
  let startScroll = 0;
  deck.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    startScroll = deck.scrollTop;
    document.body.classList.add('gal-dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 3) moved = true;
    deck.scrollTop = startScroll - dy;
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.classList.remove('gal-dragging');
  });
  deck.addEventListener('dragstart', (e) => e.preventDefault());
  /* 点击作品卡片打开；拖拽滚动过则不触发 */
  deck.addEventListener('click', (e) => {
    if (moved) {
      moved = false;
      return;
    }
    const item = e.target.closest('.gal-item');
    if (item) onOpenGallery(item);
  });
}

/* 打开公开作品广场页面 */
export async function openGalleryPage() {
  const deck = document.getElementById('galDeck');
  if (!deck) return;
  showSkeleton(deck, 4, 'sk-card');
  GAL_STATE.error = '';
  try {
    galWorks = await loadGalleryWorks();
  } catch (e) {
    galWorks = [];
    GAL_STATE.error = ERR_MSG;
  }
  renderGalDeck();
}

export function initGallery() {
  renderGalToolbar();
  const sort = document.getElementById('galSort');
  if (sort) {
    sort.addEventListener('change', () => {
      GAL_STATE.sort = sort.value;
      renderGalDeck();
    });
  }
  const search = document.getElementById('galSearch');
  if (search) {
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        GAL_STATE.keyword = search.value;
        renderGalDeck();
      }, 250);
    });
  }
  const deck = document.getElementById('galDeck');
  if (deck) setupGalDrag(deck);
}
