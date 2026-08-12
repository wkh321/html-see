initTopNav();
initSidebar();
initPages();
initAdmin();
initAiPanel();
initAuthUI();
initProfileSettings();
initPullRefresh();
initDevices();
initProjects();
initGallery();
initMusicPanel();

/* 个人资料页变更后统一刷新所有用户相关 UI */
setProfileHooks(
  (user) => {
    updateNavUser(user);
    renderUserUI(user);
    refreshStats(user);
    setSidebarAdminVisibility(true);
  },
  (pageId) => switchPage(pageId)
);

/* 登录成功后统一刷新所有用户相关 UI */
setAuthSuccessHandler(async (user) => {
  updateNavUser(user);
  renderUserUI(user);
  refreshStats(user);
  setSidebarAdminVisibility(true);
  switchPage('profile');
  toast('欢迎回来，' + (user.name || '') + '');
});

/* 初始化：恢复会话并按用户数据更新 UI */
async function bootstrap() {
  let user = getCurrentUser();

  if (user && hasConfig()) {
    /* 异步从仓库同步最新 info.json */
    const fresh = await refreshUser().catch(() => null);
    if (fresh) user = fresh;
  }

  updateNavUser(user);
  renderUserUI(user);
  refreshStats(user);
  /* 管理者后台设置对所有用户开放 */
  setSidebarAdminVisibility(true);

  if (!user && !hasConfig()) {
    /* 未配置仓库：引导配置 */
    setTimeout(() => toast('尚未配置 GitHub 仓库，可在 管理者设置 中对接'), 800);
  } else if (!user) {
    /* 已配置仓库但未登录：提示登录 */
    setTimeout(() => {
      toast('已检测到 GitHub 仓库，点击右上角「登录 / 注册」进入');
    }, 800);
  }
}

/* 顶部“我的”始终为个人信息页，登录后若停留在占位页则回到个人信息 */
bootstrap();
