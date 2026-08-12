/**
 * 用户数据层：基于 GitHub 仓库的 users 目录
 *  - users/_index.txt         用户索引（快速登录定位）
 *  - users/<userId>/info.json 用户数据（含 stats / whitelist / blacklist / devices）
 *  - users/<userId>/private/  头像隐私目录
 *  - users/<userId>/projects/ 云端项目
 */
import {
  requireConfig, buildPath, ghRead, ghWrite, ghDelete, listFiles, listDirs,
} from './github.js';
import { dbEnabled, dbAppendLog, DB_TYPES } from './dbstable.js';
import { dbUserSync, dbUserEnabled, dbUserFindByEmail } from './dbusers.js';
import { mailEnabled, mailVerifyCode, mailClearCode, validateEmail } from './mail.js';

export const SESSION_KEY = 'fnplt_mine_session';
export const PLOTTER_SESSION_LS = 'fnplt_session_ls';
export const PLOTTER_SESSION_SS = 'fnplt_session_ss';
export const SESSION_TTL = 2 * 24 * 3600 * 1000; // 2 天
export const MAX_DEVICES = 30;

let lastIp = '';

/* ---------- 索引文件 ---------- */
/* 行格式：userId|name|folder|ip|registeredAt */
export function parseIndex(text) {
  const map = {};
  String(text || '').split('\n').forEach((line) => {
    const parts = line.split('|');
    if (parts.length >= 3 && parts[0]) {
      map[parts[0]] = {
        id: parts[0],
        name: parts[1] || '',
        folder: parts[2] || '',
        ip: parts[3] || '',
        registeredAt: parts[4] ? Number(parts[4]) : 0,
      };
    }
  });
  return map;
}

export function indexLine(rec) {
  return [rec.id, rec.name, rec.folder, rec.ip || '', rec.registeredAt || 0].join('|');
}

export async function readIndex(cfg) {
  const text = await ghRead(cfg, buildPath(cfg.usersRoot, '_index.txt'));
  return parseIndex(text);
}

export async function writeIndex(cfg, map) {
  const lines = Object.keys(map).map((k) => indexLine(map[k]));
  await ghWrite(cfg, buildPath(cfg.usersRoot, '_index.txt'), lines.join('\n'), 'Update user index');
}

/* ---------- 用户数据 ---------- */
export function userFolder(cfg, userId) {
  return buildPath(cfg.usersRoot, String(userId));
}

export function infoPath(cfg, userId) {
  return buildPath(cfg.usersRoot, String(userId), 'info.json');
}

export async function readUser(cfg, userId) {
  const raw = await ghRead(cfg, infoPath(cfg, userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export async function writeUser(cfg, user) {
  await ghWrite(cfg, infoPath(cfg, user.id), JSON.stringify(user, null, 2), 'Update user ' + user.id);
  await dbUserSync(user);
}

/* 邮箱反查用户：读优先点鸭 users 表（email 字段），失败/空回退遍历 GitHub users 目录下各 info.json */
export async function findUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  try {
    if (dbUserEnabled()) {
      const row = await dbUserFindByEmail(e);
      if (row && row.user_id) return { userId: String(row.user_id), name: String(row.name || '') };
    }
  } catch (err) {}
  try {
    const cfg = requireConfig();
    const dirs = await listDirs(cfg, cfg.usersRoot);
    for (const d of dirs) {
      try {
        const u = await readUser(cfg, d.name);
        if (u && u.id && u.email && String(u.email).trim().toLowerCase() === e) {
          return { userId: String(u.id), name: String(u.name || '') };
        }
      } catch (err) {}
    }
  } catch (err) {}
  return null;
}

/* ---------- 访问者 IP（借鉴 auth.js，多候选服务） ---------- */
export async function getClientIP() {
  if (lastIp) return lastIp;
  const cands = [
    'https://api.ipify.org?format=json',
    'https://ipinfo.io/ip',
    'https://api.ip.sb/ip',
  ];
  for (const c of cands) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(c, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      let text = (await res.text()).trim();
      try {
        text = (JSON.parse(text).ip || '').trim();
      } catch (e) {}
      if (text && /^[\d.:a-fA-F]+$/.test(text)) {
        lastIp = text;
        return text;
      }
    } catch (e) {}
  }
  return '';
}

/* ---------- 会话 ---------- */
export function setSession(userId, remember, userSnapshot) {
  const now = Date.now();
  const obj = {
    v: 1,
    userId: String(userId),
    ts: now,
    expires: remember ? now + SESSION_TTL : null,
    user: userSnapshot || null,
  };
  try {
    if (remember) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(obj));
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(obj));
      localStorage.removeItem(SESSION_KEY);
    }
  } catch (e) {}
}

