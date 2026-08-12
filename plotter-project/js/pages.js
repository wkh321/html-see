import { funcItems, placeholderPages, STAT_BLOCKS } from './data.js';
import { toast, bottomTip, busyButton, showSkeleton } from './utils.js';
import { setSidebarActive } from './sidebar.js';
import { getStats, getCurrentUser, refreshUser } from './user.js';
import { renderAvatar } from './avatar.js';
import { showProfileSettings } from './profile-settings.js';
import { openProjectsPage, openMyWorksPage } from './projects.js';
import { openFileStatusPage } from './filestatus.js';
import { openGalleryPage } from './gallery.js';
import { updateNavUser } from './topnav.js';
import { withGhLock } from './github.js';

const PAGE_EL = {
  profile: 'page-profile',
  admin: 'page-admin',
  profileSettings: 'page-profile-settings',
  devices: 'page-devices',
  projects: 'page-projects',
  myworks: 'page-myworks',
  placeholder: 'page-placeholder',
  filestatus: 'page-filestatus',
  gallery: 'page-gallery',
};

/* 仓库数据读取缓存机制：切页后延迟 REPO_DELAY ms，仍停留该页才真正读取，
   期间用户频繁切页只会重置计时器（节流），避免短时间多次请求导致 API 被封 */
const REPO_DELAY = 2500;
const delayedTimers = {};

function isViewActive(pageId) {
  const el = document.getElementById(PAGE_EL[pageId]);
  return !!(el && el.classList.contains('active'));
}

function delayRepoLoad(pageId, fn) {
  clearTimeout(delayedTimers[pageId]);
  delayedTimers[pageId] = setTimeout(() => {
    if (!isViewActive(pageId)) return;
    const run = withGhLock('page-load:' + pageId, fn);
    if (!run) return;
    run.catch(() => {});
  }, REPO_DELAY);
}

/* 统一的页面数据加载入口：所有仓库数据加载共用同一把锁（page-load:<pageId>），
   加载中再次点击刷新按钮不会重置进度，只弹底部提示 */
function loadPageData(pageId) {
  if (pageId === 'projects') return openProjectsPage();
  if (pageId === 'myworks') return openMyWorksPage();
  if (pageId === 'filestatus') return openFileStatusPage();
  if (pageId === 'gallery') return openGalleryPage();
  if (pageId === 'profile') return refreshStats(getCurrentUser());
  if (placeholderPages[pageId]) {
    renderPlaceholder(pageId);
    return refreshAll(true);
  }
  return Promise.resolve();
}

/* 刷新用户数据与统计（占位页刷新按钮 / 侧边栏切换占位页时） */
async function refreshAll(showToast) {
  const user = await refreshUser();
  if (user) {
    updateNavUser(user);
    renderUserUI(user);
    refreshStats(user);
    if (showToast) toast('数据已刷新');
  } else {
    refreshStats(null);
    if (showToast) toast('尚未登录，仅刷新了统计');
  }
}

function onPageRefresh(pageId, btn) {
  const run = withGhLock('page-load:' + pageId, () => loadPageData(pageId));
  if (!run) {
    bottomTip();
    return;
  }
  const restore = busyButton(btn, '刷新中…');
  run.catch(() => {}).finally(restore);
}

export function initPages() {
  renderFuncGrid();

  /* 资料设置入口 */
  document.getElementById('profileEditBtn').addEventListener('click', () => {
    switchPage('profileSettings');
  });

  /* 私有内容页刷新按钮（main 事件委托，覆盖项目/公开作品/占位页） */
  const main = document.getElementById('main');
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-refresh-btn[data-page-refresh]');
    if (!btn) return;
    onPageRefresh(btn.dataset.pageRefresh, btn);
  });
}

