/**
 * 个人资料页（页签「个人资料」）：
 * 昵称 / 密码 / 头像 / 白名单 / 设备记录 / 黑名单 / 退出 / 切换登录 / 注销账户
 */
import { toast } from './utils.js';
import { renderAvatar } from './avatar.js';
import { openAuthModal } from './auth-ui.js';
import { openDevicesPage } from './devices.js';
import { requireConfig, listFiles, fileUrl, buildPath } from './github.js';
import {
  getCurrentUser,
  changeName,
  changePassword,
  setWhitelist,
  setBlacklist,
  uploadAvatar,
  setAvatarPath,
  clearSession,
  deleteAccount,
  bindEmail,
} from './user.js';
import { mailEnabled, mailSendCode, mailVerifyCode, validateEmail } from './mail.js';

/* 登录态变化后的全局刷新回调（由 app.js 注入，避免循环依赖） */
let onUserChanged = null; // (user) => void
let onNavigate = null; // (pageId) => void

export function setProfileHooks(changed, navigate) {
  onUserChanged = changed;
  onNavigate = navigate;
}

export function initProfileSettings() {
  document.getElementById('psRenameBtn').addEventListener('click', onRename);
  document.getElementById('psPwBtn').addEventListener('click', onChangePassword);
  document.getElementById('psAvatarBtn').addEventListener('click', openAvatarModal);
  document.getElementById('psWhitelistBtn').addEventListener('click', () => openListModal('whitelist'));
  document.getElementById('psBlacklistBtn').addEventListener('click', () => openListModal('blacklist'));
  document.getElementById('psDevicesBtn').addEventListener('click', openDevicesPage);
  document.getElementById('psLogoutBtn').addEventListener('click', onLogout);
  document.getElementById('psEmailBtn').addEventListener('click', openEmailModal);
  document.getElementById('psSwitchBtn').addEventListener('click', () => {
    if (!requireLogin()) return;
    clearSession();
    onUserChanged && onUserChanged(null);
    openAuthModal();
  });
  document.getElementById('psDeleteBtn').addEventListener('click', onDeleteAccount);

  bindAvatarModal();

  /* 绑定 / 换绑邮箱弹窗 */
  document.getElementById('emailConfirmBtn').addEventListener('click', confirmEmailModal);
  document.getElementById('emailCancelBtn').addEventListener('click', closeEmailModal);
  document.getElementById('emailCloseBtn').addEventListener('click', closeEmailModal);
  document.getElementById('emailCodeBtn').addEventListener('click', sendEmailCode);
  const emailOverlay = document.getElementById('emailOverlay');
  if (emailOverlay) {
    emailOverlay.addEventListener('click', (e) => {
      if (e.target === emailOverlay) closeEmailModal();
    });
    document.getElementById('emailCodeInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmEmailModal();
    });
  }

  /* 名单编辑弹窗 */
  document.getElementById('listSaveBtn').addEventListener('click', saveListModal);
  document.getElementById('listCancelBtn').addEventListener('click', closeListModal);
  document.getElementById('listCloseBtn').addEventListener('click', closeListModal);
  const overlay = document.getElementById('listOverlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeListModal();
    });
  }
}

export async function showProfileSettings() {
  const user = getCurrentUser();
  renderProfile(user);
}

function requireLogin() {
  const user = getCurrentUser();
  if (!user) {
    toast('请先登录');
    openAuthModal();
    return null;
  }
  return user;
}

function renderProfile(user) {
  const name = (user && user.name) || '未登录';
  document.getElementById('psName').textContent = name;
  document.getElementById('psId').textContent = user ? 'ID：' + user.id : 'ID：未登录';
  renderAvatar('psAvatar', 'psAvatarImg', user, name);
  const emailText = document.getElementById('psEmailText');
  const emailBtn = document.getElementById('psEmailBtn');
  if (user && user.email) {
    emailText.textContent = user.email;
    emailBtn.textContent = '换绑邮箱';
  } else {
    emailText.textContent = '未绑定邮箱';
    emailBtn.textContent = '绑定邮箱';
  }
}

async function onRename() {
  const user = requireLogin();
  if (!user) return;
  const next = window.prompt('请输入新昵称：', user.name);
  if (next == null || String(next).trim() === user.name) return;
  try {
    const updated = await changeName(String(next));
    onUserChanged && onUserChanged(updated);
    renderProfile(updated);
    toast('昵称已更新');
  } catch (e) {
    toast(e.message || '修改失败');
  }
}