export function getSession() {
  let raw = null;
  try {
    raw = localStorage.getItem(SESSION_KEY);
  } catch (e) {}
  if (raw == null) {
    try {
      raw = sessionStorage.getItem(SESSION_KEY);
    } catch (e) {}
  }
  if (raw == null) {
    try {
      raw = localStorage.getItem(PLOTTER_SESSION_LS);
    } catch (e) {}
  }
  if (raw == null) {
    try {
      raw = sessionStorage.getItem(PLOTTER_SESSION_SS);
    } catch (e) {}
  }
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== 1 || !obj.userId) return null;
    if (obj.expires && Date.now() > obj.expires) {
      clearSession();
      return null;
    }
    return obj;
  } catch (e) {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(PLOTTER_SESSION_LS);
    sessionStorage.removeItem(PLOTTER_SESSION_SS);
  } catch (e) {}
}

export function isLoggedIn() {
  return !!getSession();
}

export function getCurrentUser() {
  const s = getSession();
  return s ? s.user || null : null;
}

/* 登录后从仓库同步最新 info.json */
export async function refreshUser() {
  const s = getSession();
  if (!s) return null;
  try {
    const cfg = requireConfig();
    const u = await readUser(cfg, s.userId);
    if (u) {
      s.user = u;
      setSession(s.userId, !!localStorage.getItem(SESSION_KEY), u);
      return u;
    }
  } catch (e) {}
  return s.user || null;
}

/* ---------- 用户操作 ---------- */
function genUserId() {
  const pool = 'abcdefghijklmnopqrstuvwxyz';
  let letters = '';
  for (let i = 0; i < 5; i++) letters += pool.charAt(Math.floor(Math.random() * pool.length));
  let digits = '';
  for (let j = 0; j < 8; j++) digits += Math.floor(Math.random() * 10);
  return 'hsjsq_wkh_' + letters + '_' + digits;
}

export function validateName(name) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) throw new Error('昵称不能为空');
  return n;
}

export function validatePassword(pw) {
  const p = String(pw || '');
  if (p.length < 6) throw new Error('密码至少 6 位');
  return p;
}

export async function register(name, password, remember, email, code) {
  const cfg = requireConfig();
  const n = validateName(name);
  const pw = validatePassword(password);
  /* 邮箱验证：邮件服务启用后注册必须绑定邮箱（邮箱+验证码），防止无邮箱批量注册 */
  const userEmail = email ? validateEmail(email) : '';
  if (mailEnabled()) {
    if (!userEmail) throw new Error('邮件验证码服务已启用，注册需填写邮箱');
    if (!mailVerifyCode(userEmail, code)) throw new Error('验证码错误或已失效，请重新获取');
    const dup = await findUserByEmail(userEmail);
    if (dup) throw new Error('该邮箱已被其他账号绑定，请更换邮箱');
  }
  const map = await readIndex(cfg);
  let userId = genUserId();
  let guard = 0;
  while (map[userId] && guard++ < 50) userId = genUserId();
  const now = Date.now();
  const user = {
    id: userId,
    name: n,
    password: pw,
    avatar: '',
    role: 'user',
    email: userEmail,
    emailBoundAt: userEmail ? now : 0,
    registeredAt: now,
    lastLoginAt: now,
    whitelist: [],
    blacklist: [],
    devices: [],
    stats: { uploadedQuestions: 0, knowledgePoints: 0, mistakes: 0, sharedWorks: 0 },
  };
  await writeUser(cfg, user);
  map[userId] = { id: userId, name: n, folder: userFolder(cfg, userId), ip: '', registeredAt: now };
  await writeIndex(cfg, map);
  await appendUploadLog(cfg, userId, '注册账号');
  if (userEmail) mailClearCode();
  setSession(userId, !!remember, user);
  return { userId, user };
}

