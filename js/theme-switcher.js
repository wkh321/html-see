/* ============================================================
 * html-see 共享主题切换器
 * 轻量级，可在任意页面引入
 * ============================================================ */
(function () {
  'use strict';
  const STORAGE_KEY = 'htmlsee_theme';
  const THEMES = ['light', 'dark', 'ocean', 'forest'];
  const LABELS = { light: '浅色', dark: '深色', ocean: '海洋蓝', forest: '森林绿' };

  function apply(name) {
    if (!THEMES.includes(name)) name = 'light';
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem(STORAGE_KEY, name);
    // 更新所有主题选择器
    document.querySelectorAll('.enh-theme-select').forEach(sel => { sel.value = name; });
  }

  function init() {
    const saved = localStorage.getItem(STORAGE_KEY) || 'light';
    apply(saved);

    // 监听自定义事件，供其他脚本触发
    window.addEventListener('enh-theme-change', (e) => apply(e.detail));

    // 暴露全局API
    window.EnhTheme = { apply, get: () => localStorage.getItem(STORAGE_KEY) || 'light' };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