async function onChangePassword() {
  if (!requireLogin()) return;
  const oldPw = window.prompt('请输入原密码：');
  if (oldPw == null) return;
  const newPw = window.prompt('请输入新密码（至少 6 位）：');
  if (newPw == null) return;
  const confirmPw = window.prompt('请再次输入新密码：');
  if (newPw !== confirmPw) {
    toast('两次输入的新密码不一致');
    return;
  }
  try {
    const updated = await changePassword(oldPw, newPw);
    onUserChanged && onUserChanged(updated);
    toast('密码已修改');
  } catch (e) {
    toast(e.message || '修改失败');
  }
}

/* ---------- 更换头像弹窗 ---------- */
const LETTER_COLORS = [
  'linear-gradient(135deg,#0ea5e9,#6366f1)',
  'linear-gradient(135deg,#f59e0b,#f97316)',
  'linear-gradient(135deg,#10b981,#14b8a6)',
  'linear-gradient(135deg,#ec4899,#a855f7)',
  'linear-gradient(135deg,#8b5cf6,#6366f1)',
  'linear-gradient(135deg,#ef4444,#f97316)',
];

let avatarSelected = null; // {type:'public',path} | {type:'local',file} | {type:'letter'}
let avatarBusy = false;

function psEscAttr(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function openAvatarModal() {
  const user = requireLogin();
  if (!user) return;
  avatarSelected = null;
  avatarBusy = false;
  renderAvatar('avCurrent', 'avCurrentImg', user, user.name);
  renderAvatar('avPreview', 'avPreviewImg', user, user.name);
  document.querySelectorAll('#avPublicList .avatar-pub-item').forEach((x) => x.classList.remove('selected'));
  document.getElementById('avatarOverlay').classList.add('show');
  loadPublicAvatars();
}

function closeAvatarModal() {
  document.getElementById('avatarOverlay').classList.remove('show');
}

/* 预览：展示图片 */
function setPreviewUrl(url) {
  const img = document.getElementById('avPreviewImg');
  const letter = document.getElementById('avPreview').querySelector('.avatar-letter');
  if (img) {
    img.src = url;
    img.classList.remove('hidden');
  }
  if (letter) letter.classList.add('hidden');
}

/* 预览：展示字母头像（文字统一为「学」） */
function setPreviewLetter(text, color) {
  const holder = document.getElementById('avPreview');
  const img = document.getElementById('avPreviewImg');
  const letter = holder.querySelector('.avatar-letter');
  if (img) img.classList.add('hidden');
  if (letter) {
    letter.textContent = '学';
    letter.classList.remove('hidden');
  }
  if (color) holder.style.background = color;
}

/* 从仓库 avatarsRoot 目录加载公用头像；为空则展示内置字母头像（文字统一为「学」） */
async function loadPublicAvatars() {
  const list = document.getElementById('avPublicList');
  const letter = '学';
  let cfg = null;
  let files = [];
  try {
    cfg = requireConfig();
    const dirFiles = await listFiles(cfg, cfg.avatarsRoot);
    files = dirFiles.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.name));
  } catch (e) {}
  if (cfg && files.length) {
    list.innerHTML = files
      .map((f) => {
        const path = buildPath(cfg.avatarsRoot, f.name);
        return '<button class="avatar-pub-item" data-type="public" data-path="' + psEscAttr(path) + '" title="' + psEscAttr(f.name) + '">' +
          '<img src="' + psEscAttr(fileUrl(cfg, path)) + '" alt="' + psEscAttr(f.name) + '" />' +
          '</button>';
      })
      .join('');
  } else {
    const l = String(letter).slice(0, 1);
    list.innerHTML = LETTER_COLORS.map((color, i) =>
      '<button class="avatar-pub-item letter" data-type="letter" data-color="' + i + '" style="background:' + color + '">' + l + '</button>'
    ).join('') +
      '<span class="avatar-pub-empty">仓库暂无公用头像，字母头像选择后将回到「学」字头像</span>';
  }
}