export async function login(userIdOrEmail, password, remember) {
  const cfg = requireConfig();
  let id = String(userIdOrEmail || '').trim();
  if (!id || !password) throw new Error('请输入用户 ID 或邮箱和密码');
  /* 邮箱登录：输入含 @ 视为邮箱，反查绑定的用户 ID */
  if (id.indexOf('@') >= 0) {
    const found = await findUserByEmail(id);
    if (!found) throw new Error('该邮箱未绑定任何账号，请先注册或绑定邮箱');
    id = found.userId;
  }
  const map = await readIndex(cfg);
  if (!map[id]) throw new Error('用户不存在：请检查用户 ID，或先注册');
  const user = await readUser(cfg, id);
  if (!user) throw new Error('用户数据读取失败（info.json 不存在）');
  if (user.password !== String(password)) throw new Error('密码错误');

  const ip = await getClientIP();
  /* 登录白名单：非空时仅允许列表内 IP */
  const whitelist = Array.isArray(user.whitelist) ? user.whitelist : [];
  if (whitelist.length) {
    if (!ip) throw new Error('该账号已开启 IP 白名单，但无法获取当前 IP，请检查网络后重试');
    if (!whitelist.includes(ip)) throw new Error('当前 IP 不在该账号的登录白名单中，无法登录');
  }
  /* IP 黑名单 */
  const blacklist = Array.isArray(user.blacklist) ? user.blacklist : [];
  if (ip && blacklist.includes(ip)) throw new Error('您已被该账户拉入 IP 黑名单，无法登录');

  const now = Date.now();
  user.ip = ip || user.ip;
  user.lastLoginAt = now;
  const devices = Array.isArray(user.devices) ? user.devices : [];
  devices.unshift({ ip, ua: String(navigator.userAgent || '').slice(0, 160), time: now, action: 'login' });
  user.devices = devices.slice(0, MAX_DEVICES);
  try {
    await writeUser(cfg, user);
  } catch (e) {}
  try {
    map[id].name = user.name;
    await writeIndex(cfg, map);
  } catch (e) {}
  setSession(id, !!remember, user);
  return { userId: id, user };
}

/* 上传记录：写入 <usersRoot>/<userId>/uploads.log 与数据表（防误以为上传失败，尽力而为） */
export async function appendUploadLog(cfg, userId, entry) {
  if (dbEnabled()) {
    await dbAppendLog(DB_TYPES.UPLOAD_LOG, userId, '', '', { msg: String(entry).slice(0, 200) });
  }
  try {
    const path = buildPath(userFolder(cfg, userId), 'uploads.log');
    const existing = await ghRead(cfg, path);
    const lines = existing ? existing.split('\n').filter(Boolean) : [];
    lines.push(new Date().toISOString() + ' | ' + String(entry).slice(0, 200));
    await ghWrite(cfg, path, lines.join('\n'), 'Append upload log ' + userId);
  } catch (e) {}
}

