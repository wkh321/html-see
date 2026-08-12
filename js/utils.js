export function toast(message) {
  const wrap = document.getElementById('toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 320);
  }, 2200);
}

/* 底部浮层提示（区别于顶部 toast，用于加载中反复点击等场景） */
const BOTTOM_TIP = 'ฅ´•̀ω•́`ฅ~不要再点啦~ฅ´•̀ω•́`ฅ';
export function bottomTip(message) {
  const wrap = document.getElementById('bottomTipWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'bottom-tip';
  el.textContent = message || BOTTOM_TIP;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 320);
  }, 1800);
}

/* 按钮忙态：禁用并显示加载文案，返回恢复函数（防频繁触发 + 加载提示） */
export function busyButton(btn, busyText) {
  if (!btn) return () => {};
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText || '处理中…';
  return () => {
    btn.disabled = false;
    btn.textContent = orig;
  };
}

/* 统一的数据加载失败提示（数据加载类失败统一使用此文案） */
export const ERR_MSG = '服务器超时啦～ฅ(´・̥ω・̥`)ฅ';

/* 骨架屏：向容器写入 count 个骨架块。cls 为块的尺寸类（如 sk-card / sk-row） */
export function showSkeleton(container, count, cls) {
  if (!container) return;
  const blocks = new Array(Math.max(1, count || 3))
    .fill(0)
    .map(() => `<div class="skeleton ${cls || 'sk-card'}"></div>`)
    .join('');
  container.innerHTML = `<div class="skeleton-wrap">${blocks}</div>`;
}

/* 骨架屏加载工具：loading 期间显示骨架，完成后写入真实内容，返回 success */
export async function withSkeleton(container, count, cls, task) {
  showSkeleton(container, count, cls);
  try {
    const html = await task();
    if (container) container.innerHTML = html;
    return true;
  } catch (e) {
    if (container) container.innerHTML = '';
    throw e;
  }
}
