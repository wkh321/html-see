import { newMenuItems, icons } from './data.js';
import { toast } from './utils.js';
import { switchPage, renderUserUI, refreshStats } from './pages.js';
import { renderAvatar } from './avatar.js';
import { setSidebarAdminVisibility } from './sidebar.js';
import { openAuthModal } from './auth-ui.js';
import { clearSession, getCurrentUser } from './user.js';

export function initTopNav() {
  renderNewMenu();

  /* 加号新建 */
  const newBtn = document.getElementById('newBtn');
  const newDropdown = document.getElementById('newDropdown');
  newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown(newDropdown);
  });
  newDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('button[data-page]');
    if (!item) return;
    closeDropdown(newDropdown);
    switchPage(item.dataset.page);
    toast(`已开始：${item.textContent.trim()}`);
  });

  /* 用户菜单 */
  const userMenu = document.getElementById('userMenu');
  const userDropdown = document.getElementById('userDropdown');
  userMenu.addEventListener('click', (e) => {
    if (e.target.closest('.dropdown')) return;
    e.stopPropagation();
    userMenu.classList.toggle('open');
    toggleDropdown(userDropdown);
  });
  userDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('button[data-action]');
    if (!item) return;
    closeDropdown(userDropdown);
    userMenu.classList.remove('open');
    handleUserAction(item.dataset.action);
  });

  /* 返回 / 品牌 / 绘图主页标签：跳转到函数绘制器（plotter/index.html） */
  const user = getCurrentUser();
  const plotterUrl = 'plotter/index.html' + (user && user.id ? '?u=' + encodeURIComponent(user.id) : '');
  bindJump('backBtn', plotterUrl);
  bindJump('brandBtn', plotterUrl);
  bindJump('quickBackBtn', plotterUrl);
  document.querySelectorAll('.nav-tab[data-nav="plotter"]').forEach((btn) =>
    btn.addEventListener('click', () => { location.href = plotterUrl; })
  );
  document.getElementById('manualBtn').addEventListener('click', () =>
    toast('使用手册：左侧导航切换页面，右侧 AI 球形助手可拖动、双击展开')
  );

  /* 点击外部关闭下拉 */
  document.addEventListener('click', () => {
    closeDropdown(newDropdown);
    closeDropdown(userDropdown);
    userMenu.classList.remove('open');
  });
}

/* 登录态变化时更新顶部昵称/头像与下拉菜单 */
export function updateNavUser(user) {
  const name = (user && user.name) || '未登录';
  document.getElementById('navUserName').textContent = name;
  renderAvatar('navAvatar', 'navAvatarImg', user, name);

  const dropdown = document.getElementById('userDropdown');
  let loginItem = dropdown.querySelector('[data-action="login"]');
  if (user) {
    if (loginItem) loginItem.remove();
  } else {
    if (!loginItem) {
      const btn = document.createElement('button');
      btn.dataset.action = 'login';
      btn.innerHTML = loginSvg() + '登录 / 注册';
      dropdown.prepend(btn);
    }
  }
}

function loginSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><polyline points="10 17 15 12 10 7"></polyline><line x1="15" y1="12" x2="3" y2="12"></line></svg>';
}

function handleUserAction(action) {
  switch (action) {
    case 'login':
      openAuthModal();
      break;
    case 'profile':
      handleProfile();
      break;
    case 'admin':
      handleAdminEntry();
      break;
    case 'logout':
      clearSession();
      updateNavUser(null);
      renderUserUI(null);
      refreshStats(null);
      setSidebarAdminVisibility(true);
      switchPage('profile');
      toast('已退出登录');
      break;
    default:
      break;
  }
}

function handleProfile() {
  const user = getCurrentUser();
  if (!user) {
    toast('请先登录');
    openAuthModal();
    return;
  }
  /* 打开个人资料界面（昵称/密码/头像/白名单等设置） */
  switchPage('profileSettings');
}

async function handleAdminEntry() {
  /* 管理者后台设置对所有用户开放 */
  switchPage('admin');
}

function toggleDropdown(el) {
  if (!el) return;
  const open = el.classList.contains('open');
  closeDropdown(el);
  if (!open) el.classList.add('open');
}

function closeDropdown(el) {
  if (!el) return;
  el.classList.remove('open');
}

function bindJump(id, url) {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener('click', () => { location.href = url; });
}

function renderNewMenu() {
  const container = document.getElementById('newDropdown');
  const list = newMenuItems
    .map((item) => {
      const icon = item.label.includes('绘图') ? icons.file : item.label.includes('知识') ? icons.book : icons.upload;
      return `<button data-page="${item.page}">${icon}${item.label}</button>`;
    })
    .join('');
  container.innerHTML = list;
}