/* 页面切换：需要读取仓库数据的页面先显示骨架，再延迟加载（缓存机制 + 节流） */
export function switchPage(pageId) {
  setSidebarActive(pageId);

  if (pageId === 'profile') {
    showView(PAGE_EL.profile);
    delayRepoLoad('profile', () => refreshStats(getCurrentUser()));
  } else if (pageId === 'admin') {
    showView(PAGE_EL.admin);
  } else if (pageId === 'profileSettings') {
    showView(PAGE_EL.profileSettings);
    showProfileSettings();
  } else if (pageId === 'devices') {
    showView(PAGE_EL.devices);
  } else if (pageId === 'projects') {
    showView(PAGE_EL.projects);
    if (getCurrentUser()) {
      showSkeleton(document.getElementById('projDeck'), 4, 'sk-card');
      delayRepoLoad('projects', openProjectsPage);
    } else {
      openProjectsPage();
    }
  } else if (pageId === 'myworks') {
    showView(PAGE_EL.myworks);
    if (getCurrentUser()) {
      showSkeleton(document.getElementById('myworksList'), 3, 'sk-row');
      delayRepoLoad('myworks', openMyWorksPage);
    } else {
      openMyWorksPage();
    }
  } else if (pageId === 'filestatus') {
    showView(PAGE_EL.filestatus);
    const box = document.getElementById('filestatusList');
    if (getCurrentUser()) {
      showSkeleton(box, 5, 'sk-row');
      delayRepoLoad('filestatus', openFileStatusPage);
    } else if (box) {
      box.innerHTML = '<div class="adm-empty">请先登录后查看文件处理状态</div>';
    }
  } else if (pageId === 'gallery') {
    showView(PAGE_EL.gallery);
    showSkeleton(document.getElementById('galDeck'), 4, 'sk-card');
    delayRepoLoad('gallery', openGalleryPage);
  } else if (placeholderPages[pageId]) {
    renderPlaceholder(pageId);
    showView(PAGE_EL.placeholder);
    /* 切页缓存机制：延迟后仍停留本页才静默刷新用户数据 */
    delayRepoLoad(pageId, () => refreshAll(false));
  } else {
    showView(PAGE_EL.profile);
  }
}

function showView(id) {
  document.querySelectorAll('.page-view').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) {
    target.classList.add('active');
    playCardEntrance(target);
  }
}

/* 页面切换时卡片从上到下依次翻开 */
function playCardEntrance(page) {
  const cards = [...page.querySelectorAll(
    '.overview-card, .func-card, .stat-block, .ps-head, .ps-card, .admin-head, .admin-tab, .admin-card, .placeholder-page, .devices-head, .device-card, .proj-head, .proj-card, .myworks-head, .myworks-item, .gal-toolbar, .gal-deck-shell'
  )];
  if (!cards.length) return;
  cards.forEach((el) => el.classList.remove('flip-in'));
  void page.offsetWidth;
  cards.forEach((el, i) => {
    el.style.animationDelay = i * 55 + 'ms';
    el.classList.add('flip-in');
    el.addEventListener('animationend', function handler() {
      el.classList.remove('flip-in');
      el.style.animationDelay = '';
      el.removeEventListener('animationend', handler);
    });
  });
}

/* 根据用户数据渲染个人信息页（昵称 / ID / 头像） */
export function renderUserUI(user) {
  const name = (user && user.name) || '未登录';
  const idText = user ? 'ID：' + user.id : 'ID：未登录';

  document.getElementById('overviewName').textContent = name;
  document.getElementById('overviewId').textContent = idText;
  renderAvatar('overviewAvatar', 'overviewAvatarImg', user, name);
}

/* ① 顶部个人总览统计块：数据未加载完成前显示 "-"，加载后填充真实值 */
export async function refreshStats(user) {
  const container = document.getElementById('overviewStats');
  if (!container) return;
  container.innerHTML = STAT_BLOCKS.map(
    (s) => `<div class="stat-block"><strong>-</strong><span>${s.label}</span></div>`
  ).join('');
  const stats = await getStats(user);
  container.innerHTML = STAT_BLOCKS.map(
    (s) => `<div class="stat-block"><strong>${stats[s.key] ?? 0}</strong><span>${s.label}</span></div>`
  ).join('');
}

/* ② 2x2 功能网格卡片 */
function renderFuncGrid() {
  const container = document.getElementById('funcGrid');
  container.innerHTML = funcItems
    .map(
      (item) => `
      <article class="func-card glass-card hoverable" data-page="${item.page}">
        <span class="func-card-arrow">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </span>
        <span class="func-card-icon">${item.icon}</span>
        <div class="func-card-info">
          <strong>${item.title}</strong>
          <span>${item.desc}</span>
        </div>
      </article>`
    )
    .join('');
  container.addEventListener('click', (e) => {
    const card = e.target.closest('.func-card[data-page]');
    if (!card) return;
    const item = funcItems.find((it) => it.page === card.dataset.page);
    switchPage(card.dataset.page);
    if (item) toast(`进入：${item.title}`);
  });
}

/* ③ 通用占位页渲染（知识库/上传/错题库/公开作品广场），含刷新按钮 */
function renderPlaceholder(pageId) {
  const page = placeholderPages[pageId];
  if (!page) return;
  const body = document.getElementById('placeholderBody');
  body.innerHTML = `
    <div class="placeholder-icon">${page.icon}</div>
    <h3>${page.title}</h3>
    <p>${page.desc}</p>
    <button class="page-refresh-btn" data-page-refresh="${pageId}">刷新</button>
  `;
}
