/**
 * 主内容区下拉刷新：在滚动顶部时向下拖拽 → 重新拉取用户数据并刷新 UI。
 * 桌面鼠标拖拽与触屏均可触发。
 */
import { toast } from './utils.js';
import { refreshUser } from './user.js';
import { renderUserUI, refreshStats } from './pages.js';
import { updateNavUser } from './topnav.js';

const THRESHOLD = 64;

export function initPullRefresh() {
  const main = document.getElementById('main');
  if (!main) return;

  const ind = document.createElement('div');
  ind.className = 'pull-refresh';
  ind.innerHTML = '<span class="pull-spinner"></span><span class="pull-text">下拉刷新</span>';
  main.appendChild(ind);

  let startY = null;
  let dist = 0;
  let refreshing = false;

  const setState = (y) => {
    dist = y;
    const clamped = Math.min(y, 90);
    ind.style.transform = `translateY(${clamped - 24}px)`;
    ind.classList.toggle('visible', y > 4);
    ind.classList.toggle('beyond', y >= THRESHOLD);
    ind.querySelector('.pull-text').textContent = y >= THRESHOLD ? '释放刷新' : '下拉刷新';
  };

  const reset = () => {
    startY = null;
    dist = 0;
    ind.style.transform = '';
    ind.classList.remove('visible', 'beyond');
    ind.querySelector('.pull-text').textContent = '下拉刷新';
    document.body.classList.remove('pull-dragging');
  };

  main.addEventListener('pointerdown', (e) => {
    if (refreshing || main.scrollTop > 0) return;
    if (e.pointerType !== 'mouse' && e.button) return;
    startY = e.clientY;
    /* 拖拽期间禁止选中文字 */
    document.body.classList.add('pull-dragging');
  });

  main.addEventListener('pointermove', (e) => {
    if (startY == null || refreshing) return;
    const delta = e.clientY - startY;
    if (delta <= 0) {
      reset();
      return;
    }
    if (main.scrollTop > 0) {
      reset();
      return;
    }
    e.preventDefault();
    setState(delta * 0.5);
  });

  main.addEventListener('pointerup', async () => {
    if (startY == null) return;
    const go = dist >= THRESHOLD;
    reset();
    if (!go || refreshing) return;
    refreshing = true;
    ind.classList.add('refreshing', 'visible');
    ind.style.transform = 'translateY(0)';
    ind.querySelector('.pull-text').textContent = '刷新中...';
    try {
      const user = await refreshUser();
      if (user) {
        updateNavUser(user);
        renderUserUI(user);
        refreshStats(user);
        toast('数据已刷新');
      } else {
        refreshStats(null);
        toast('尚未登录，仅刷新了统计');
      }
    } catch (e) {
      toast(e.message || '刷新失败');
    } finally {
      refreshing = false;
      ind.classList.remove('refreshing');
      reset();
    }
  });

  main.addEventListener('pointercancel', reset);
}
