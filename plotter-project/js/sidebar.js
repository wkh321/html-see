import { switchPage } from './pages.js';

export function initSidebar() {
  const nav = document.getElementById('sidebarNav');
  nav.addEventListener('click', (e) => {
    const item = e.target.closest('.side-item[data-page]');
    if (!item) return;
    switchPage(item.dataset.page);
  });
}

/* 侧边栏高亮切换 */
export function setSidebarActive(pageId) {
  document.querySelectorAll('.side-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.page === pageId);
  });
}

/* 管理员专属分组：仅管理员账号可见 */
export function setSidebarAdminVisibility(visible) {
  const group = document.getElementById('adminGroupTitle');
  const btn = document.getElementById('adminSideBtn');
  if (group) group.classList.toggle('hidden', !visible);
  if (btn) btn.classList.toggle('hidden', !visible);
  if (!visible && document.getElementById('page-admin').classList.contains('active')) {
    switchPage('profile');
  }
}