/* 通用资料更新：读 info.json → 打补丁 → 写回 → 更新会话 */
async function updateUser(userId, patch) {  const cfg = requireConfig();
  const user = await readUser(cfg, userId);
  if (!user) throw new Error('用户数据读取失败');
  Object.assign(user, patch);
  await writeUser(cfg, user);
  if (patch.name) {
    try {
      const map = await readIndex(cfg);
      if (map[user.id]) {
        map[user.id].name = user.name;
        await writeIndex(cfg, map);
      }
    } catch (e) {}
  }
  setSession(userId, !!localStorage.getItem(SESSION_KEY), user);
  return user;
}

export async function changeName(newName) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  const n = validateName(newName);
  return updateUser(s.userId, { name: n });
}

export async function changePassword(oldPw, newPw) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  const cfg = requireConfig();
  const user = await readUser(cfg, s.userId);
  if (!user) throw new Error('用户数据读取失败');
  if (user.password !== String(oldPw)) throw new Error('原密码错误');
  validatePassword(newPw);
  if (String(newPw) === String(oldPw)) throw new Error('新密码不能与原密码相同');
  user.password = String(newPw);
  await writeUser(cfg, user);
  setSession(s.userId, !!localStorage.getItem(SESSION_KEY), user);
  return user;
}

export async function setWhitelist(list) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  const arr = (list || []).map((x) => String(x).trim()).filter(Boolean);
  return updateUser(s.userId, { whitelist: arr });
}

export async function setBlacklist(list) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  const arr = (list || []).map((x) => String(x).trim()).filter(Boolean);
  return updateUser(s.userId, { blacklist: arr });
}

/* 绑定 / 换绑邮箱：校验验证码由 UI 层完成，此处做唯一性与写入（允许当前用户重复绑定=换绑） */
export async function bindEmail(email) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  const e = validateEmail(email);
  if (!mailEnabled()) throw new Error('邮件验证码服务未配置，无法绑定邮箱');
  const dup = await findUserByEmail(e);
  if (dup && dup.userId !== s.userId) throw new Error('该邮箱已被其他账号绑定，请更换邮箱');
  return updateUser(s.userId, { email: e, emailBoundAt: Date.now() });
}

/* 上传头像：写入 <usersRoot>/<userId>/private/avatar.ext（借鉴 auth.js uploadAvatar） */
export async function uploadAvatar(file) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  if (!file) throw new Error('请选择图片文件');
  if (!/image\/(png|jpe?g|gif|webp)/i.test(file.type || '')) throw new Error('仅支持 png/jpg/jpeg/gif/webp 图片');
  if (file.size > 5 * 1024 * 1024) throw new Error('头像图片不能超过 5MB');
  const cfg = requireConfig();
  const ext = file.type === 'image/png' ? '.png' : file.type === 'image/gif' ? '.gif' : file.type === 'image/webp' ? '.webp' : '.jpg';
  const path = buildPath(userFolder(cfg, s.userId), 'private', 'avatar' + ext);
  const b64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b = String(reader.result).split(',')[1];
      if (b) resolve(b);
      else reject(new Error('图片读取失败'));
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
  await ghWrite(cfg, path, b64, 'Upload avatar ' + s.userId, true);
  await appendUploadLog(cfg, s.userId, '上传头像 ' + path);
  /* 文件处理状态记录（recordFileStatus 定义于 filestatus.js，合并后为全局函数，避免循环 import） */
  try { recordFileStatus('头像', file.name, '已上传'); } catch (e) {}
  return updateUser(s.userId, { avatar: path, avatarUpdated: Date.now() });
}

/* 设置头像路径（公开头像直接存仓库相对路径；传空字符串则回到姓名首字母头像） */
export async function setAvatarPath(path) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  return updateUser(s.userId, { avatar: String(path || ''), avatarUpdated: Date.now() });
}