function bindAvatarModal() {
  document.getElementById('avatarCloseBtn').addEventListener('click', closeAvatarModal);
  document.getElementById('avatarCancelBtn').addEventListener('click', closeAvatarModal);
  const overlay = document.getElementById('avatarOverlay');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeAvatarModal();
  });

  document.getElementById('avatarUploadBtn').addEventListener('click', () => {
    if (!requireLogin()) return;
    if (avatarBusy) return;
    document.getElementById('avatarFile').click();
  });

  document.getElementById('avatarFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/image\/(png|jpe?g|gif|webp)/i.test(file.type || '')) {
      toast('仅支持 png/jpg/jpeg/gif/webp 图片');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast('头像图片不能超过 5MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      avatarSelected = { type: 'local', file };
      setPreviewUrl(String(reader.result));
    };
    reader.onerror = () => toast('图片读取失败');
    reader.readAsDataURL(file);
  });

  document.getElementById('avPublicList').addEventListener('click', (e) => {
    const item = e.target.closest('.avatar-pub-item');
    if (!item) return;
    document.querySelectorAll('#avPublicList .avatar-pub-item').forEach((x) => x.classList.remove('selected'));
    item.classList.add('selected');
    if (item.dataset.type === 'public') {
      avatarSelected = { type: 'public', path: item.dataset.path };
      const img = item.querySelector('img');
      if (img) setPreviewUrl(img.src);
    } else {
      avatarSelected = { type: 'letter' };
      setPreviewLetter(item.textContent, item.style.background);
    }
  });

  document.getElementById('avatarConfirmBtn').addEventListener('click', confirmAvatar);
}

