/**
 * 登录 / 注册 / 快速登录 UI
 * 快速登录：从 users/_index.txt 拉取用户索引，选择后自动定位用户 ID
 */
import { requireConfig, hasConfig, withGhLock } from './github.js';
import { readIndex, login, register, findUserByEmail } from './user.js';
import { toast } from './utils.js';
import { mailEnabled, mailSendCode, validateEmail } from './mail.js';

let authSuccessHandler = null;

export function setAuthSuccessHandler(fn) {
  authSuccessHandler = fn;
}

export function openAuthModal() {
  const overlay = document.getElementById('authOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  /* 每次打开重置输入框，避免残留上次登录/注册内容导致数据泄露 */
  document.getElementById('authUserId').value = '';
  document.getElementById('authName').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authMsg').textContent = '';
  document.getElementById('authUserSelect').innerHTML = '<option value="">— 加载中 —</option>';
  setTab('login');
  loadIndexUsers();
  if (!hasConfig()) {
    document.getElementById('authRepoHint').textContent = '未配置 GitHub 仓库：请在 管理者设置 - 对接GitHub知识点仓库 中填写 token/owner/repo 后再登录';
  } else {
    document.getElementById('authRepoHint').textContent = '';
  }
}

export function closeAuthModal() {
  const overlay = document.getElementById('authOverlay');
  if (overlay) overlay.classList.remove('show');
}

export function initAuthUI() {
  const overlay = document.getElementById('authOverlay');
  if (!overlay) return;

  document.getElementById('authCloseBtn').addEventListener('click', closeAuthModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeAuthModal();
  });

  /* 登录 / 注册 切换 */
  document.querySelectorAll('.auth-tab[data-auth-tab]').forEach((tab) => {
    tab.addEventListener('click', () => setTab(tab.dataset.authTab));
  });

  /* 用户索引快速定位 */
  document.getElementById('authUserSelect').addEventListener('change', (e) => {
    if (e.target.value) {
      document.getElementById('authUserId').value = e.target.value;
    }
  });

  /* 提交 */
  document.getElementById('authSubmitBtn').addEventListener('click', async () => {
    await submit();
  });
  const pw = document.getElementById('authPassword');
  pw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  /* 注册：获取邮箱验证码（60s 节流） */
  const codeBtn = document.getElementById('authCodeBtn');
  if (codeBtn) {
    codeBtn.addEventListener('click', sendAuthCode);
    document.getElementById('authCode').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  }
}

function setCountdown(btn, seconds, doneText) {
  const orig = btn.dataset.origText || btn.textContent;
  btn.dataset.origText = orig;
  btn.disabled = true;
  let left = seconds;
  const timer = setInterval(() => {
    left -= 1;
    btn.textContent = left + 's 后重试';
    if (left <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = orig;
    }
  }, 1000);
  return () => {
    clearInterval(timer);
    btn.disabled = false;
    btn.textContent = orig;
  };
}

async function sendAuthCode() {
  const msg = document.getElementById('authMsg');
  msg.textContent = '';
  let email;
  try {
    email = validateEmail(document.getElementById('authEmail').value);
  } catch (e) {
    msg.textContent = e.message;
    return;
  }
  if (!mailEnabled()) {
    msg.textContent = '邮件验证码服务未配置：请先在 管理者设置 - 邮件验证码服务 中填写域名';
    return;
  }
  try {
    const dup = await findUserByEmail(email);
    if (dup) {
      msg.textContent = '该邮箱已被绑定，可直接用邮箱登录';
      return;
    }
  } catch (e) {}
  const btn = document.getElementById('authCodeBtn');
  const stop = setCountdown(btn, 60, '获取验证码');
  try {
    const r = await mailSendCode(email);
    if (r.ok) {
      msg.textContent = '验证码已发送到 ' + email + '（5 分钟内有效）';
    } else {
      msg.textContent = '发送失败：' + (r.msg || '请稍后再试');
      stop();
    }
  } catch (e) {
    msg.textContent = '发送失败：' + e.message;
    stop();
  }
}

function setTab(name) {
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.authTab === name));
  /* 注册模式下隐藏登录专属选项（用户索引快速登录 / 2 天免登录） */
  document.querySelectorAll('.register-only').forEach((el) => el.classList.toggle('hidden', name !== 'register'));
  document.querySelectorAll('.login-only').forEach((el) => el.classList.toggle('hidden', name !== 'login'));
  document.getElementById('authSubmitBtn').textContent = name === 'login' ? '登录' : '注册';
}

async function loadIndexUsers() {
  const select = document.getElementById('authUserSelect');
  select.innerHTML = '<option value="">— 从 _index.txt 选择用户（快速登录） —</option>';
  if (!hasConfig()) return;
  try {
    const cfg = requireConfig();
    const map = await readIndex(cfg);
    const ids = Object.keys(map).sort((a, b) => (map[b].registeredAt || 0) - (map[a].registeredAt || 0));
    ids.forEach((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = map[id].name ? id + '（' + map[id].name + '）' : id;
      select.appendChild(opt);
    });
    if (!ids.length) {
      select.innerHTML = '<option value="">索引为空：暂无注册用户，请切换「注册」创建</option>';
    }
  } catch (e) {
    select.innerHTML = '<option value="">读取用户索引失败：' + e.message + '</option>';
  }
}

async function submit() {
  const msg = document.getElementById('authMsg');
  const btn = document.getElementById('authSubmitBtn');
  const remember = document.getElementById('authRemember').checked;
  msg.textContent = '';
  const task = async () => {
    const activeTab = document.querySelector('.auth-tab.active').dataset.authTab;
    btn.disabled = true;
    btn.textContent = '处理中...';
    let result;
    if (activeTab === 'register') {
      result = await register(
        document.getElementById('authName').value,
        document.getElementById('authPassword').value,
        remember,
        document.getElementById('authEmail').value,
        document.getElementById('authCode').value
      );
      toast('注册成功！您的用户 ID：' + result.userId + '（请妥善保存，登录时使用）');
    } else {
      result = await login(
        document.getElementById('authUserId').value,
        document.getElementById('authPassword').value,
        remember
      );
    }
    closeAuthModal();
    if (authSuccessHandler) authSuccessHandler(result.user);
  };
  const run = withGhLock('auth-submit', task);
  if (!run) {
    msg.textContent = '正在处理中，请稍候…';
    return;
  }
  btn.disabled = true;
  btn.textContent = '处理中...';
  try {
    await run;
  } catch (e) {
    msg.textContent = e.message || '操作失败';
  } finally {
    btn.disabled = false;
    btn.textContent = document.querySelector('.auth-tab.active').dataset.authTab === 'login' ? '登录' : '注册';
  }
}