/* 注销账户：真实删除仓库数据（info.json + private/ + projects/ + 公开作品 + 索引记录） */
export async function deleteAccount() {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  const cfg = requireConfig();
  const id = s.userId;
  const base = userFolder(cfg, id);

  try {
    const projects = await listDirs(cfg, buildPath(base, 'projects'));
    for (const d of projects) {
      try {
        const files = await listFiles(cfg, buildPath(base, 'projects', d.name));
        for (const f of files) {
          await ghDelete(cfg, buildPath(base, 'projects', d.name, f.name), 'Delete project ' + f.name);
        }
      } catch (e) {}
    }
  } catch (e) {}
  try {
    const loose = await listFiles(cfg, buildPath(base, 'projects'));
    for (const f of loose) await ghDelete(cfg, buildPath(base, 'projects', f.name), 'Delete project ' + f.name);
  } catch (e) {}
  try {
    const privates = await listFiles(cfg, buildPath(base, 'private'));
    for (const f of privates) await ghDelete(cfg, buildPath(base, 'private', f.name), 'Delete private file');
  } catch (e) {}
  try {
    /* 公开作品索引（整改后）：share/<id>/share/works.json 单文件索引 */
    await ghDelete(cfg, buildPath(cfg.shareRoot, id, 'share', 'works.json'), 'Delete shared index');
    /* 兼容历史：旧复制作品目录（shareRoot/<id>/<作品>/），share 目录仅删索引文件 */
    const sharedDirs = await listDirs(cfg, buildPath(cfg.shareRoot, id));
    for (const d of sharedDirs) {
      if (d.name === 'share') continue;
      const files = await listFiles(cfg, buildPath(cfg.shareRoot, id, d.name));
      for (const f of files) {
        await ghDelete(cfg, buildPath(cfg.shareRoot, id, d.name, f.name), 'Delete shared work');
      }
    }
    const looseShared = await listFiles(cfg, buildPath(cfg.shareRoot, id));
    for (const f of looseShared) await ghDelete(cfg, buildPath(cfg.shareRoot, id, f.name), 'Delete shared work');
  } catch (e) {}
  await ghDelete(cfg, infoPath(cfg, id), 'Delete user ' + id);

  try {
    const map = await readIndex(cfg);
    if (map[id]) {
      delete map[id];
      await writeIndex(cfg, map);
    }
  } catch (e) {}

  clearSession();
  return id;
}

/* ---------- 动态统计 ---------- */
/**
 * 根据仓库数据计算统计块：
 *  - 云端项目：users/<id>/projects/ 下子目录数
 *  - 上传题目 / 知识点 / 错题：info.json.stats
 *  - 公开作品：share/<id>/ 下子目录数（一个文件夹对应一个项目，失败则回退 info.json.stats.sharedWorks）
 */
export async function getStats(user) {
  const empty = { cloudProjects: 0, uploadedQuestions: 0, knowledgePoints: 0, mistakes: 0, sharedWorks: 0 };
  if (!user || !user.id) return empty;
  const stats = user.stats || {};
  const result = {
    cloudProjects: 0,
    uploadedQuestions: stats.uploadedQuestions || 0,
    knowledgePoints: stats.knowledgePoints || 0,
    mistakes: stats.mistakes || 0,
    sharedWorks: stats.sharedWorks || 0,
  };
  try {
    const cfg = requireConfig();
    const projects = await listDirs(cfg, buildPath(userFolder(cfg, user.id), 'projects'));
    result.cloudProjects = projects.length;
  } catch (e) {}
  try {
    const cfg = requireConfig();
    /* 公开作品：share/<id>/share/works.json 索引条目数（整改后），失败回退 info.json.stats.sharedWorks */
    const raw = await ghRead(cfg, buildPath(cfg.shareRoot, user.id, 'share', 'works.json'));
    if (raw) {
      const d = JSON.parse(raw);
      if (d && typeof d === 'object' && !Array.isArray(d)) result.sharedWorks = Object.keys(d).length;
    }
  } catch (e) {}
  return result;
}

export function isAdminUser(user) {
  return !!(user && (user.role === 'admin' || user.role === '管理员'));
}