async function confirmAvatar() {
  if (avatarBusy) return;
  const user = requireLogin();
  if (!user) return;
  if (!avatarSelected) {
    closeAvatarModal();
    return;
  }
  const btn = document.getElementById('avatarConfirmBtn');
  avatarBusy = true;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '保存中…';
  try {
    let updated;
    if (avatarSelected.type === 'local') {
      updated = await uploadAvatar(avatarSelected.file);
    } else if (avatarSelected.type === 'public') {
      updated = await setAvatarPath(avatarSelected.path);
    } else {
      updated = await setAvatarPath('');
    }
    onUserChanged && onUserChanged(updated);
    renderProfile(updated);
    closeAvatarModal();
    toast('头像已更新');
  } catch (err) {
    toast(err.message || '头像更新失败');
  } finally {
    avatarBusy = false;
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function editWhitelist(kind) {
  const user = requireLogin();
  if (!user) return;
  const current = user[kind] || [];
  const input = window.prompt(
    kind === 'whitelist' ? '登录白名单（仅允许这些 IP 登录，留空则不限制）：' : 'IP 黑名单（禁止这些 IP 登录，逗号分隔）：',
    current.join(', ')
  );
  if (input == null) return;
  const list = input.split(/[,，\s]+/).filter(Boolean);
  try {
    const updated = kind === 'whitelist' ? await setWhitelist(list) : await setBlacklist(list);
    onUserChanged && onUserChanged(updated);
    renderProfile(updated);
    toast(kind === 'whitelist' ? '白名单已更新' : '黑名单已更新');
  } catch (e) {
    toast(e.message || '更新失败');
  }
}

/* ---------- 白名单 / 黑名单 自定义 UI 弹窗（多行输入框编辑，非原生弹窗） ---------- */
let listKind = 'whitelist';

export function openListModal(kind) {
  const user = requireLogin();
  if (!user) return;
  listKind = kind;
  const isWl = kind === 'whitelist';
  document.getElementById('listModalTitle').textContent = isWl ? '编辑登录白名单' : '编辑 IP 黑名单';
  document.getElementById('listModalHint').textContent = isWl
    ? '每行一个 IP；留空保存后白名单清空（即不限制登录）'
    : '每行一个 IP；留空保存后黑名单清空（即不禁止登录）';
  document.getElementById('listTextarea').value = (user[kind] || []).join('\n');
  document.getElementById('listOverlay').classList.add('show');
}

function closeListModal() {
  const overlay = document.getElementById('listOverlay');
  if (overlay) overlay.classList.remove('show');
}

/* ---------- 绑定 / 换绑邮箱弹窗 ---------- */
let emailBusy = false;

function openEmailModal() {
  const user = requireLogin();
  if (!user) return;
  emailBusy = false;
  document.getElementById('emailMsg').textContent = '';
  document.getElementById('emailInput').value = '';
  document.getElementById('emailCodeInput').value = '';
  const codeBtn = document.getElementById('emailCodeBtn');
  codeBtn.disabled = false;
  codeBtn.textContent = '获取验证码';
  document.getElementById('emailModalTitle').textContent = user.email ? '换绑邮箱' : '绑定邮箱';
  document.getElementById('emailHint').textContent = user.email
    ? '当前绑定：' + user.email + '。换绑需验证新邮箱'
    : '绑定后可用邮箱 + 密码登录';
  const confirmBtn = document.getElementById('emailConfirmBtn');
  if (!mailEnabled()) {
    document.getElementById('emailMsg').textContent = '邮件验证码服务未配置：请先在 管理者设置 - 邮件验证码服务 中填写域名';
    confirmBtn.disabled = true;
  } else {
    confirmBtn.disabled = false;
  }
  document.getElementById('emailOverlay').classList.add('show');
}

function closeEmailModal() {
  const overlay = document.getElementById('emailOverlay');
  if (overlay) overlay.classList.remove('show');
}

async function sendEmailCode() {
  const user = requireLogin();
  if (!user) return;
  const msg = document.getElementById('emailMsg');
  msg.textContent = '';
  let email;
  try {
    email = validateEmail(document.getElementById('emailInput').value);
  } catch (e) {
    msg.textContent = e.message;
    return;
  }
  if (!mailEnabled()) {
    msg.textContent = '邮件验证码服务未配置：请先在 管理者设置 - 邮件验证码服务 中填写域名';
    return;
  }
  const btn = document.getElementById('emailCodeBtn');
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

async function confirmEmailModal() {
  const user = requireLogin();
  if (!user) return;
  if (emailBusy) return;
  const msg = document.getElementById('emailMsg');
  msg.textContent = '';
  let email, code;
  try {
    email = validateEmail(document.getElementById('emailInput').value);
    code = String(document.getElementById('emailCodeInput').value || '').trim();
  } catch (e) {
    msg.textContent = e.message;
    return;
  }
  if (!code) {
    msg.textContent = '请填写邮箱收到的验证码';
    return;
  }
  if (!mailVerifyCode(email, code)) {
    msg.textContent = '验证码错误或已失效，请重新获取';
    return;
  }
  emailBusy = true;
  const btn = document.getElementById('emailConfirmBtn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '绑定中…';
  try {
    const updated = await bindEmail(email);
    onUserChanged && onUserChanged(updated);
    renderProfile(updated);
    closeEmailModal();
    toast('邮箱已绑定');
  } catch (e) {
    msg.textContent = e.message || '绑定失败';
  } finally {
    emailBusy = false;
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function saveListModal() {
  const user = requireLogin();
  if (!user) return;
  const raw = document.getElementById('listTextarea').value;
  const list = raw.split(/[\n,，\s]+/).filter(Boolean);
  try {
    const updated = listKind === 'whitelist' ? await setWhitelist(list) : await setBlacklist(list);
    closeListModal();
    onUserChanged && onUserChanged(updated);
    renderProfile(updated);
    toast(listKind === 'whitelist' ? '白名单已更新' : '黑名单已更新');
  } catch (e) {
    toast(e.message || '更新失败');
  }
}

function onLogout() {
  if (!requireLogin()) return;
  clearSession();
  onUserChanged && onUserChanged(null);
  onNavigate && onNavigate('profile');
  toast('已退出登录');
}

async function onDeleteAccount() {
  const user = requireLogin();
  if (!user) return;
  const first = window.confirm('注销账户将永久删除账号数据（云端项目/上传题目/错题/公开作品），且不可恢复。确定继续？');
  if (!first) return;
  const id = window.prompt('请输入你的用户 ID（' + user.id + '）以确认注销：');
  if (id == null) return;
  if (String(id).trim() !== user.id) {
    toast('用户 ID 输入不正确，已取消');
    return;
  }
  const second = window.confirm('最后确认：将永久删除账号「' + user.name + '」（' + user.id + '），是否继续？');
  if (!second) return;
  try {
    await deleteAccount();
    onUserChanged && onUserChanged(null);
    onNavigate && onNavigate('profile');
    toast('账号已注销');
  } catch (e) {
    toast(e.message || '注销失败');
  }
}
