/**
 * 用户认证模块（基于 GitHub 仓库存储）
 *
 * 功能：
 *  - GitHub 仓库配置管理（token/owner/repo/branch/数据根目录/头像根目录）
 *  - 自动获取访问者 IP，判断该 IP 是否曾注册过账号（仅提示，不自动登录）
 *  - 注册 / 登录 / 退出登录 / 切换登录
 *  - 登录会话保持：勾选「2天免登录」存 localStorage，否则关闭即登出
 *  - 用户数据存仓库 <usersRoot>/<userId>/info.json，<usersRoot>/_index.txt 存快速定位索引
 *  - 用户资料修改（昵称/密码/头像/IP 黑名单/登录设备），修改即写回仓库
 *  - 10 秒内修改个人信息不超过 3 次的频率限制
 *  - 本地算术验证码（注册人机验证）
 *  - 头像：上传图片 / 选择仓库内已有头像
 *  - 管理者：配置 GitHub + 查看用户列表 + 重置用户密码
 */
(function (global) {
  'use strict';

  // ==================== 常量 ====================
  var CFG_KEY = 'fnplt_gh_config';
  var SESSION_LS_KEY = 'fnplt_session_ls';
  var SESSION_SS_KEY = 'fnplt_session_ss';
  var MINE_SESSION_KEY = 'fnplt_mine_session'; // 门户「我的页面」会话 key（同源共享，用于登录态互通）
  var SESSION_TTL = 2 * 24 * 3600 * 1000; // 2 天
  var SESSION_VERSION = 1;
  var RATE_WINDOW = 10000; // 10 秒
  var RATE_MAX = 3; // 最多 3 次
  var PW_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[\s\S]{8,16}$/; // 8-16 位，含大小写字母与数字
  var MAX_DEVICES = 10;

  // ==================== 内部状态 ====================
  var sessionCache = null; // { v, userId, ts, expires, user: <info 快照> }
  var sessionFromLs = true; // 当前会话是否来自 localStorage
  var lastIp = '';
  var rateOps = []; // 最近修改操作时间戳
  var captchas = {}; // 验证码缓存 id -> {a, b, op, answer}

  // ==================== 工具函数 ====================
  function base64ToString(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function stringToBase64(str) {
    var bytes = new TextEncoder().encode(String(str));
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function buildPath(root) {
    var parts = Array.prototype.slice.call(arguments, 1);
    var r = String(root || '').replace(/^\/+|\/+$/g, '');
    var p = parts.map(function (x) { return String(x || '').replace(/^\/+|\/+$/g, ''); }).filter(Boolean);
    return [r].concat(p).filter(Boolean).join('/');
  }
  function esc(html) {
    return String(html == null ? '' : html)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function formatTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function sanitizeName(name) {
    return String(name || '').replace(/[|\n\r]/g, '').slice(0, 20);
  }
  function avatarColor(userId) {
    var seed = 0;
    var s = String(userId || '');
    for (var i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) % 997;
    var palette = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
    return palette[seed % palette.length];
  }

  // ==================== GitHub API 封装 ====================
  var GH_MIN_INTERVAL = 300;
  var GH_CACHE_TTL = 500;
  var GH_TIMEOUT = 20000;
  var GH_BACKOFF_MS = 30000;
  var ghGetCache = {};
  var ghLastAt = 0;
  var ghBackoffUntil = 0;
  function ghSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function ghThrottle() {
    if (Date.now() < ghBackoffUntil) {
      throw new Error('GitHub API 触发限流保护，请稍候再试（退避中）');
    }
    var wait = ghLastAt + GH_MIN_INTERVAL - Date.now();
    if (wait > 0) await ghSleep(wait);
    ghLastAt = Date.now();
  }
  function ghFetch(url, opts) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, GH_TIMEOUT);
    opts.signal = ctrl.signal;
    return fetch(url, opts)
      .then(function (res) {
        clearTimeout(timer);
        return res;
      })
      .catch(function (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') throw new Error('GitHub 请求超时（20 秒），请检查网络后重试');
        throw new Error('GitHub 网络请求失败：' + (e && e.message ? e.message : '未知错误'));
      });
  }
  async function ghRequest(cfg, path, method, body, noCache) {
    var cacheKey = (cfg.branch || 'main') + ':' + path;
    if (method === 'GET' && !noCache) {
      var hit = ghGetCache[cacheKey];
      if (hit && Date.now() - hit.at < GH_CACHE_TTL) return hit.promise;
    }
    var promise = (async function () {
      await ghThrottle();
      var url = apiUrl(cfg, path) + (method === 'GET' ? '?ref=' + encodeURIComponent(cfg.branch) : '');
      var opts = { method: method, headers: ghHeaders(cfg) };
      if (body) opts.body = JSON.stringify(body);
      var res = await ghFetch(url, opts);
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 200 || res.status === 201) return data;
      if (res.status === 404) return null;
      if (res.status === 403) {
        ghBackoffUntil = Date.now() + GH_BACKOFF_MS;
        throw new Error('GitHub API 限流或权限不足，已暂停请求 ' + (GH_BACKOFF_MS / 1000) + ' 秒：' + (data.message || 'HTTP 403'));
      }
      if (res.status === 401) throw new Error('GitHub token 无效或无权限（请检查管理者配置）：' + (data.message || 'HTTP 401'));
      throw new Error((data.message || ('GitHub HTTP ' + res.status)));
    })();
    if (method === 'GET' && !noCache) {
      ghGetCache[cacheKey] = { at: Date.now(), promise: promise };
      promise.catch(function () {
        if (ghGetCache[cacheKey] && ghGetCache[cacheKey].promise === promise) delete ghGetCache[cacheKey];
      });
    }
    return promise;
  }
  // 读取文件文本（base64 解码）；目录返回数组
  async function ghRead(cfg, path) {
    var d = await ghRequest(cfg, path, 'GET');
    if (d == null) return null;
    if (Array.isArray(d)) return d;
    if (d.content) return base64ToString(d.content);
    return null;
  }
  async function ghWrite(cfg, path, content, message, isBase64) {
    var existing = await ghRequest(cfg, path, 'GET', null, true);
    var body = {
      message: message || ('Update ' + path),
      content: isBase64 ? content : stringToBase64(content),
      branch: cfg.branch
    };
    if (existing && existing.sha) body.sha = existing.sha;
    var d = await ghRequest(cfg, path, 'PUT', body);
    return d;
  }
  async function ghDelete(cfg, path, message) {
    var existing = await ghRequest(cfg, path, 'GET', null, true);
    if (!existing || !existing.sha) return true;
    var body = { message: message || ('Delete ' + path), branch: cfg.branch, sha: existing.sha };
    var res = await ghFetch(apiUrl(cfg, path), { method: 'DELETE', headers: ghHeaders(cfg), body: JSON.stringify(body) });
    return res.status === 200;
  }
  function getConfig() {
    // 优先自己的配置；没有则回退读取门户站点的配置（fnplt_gh_config_v2，同源共享 localStorage）
    try {
      var c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (c && c.token && c.owner && c.repo) return c;
    } catch (e) {}
    try {
      var c2 = JSON.parse(localStorage.getItem('fnplt_gh_config_v2') || 'null');
      if (c2 && c2.token && c2.owner && c2.repo) return c2;
    } catch (e2) {}
    return null;
  }
  function saveConfig(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }
  function requireConfig() {
    var cfg = getConfig();
    if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) {
      throw new Error('尚未配置 GitHub 仓库，请先在 设置 - 管理者 中填写 token/owner/repo');
    }
    cfg.branch = cfg.branch || 'main';
    cfg.usersRoot = cfg.usersRoot || 'users';
    cfg.avatarsRoot = cfg.avatarsRoot || 'avatars';
    cfg.shareRoot = cfg.shareRoot || 'share';
    cfg.avatarCdn = cfg.avatarCdn || 'fastly';
    return cfg;
  }
  function apiUrl(cfg, path) {
    return 'https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + path;
  }
  function ghHeaders(cfg) {
    return { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'User-Agent': 'fnplotter-auth' };
  }
  function rawUrl(cfg, path) {
    return 'https://raw.githubusercontent.com/' + cfg.owner + '/' + cfg.repo + '/' + cfg.branch + '/' + path;
  }
  // 头像加载链接：可选 raw.githubusercontent / fastly.jsdelivr.net / gcore.jsdelivr.net（默认 fastly）
  function avatarCdnUrl(cfg, path) {
    var mode = cfg.avatarCdn || 'fastly';
    if (mode === 'raw') return rawUrl(cfg, path);
    if (mode === 'gcore') return 'https://gcore.jsdelivr.net/gh/' + cfg.owner + '/' + cfg.repo + '@' + cfg.branch + '/' + path;
    return 'https://fastly.jsdelivr.net/gh/' + cfg.owner + '/' + cfg.repo + '@' + cfg.branch + '/' + path;
  }

  // ==================== 访问者 IP ====================
  async function getClientIP() {
    if (lastIp) return lastIp;
    var cands = [
      'https://api.ipify.org?format=json',
      'https://ipinfo.io/ip',
      'https://api.ip.sb/ip'
    ];
    for (var i = 0; i < cands.length; i++) {
      try {
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 6000);
        var res = await fetch(cands[i], { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        var text = (await res.text()).trim();
        var ip = text;
        try { ip = (JSON.parse(text).ip || '').trim(); } catch (e) {}
        if (ip && /^[\d\.:a-fA-F]+$/.test(ip)) { lastIp = ip; return ip; }
      } catch (e) {}
    }
    return '';
  }

  // ==================== 索引文件 ====================
  // index 行格式：userId|name|folder|ip|registeredAt
  function parseIndex(text) {
    var map = {};
    String(text || '').split('\n').forEach(function (line) {
      var parts = line.split('|');
      if (parts.length >= 3 && parts[0]) {
        map[parts[0]] = { id: parts[0], name: parts[1] || '', folder: parts[2] || '', ip: parts[3] || '', registeredAt: parts[4] ? Number(parts[4]) : 0 };
      }
    });
    return map;
  }
  function indexLine(rec) {
    return rec.id + '|' + rec.name + '|' + rec.folder + '|' + (rec.ip || '') + '|' + (rec.registeredAt || 0);
  }
  async function readIndex(cfg) {
    var text = await ghRead(cfg, buildPath(cfg.usersRoot, '_index.txt'));
    return parseIndex(text);
  }
  async function writeIndex(cfg, map) {
    var keys = Object.keys(map);
    var lines = keys.map(function (k) { return indexLine(map[k]); });
    await ghWrite(cfg, buildPath(cfg.usersRoot, '_index.txt'), lines.join('\n'), 'Update user index');
  }

  // ==================== 用户数据 ====================
  function userFolder(cfg, userId) {
    return buildPath(cfg.usersRoot, String(userId));
  }
  function infoPath(cfg, userId) {
    return buildPath(cfg.usersRoot, String(userId), 'info.json');
  }
  async function readUser(cfg, userId) {
    var raw = await ghRead(cfg, infoPath(cfg, userId));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  async function writeUser(cfg, user) {
    await ghWrite(cfg, infoPath(cfg, user.id), JSON.stringify(user, null, 2), 'Update user ' + user.id);
  }

  // ==================== 注册 / 登录 / 登出 ====================
  function genUserId() {
    // 格式：hsjsq_wkh_随机五位字母_随机八位数字
    var letters = '';
    var pool = 'abcdefghijklmnopqrstuvwxyz';
    for (var i = 0; i < 5; i++) letters += pool.charAt(Math.floor(Math.random() * pool.length));
    var digits = '';
    for (var j = 0; j < 8; j++) digits += Math.floor(Math.random() * 10);
    return 'hsjsq_wkh_' + letters + '_' + digits;
  }
  function genProjectId() {
    return 'prj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function validatePassword(pw) {
    if (!PW_RULE.test(String(pw || ''))) {
      throw new Error('密码需为 8-16 位，且同时包含大写字母、小写字母和数字');
    }
  }
  function validateName(name) {
    var n = sanitizeName(name);
    if (!n) throw new Error('昵称不能为空');
    return n;
  }

  async function register(name, password) {
    var cfg = requireConfig();
    var n = validateName(name);
    validatePassword(password);
    var map = await readIndex(cfg);
    // 生成唯一用户 ID
    var userId = genUserId();
    var guard = 0;
    while (map[userId] && guard++ < 50) userId = genUserId();
    var ip = await getClientIP();
    var now = Date.now();
    var user = {
      id: userId,
      name: n,
      password: String(password),
      ip: ip,
      blacklist: [],
      avatar: '',
      registeredAt: now,
      lastLoginAt: now,
      devices: []
    };
    await writeUser(cfg, user);
    map[userId] = { id: userId, name: n, folder: userFolder(cfg, userId), ip: ip, registeredAt: now };
    await writeIndex(cfg, map);
    setSession(userId, true);
    return { userId: userId, user: user };
  }

  async function login(id, password, remember) {
    var cfg = requireConfig();
    var userId = String(id || '').trim();
    if (!userId || !password) throw new Error('请输入用户 ID 和密码');
    if (userId.length > 50) throw new Error('用户 ID 最长 50 个字符');
    if (String(password).length > 50) throw new Error('密码最长 50 个字符');
    var map = await readIndex(cfg);
    if (!map[userId]) throw new Error('用户不存在，请检查用户 ID 或先注册');
    var user = await readUser(cfg, userId);
    if (!user) throw new Error('用户数据读取失败，请稍后重试');
    if (user.password !== String(password)) throw new Error('密码错误');
    var ip = await getClientIP();
    // IP 黑名单：填入的 IP 禁止登录该账号；空则全部 IP 可登录
    var bl = Array.isArray(user.blacklist) ? user.blacklist : [];
    if (ip && bl.indexOf(ip) >= 0) throw new Error('您已被该账户拉入黑名单，无法登录');
    var now = Date.now();
    user.ip = ip || user.ip;
    user.lastLoginAt = now;
    var devices = Array.isArray(user.devices) ? user.devices : [];
    devices.unshift({ ip: ip, ua: (navigator.userAgent || '').slice(0, 160), time: now, action: 'login' });
    user.devices = devices.slice(0, MAX_DEVICES);
    try { await writeUser(cfg, user); } catch (e) { /* 写回失败不阻断登录 */ }
    // 同步索引中的名称与最近 IP
    map[userId].name = user.name;
    map[userId].ip = ip || map[userId].ip;
    try { await writeIndex(cfg, map); } catch (e) {}
    setSession(userId, !!remember, user);
    return { userId: userId, user: user };
  }

  function setSession(userId, remember, userSnapshot) {
    var now = Date.now();
    var obj = { v: SESSION_VERSION, userId: String(userId), ts: now, expires: remember ? (now + SESSION_TTL) : null, user: userSnapshot || null };
    if (remember) {
      try { localStorage.setItem(SESSION_LS_KEY, JSON.stringify(obj)); } catch (e) {}
      try { sessionStorage.removeItem(SESSION_SS_KEY); } catch (e) {}
      sessionFromLs = true;
    } else {
      try { sessionStorage.setItem(SESSION_SS_KEY, JSON.stringify(obj)); } catch (e) {}
      try { localStorage.removeItem(SESSION_LS_KEY); } catch (e) {}
      sessionFromLs = false;
    }
    sessionCache = obj;
  }

  function getSession() {
    if (sessionCache) {
      if (sessionCache.expires && Date.now() > sessionCache.expires) { clearSession(); return null; }
      return sessionCache;
    }
    var raw = null;
    try { raw = localStorage.getItem(SESSION_LS_KEY); sessionFromLs = true; } catch (e) {}
    if (raw == null) {
      try { raw = sessionStorage.getItem(SESSION_SS_KEY); sessionFromLs = false; } catch (e) {}
    }
    if (raw == null) {
      try { raw = localStorage.getItem(MINE_SESSION_KEY); sessionFromLs = true; } catch (e) {}
    }
    if (raw == null) {
      try { raw = sessionStorage.getItem(MINE_SESSION_KEY); sessionFromLs = false; } catch (e) {}
    }
    if (!raw) return null;
    try {
      var obj = JSON.parse(raw);
      if (!obj || obj.v !== SESSION_VERSION || !obj.userId) return null;
      if (obj.expires && Date.now() > obj.expires) { clearSession(); return null; }
      sessionCache = obj;
      return obj;
    } catch (e) { return null; }
  }

  function clearSession() {
    sessionCache = null;
    try { localStorage.removeItem(SESSION_LS_KEY); } catch (e) {}
    try { sessionStorage.removeItem(SESSION_SS_KEY); } catch (e) {}
    try { localStorage.removeItem(MINE_SESSION_KEY); } catch (e) {}
    try { sessionStorage.removeItem(MINE_SESSION_KEY); } catch (e) {}
  }

  // 异步刷新当前用户最新数据（登录后从仓库同步最新信息）
  async function refreshUser() {
    var s = getSession();
    if (!s) return null;
    var cfg;
    try { cfg = requireConfig(); } catch (e) { return s.user || null; }
    try {
      var u = await readUser(cfg, s.userId);
      if (u) {
        s.user = u;
        if (sessionFromLs) localStorage.setItem(SESSION_LS_KEY, JSON.stringify(s));
        else sessionStorage.setItem(SESSION_SS_KEY, JSON.stringify(s));
        return u;
      }
    } catch (e) {}
    return s.user || null;
  }

  function isLoggedIn() {
    return !!getSession();
  }
  function getCurrentUser() {
    var s = getSession();
    return s ? (s.user || null) : null;
  }

  // ==================== 资料修改（带频率限制） ====================
  function checkRateLimit() {
    var now = Date.now();
    rateOps = rateOps.filter(function (t) { return now - t < RATE_WINDOW; });
    if (rateOps.length >= RATE_MAX) {
      throw new Error('操作过于频繁：10 秒内最多修改 3 次个人资料，请稍后再试');
    }
    rateOps.push(now);
  }
  function resetRateLimit() { rateOps = []; }

  async function updateCurrentUser(patch) {
    checkRateLimit();
    var cfg = requireConfig();
    var s = getSession();
    if (!s || !s.userId) throw new Error('未登录');
    var user = await readUser(cfg, s.userId);
    if (!user) throw new Error('用户数据读取失败');
    var changed = {};
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        user[k] = patch[k];
        changed[k] = true;
      }
    }
    await writeUser(cfg, user);
    // 若昵称变化，同步索引
    if (changed.name) {
      try {
        var map = await readIndex(cfg);
        if (map[user.id]) { map[user.id].name = user.name; await writeIndex(cfg, map); }
      } catch (e) {}
    }
    s.user = user;
    if (sessionFromLs) localStorage.setItem(SESSION_LS_KEY, JSON.stringify(s));
    else sessionStorage.setItem(SESSION_SS_KEY, JSON.stringify(s));
    return user;
  }

  async function changeName(newName) {
    var n = validateName(newName);
    return await updateCurrentUser({ name: n });
  }

  async function changePassword(oldPw, newPw) {
    var cfg = requireConfig();
    var s = getSession();
    if (!s || !s.userId) throw new Error('未登录');
    checkRateLimit();
    var user = await readUser(cfg, s.userId);
    if (!user) throw new Error('用户数据读取失败');
    if (user.password !== String(oldPw)) throw new Error('原密码错误');
    validatePassword(newPw);
    if (newPw === oldPw) throw new Error('新密码不能与原密码相同');
    user.password = String(newPw);
    await writeUser(cfg, user);
    s.user = user;
    if (sessionFromLs) localStorage.setItem(SESSION_LS_KEY, JSON.stringify(s));
    else sessionStorage.setItem(SESSION_SS_KEY, JSON.stringify(s));
    return user;
  }

  async function setBlacklist(list) {
    var arr = (list || []).map(function (x) { return String(x).trim(); }).filter(Boolean);
    return await updateCurrentUser({ blacklist: arr });
  }

  async function setAvatar(pathOrEmpty) {
    return await updateCurrentUser({ avatar: String(pathOrEmpty || ''), avatarUpdated: Date.now() });
  }

  // ==================== 头像上传与仓库选择 ====================
  async function uploadAvatar(file) {
    var cfg = requireConfig();
    var s = getSession();
    if (!s || !s.userId) throw new Error('未登录');
    if (!file) throw new Error('请选择图片文件');
    if (!/image\/(png|jpe?g|gif|webp)/i.test(file.type || '')) throw new Error('仅支持 png/jpg/jpeg/gif/webp 图片');
    if (file.size > 5 * 1024 * 1024) throw new Error('头像图片不能超过 5MB');
    checkRateLimit();
    var ext = (file.type === 'image/png') ? '.png' : (file.type === 'image/gif' ? '.gif' : (file.type === 'image/webp' ? '.webp' : '.jpg'));
    // 上传头像存入用户隐私目录 <usersRoot>/<userId>/private/，不放入公共头像库
    var path = buildPath(userFolder(cfg, s.userId), 'private', 'avatar' + ext);
    var b64 = await new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var b = String(reader.result).split(',')[1];
        if (b) resolve(b); else reject(new Error('图片读取失败'));
      };
      reader.onerror = function () { reject(new Error('图片读取失败')); };
      reader.readAsDataURL(file);
    });
    await ghWrite(cfg, path, b64, 'Upload avatar ' + s.userId, true);
    return await updateCurrentUser({ avatar: path, avatarUpdated: Date.now() });
  }

  async function listAvatars() {
    var cfg = requireConfig();
    var files = await ghRead(cfg, cfg.avatarsRoot);
    if (!Array.isArray(files)) return [];
    var exts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    return files
      .filter(function (f) { return f.type === 'file' && exts.some(function (e) { return (f.name || '').toLowerCase().endsWith(e); }); })
      .map(function (f) { return { name: f.name, path: (cfg.avatarsRoot.replace(/\/+$/, '') + '/' + f.name), url: avatarCdnUrl(cfg, buildPath(cfg.avatarsRoot, f.name)) }; });
  }

  // ==================== 云端项目（保存在用户文件夹 projects/<作品名>/ 目录，各数据分文件存储） ====================
  function projectsDir(cfg, userId) {
    return buildPath(userFolder(cfg, userId), 'projects');
  }
  // 旧格式单文件路径 <projects>/<作品名>.json（仅迁移兼容）
  function projectFilePath(cfg, userId, name) {
    return buildPath(projectsDir(cfg, userId), sanitizeName(name) + '.json');
  }
  // 新格式作品文件夹 <projects>/<作品名>/
  function projectDirPath(cfg, userId, name) {
    return buildPath(projectsDir(cfg, userId), sanitizeName(name));
  }
  // 列出当前用户的云端项目：{name, id, savedAt, path, isFolder}
  // 新格式：<projects>/<作品名>/project.json（项目数据）+ question.txt（题目数据）+ analysis.txt（解析数据）
  // 旧格式：<projects>/<作品名>.json（单文件，读取兼容）
  async function listCloudProjects() {
    var cfg = requireConfig();
    var s = getSession();
    if (!s || !s.userId) throw new Error('未登录');
    var dir = projectsDir(cfg, s.userId);
    var files = await ghRead(cfg, dir);
    if (!Array.isArray(files)) return [];
    var list = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.type === 'dir') {
        // 新格式：读取作品文件夹内的 project.json 获取元数据
        var metaRaw = await ghRead(cfg, buildPath(f.path, 'project.json'));
        var meta = null;
        try { meta = metaRaw ? JSON.parse(metaRaw) : null; } catch (e) {}
        if (meta) {
          list.push({
            name: meta.name || f.name,
            id: meta._id || '',
            savedAt: meta.savedAt || 0,
            path: f.path,
            isFolder: true
          });
        }
      } else if (f.type === 'file' && /\.json$/i.test(f.name || '')) {
        // 旧格式：单文件
        var raw = await ghRead(cfg, f.path);
        var obj = null;
        try { obj = JSON.parse(raw); } catch (e) {}
        list.push({
          name: (obj && obj.name) || f.name.replace(/\.json$/i, ''),
          id: (obj && obj._id) || '',
          savedAt: (obj && obj.savedAt) || 0,
          path: f.path,
          isFolder: false
        });
      }
    }
    list.sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
    return list;
  }
  // 按唯一 ID 读取云端项目（不按名称检索）；新格式按文件夹逐文件读取
  async function readCloudProject(id) {
    var cfg = requireConfig();
    var list = await listCloudProjects();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === String(id)) {
        var p = list[i];
        var result = { project: null, question: null, analysis: '', name: p.name, id: p.id, savedAt: p.savedAt };
        if (p.isFolder) {
          var raw = await ghRead(cfg, buildPath(p.path, 'project.json'));
          try { result.project = JSON.parse(raw); } catch (e) {}
          if (!result.project) throw new Error('云端项目读取失败');
          var qRaw = await ghRead(cfg, buildPath(p.path, 'question.txt'));
          if (qRaw != null && String(qRaw).trim() !== '') {
            try { result.question = JSON.parse(qRaw); } catch (e) { result.question = { type: 'text', text: String(qRaw) }; }
          }
          var aRaw = await ghRead(cfg, buildPath(p.path, 'analysis.txt'));
          if (aRaw != null) result.analysis = String(aRaw);
        } else {
          var raw2 = await ghRead(cfg, p.path);
          try { result.project = JSON.parse(raw2); } catch (e) {}
          if (!result.project) throw new Error('云端项目读取失败');
        }
        return result;
      }
    }
    throw new Error('未找到 ID 为 ' + id + ' 的云端项目');
  }
  // 保存云端项目：重名检测（排除自身 _id）；无 _id 时自动生成唯一 ID。
  // 新格式：在 projects/<作品名>/ 目录下分别写入 project.json（项目数据）、question.txt（题目数据）、analysis.txt（解析数据）
  async function writeCloudProject(name, data, extra) {
    var cfg = requireConfig();
    var s = getSession();
    if (!s || !s.userId) throw new Error('未登录');
    var n = sanitizeName(name);
    if (!n) throw new Error('项目名称不能为空');
    var list = await listCloudProjects();
    var dup = list.some(function (p) { return p.name === n && p.id !== (data._id || ''); });
    if (dup) throw new Error('已存在同名项目「' + n + '」，请换一个名称');
    data._id = data._id || genProjectId();
    data.name = n;
    data.savedAt = Date.now();
    data.savedBy = s.userId;
    var dir = projectDirPath(cfg, s.userId, n);
    // 1) 项目数据
    await ghWrite(cfg, buildPath(dir, 'project.json'), JSON.stringify(data, null, 2), 'Save project ' + n);
    // 2) 题目数据（独立文本文件）
    var qContent = (extra && extra.question !== undefined && extra.question !== null) ? extra.question : '';
    if (typeof qContent !== 'string') qContent = JSON.stringify(qContent);
    await ghWrite(cfg, buildPath(dir, 'question.txt'), qContent, 'Save question of ' + n);
    // 3) 解析数据（独立文本文件）
    var aContent = (extra && extra.analysis !== undefined && extra.analysis !== null) ? String(extra.analysis) : '';
    await ghWrite(cfg, buildPath(dir, 'analysis.txt'), aContent, 'Save analysis of ' + n);
    // 迁移清理：若存在旧版单文件 <作品名>.json，删除以免列表重复
    await ghDelete(cfg, projectFilePath(cfg, s.userId, n), 'Cleanup legacy project file ' + n);
    return data;
  }
  // 分享：把云端项目复制一份到仓库共享文件夹 <shareRoot>/<userId>/<name>.json
  async function shareCloudProject(id) {
    var cfg = requireConfig();
    var s = getSession();
    if (!s || !s.userId) throw new Error('未登录');
    var r = await readCloudProject(id);
    var target = buildPath(cfg.shareRoot, s.userId, r.name + '.json');
    var payload = {
      _id: r.id, name: r.name, sharedBy: s.userId, sharedAt: Date.now(),
      savedAt: r.project.savedAt, version: r.project.version,
      settings: r.project.settings, items: r.project.items
    };
    await ghWrite(cfg, target, JSON.stringify(payload, null, 2), 'Share project ' + r.name);
    return { path: target, rawUrl: rawUrl(cfg, target), cdnUrl: avatarCdnUrl(cfg, target), name: r.name, id: r.id };
  }

  // ==================== 管理者：用户列表与重置密码 ====================
  async function listUsers() {
    var cfg = requireConfig();
    var map = await readIndex(cfg);
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return (b.registeredAt || 0) - (a.registeredAt || 0); });
  }

  async function adminResetPassword(userId, newPw) {
    var cfg = requireConfig();
    validatePassword(newPw);
    var user = await readUser(cfg, String(userId));
    if (!user) throw new Error('用户不存在');
    checkRateLimit();
    user.password = String(newPw);
    await writeUser(cfg, user);
    return user;
  }

  // ==================== 注销账户 ====================
  // 校验当前账号密码（不写回，仅比对）
  async function verifyPassword(pw) {
    var cfg = requireConfig();
    var s = getSession();
    if (!s || !s.userId) throw new Error('未登录');
    var user = await readUser(cfg, s.userId);
    if (!user) throw new Error('用户数据读取失败');
    if (user.password !== String(pw)) throw new Error('密码错误');
    return user;
  }
  // 递归删除仓库目录下的全部文件（GitHub contents API 无法直接删除目录，需逐文件删除）
  async function deletePathRecursive(cfg, path) {
    var d = await ghRead(cfg, path);
    if (d == null) return;
    if (Array.isArray(d)) {
      for (var i = 0; i < d.length; i++) {
        await deletePathRecursive(cfg, d[i].path);
      }
    } else {
      await ghDelete(cfg, path, 'Delete user data ' + path);
    }
  }
  // 注销当前账号：删除仓库中该用户的文件夹与共享数据，并从用户索引中移除
  async function deleteUserAccount(userId) {
    var cfg = requireConfig();
    var s = getSession();
    if (!s || String(s.userId) !== String(userId)) throw new Error('只能注销当前登录的账号');
    await deletePathRecursive(cfg, userFolder(cfg, userId));
    await deletePathRecursive(cfg, buildPath(cfg.shareRoot, userId));
    var map = await readIndex(cfg);
    if (map[userId]) {
      delete map[userId];
      await writeIndex(cfg, map);
    }
    clearSession();
    return true;
  }

  // ==================== IP 注册检测（首次打开提示） ====================
  async function detectIpRegistered() {
    if (isLoggedIn()) return false;
    var cfg;
    try { cfg = requireConfig(); } catch (e) { return false; }
    var ip = await getClientIP();
    if (!ip) return false;
    try {
      var map = await readIndex(cfg);
      var hit = Object.keys(map).filter(function (k) { return map[k].ip === ip; });
      if (hit.length) return { ip: ip, count: hit.length };
    } catch (e) {}
    return false;
  }

  // ==================== 人机验证（本地算术） ====================
  function captchaNew() {
    var a = Math.floor(Math.random() * 20) + 1;
    var b = Math.floor(Math.random() * 10) + 1;
    var ops = ['+', '-', '×'];
    var op = ops[Math.floor(Math.random() * ops.length)];
    var answer;
    if (op === '+') answer = a + b;
    else if (op === '-') answer = a - b;
    else answer = a * b;
    var id = 'c' + Date.now() + Math.floor(Math.random() * 10000);
    captchas[id] = answer;
    // 自动清理过期验证码
    if (Object.keys(captchas).length > 20) captchas = {};
    return { id: id, text: a + ' ' + op + ' ' + b + ' = ?' };
  }
  function captchaVerify(id, answer) {
    var expected = captchas[id];
    if (expected == null) return false;
    delete captchas[id];
    return String(answer).trim() === String(expected);
  }

  // ==================== 登录拦截 ====================
  // 已登录立即 resolve(true)；未登录弹出登录弹窗，登录成功后 resolve(true)，取消 resolve(false)
  var pendingGuard = null;
  function requireLogin() {
    if (isLoggedIn()) return Promise.resolve(true);
    if (pendingGuard) return pendingGuard;
    pendingGuard = new Promise(function (resolve) {
      var settled = false;
      function done(ok) {
        if (settled) return;
        settled = true;
        pendingGuard = null;
        resolve(ok);
      }
      showLoginModal(done);
    });
    return pendingGuard;
  }

  // ==================== UI 引用 ====================
  var onAuthChanged = null; // 外部注册：function(user) 登录态变化时调用

  function setAuthListener(fn) { onAuthChanged = fn; }

  // ==================== 顶部标签栏 ====================
  function initTopNav() {
    var navBtns = document.querySelectorAll('.top-nav-btn');
    navBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var nav = btn.dataset.nav;
        if (nav === 'mine') {
          location.href = '../index.html';
          return;
        }
        navBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
      });
    });
    // 先渲染一次生成登录按钮，再绑定事件（renderTopNav 内部也会绑定）
    renderTopNav();
  }

  function renderTopNav() {
    var right = document.getElementById('topNavRight');
    if (!right) return;
    var user = getCurrentUser();
    if (!user) {
      right.innerHTML = '<button class="top-nav-login" id="topNavLoginBtn">登录 / 注册</button>';
      document.getElementById('topNavLoginBtn').addEventListener('click', function () { showLoginModal(); });
      return;
    }
    right.innerHTML =
      '<button class="top-nav-user" id="topNavAvatarBtn">' +
        '<span class="top-nav-name">' + esc(user.name || '') + '</span>' +
        '<span class="top-nav-avatar">' + renderAvatarHtml(user) + '</span>' +
      '</button>';
    document.getElementById('topNavAvatarBtn').addEventListener('click', function () { openUserPanel(); });
  }

  function renderAvatarHtml(user) {
    var cfg;
    try { cfg = requireConfig(); } catch (e) { cfg = null; }
    if (user && user.avatar && cfg) {
      var v = user.avatarUpdated ? ('?v=' + user.avatarUpdated) : '';
      return '<img class="avatar-img" src="' + esc(avatarCdnUrl(cfg, user.avatar) + v) + '" alt="头像">';
    }
    var ch = (user && user.name) ? user.name.charAt(0) : '?';
    var color = avatarColor(user ? user.id : '');
    return '<span class="avatar-char" style="background:' + color + ';">' + esc(ch) + '</span>';
  }

  // ==================== 登录 / 注册弹窗 ====================
  function showLoginModal(done) {
    var overlay = document.getElementById('loginModalOverlay');
    if (!overlay) return;
    overlay.classList.add('visible');
    var hint = document.getElementById('loginIpHint');
    if (hint) hint.style.display = 'none';
    // 异步检测 IP 是否曾注册
    detectIpRegistered().then(function (res) {
      if (res && hint && isLoggedIn() === false) {
        hint.style.display = 'block';
        hint.textContent = '检测到本机 IP（' + res.ip + '）曾注册过 ' + res.count + ' 个账号，请直接登录';
      }
    });
    // 记录本次弹窗的 resolve 回调
    currentLoginDone = done || null;
  }
  function hideLoginModal() {
    var overlay = document.getElementById('loginModalOverlay');
    if (overlay) overlay.classList.remove('visible');
  }
  function resolveLogin(ok) {
    if (currentLoginDone) { var fn = currentLoginDone; currentLoginDone = null; fn(ok); }
    hideLoginModal();
  }
  var currentLoginDone = null;

  function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    var isLogin = tab === 'login';
    document.getElementById('authLoginPanel').style.display = isLogin ? 'block' : 'none';
    document.getElementById('authRegisterPanel').style.display = isLogin ? 'none' : 'block';
    var msg = document.getElementById('authMsg');
    if (msg) { msg.style.display = 'none'; }
    if (!isLogin) freshCaptcha();
  }

  function freshCaptcha() {
    var c = captchaNew();
    var el = document.getElementById('regCaptchaText');
    var inp = document.getElementById('regCaptchaInput');
    var btn = document.getElementById('regCaptchaRefresh');
    if (el) el.dataset.id = c.id;
    if (el) el.textContent = c.text;
    if (inp) inp.value = '';
    if (btn) btn.disabled = false;
  }

  function showAuthMsg(text, isError) {
    var msg = document.getElementById('authMsg');
    if (!msg) return;
    msg.style.display = 'block';
    msg.style.color = isError === false ? '#16a34a' : '#dc2626';
    msg.textContent = text;
  }

  function initLoginModal() {
    document.getElementById('authTabLogin').addEventListener('click', function () { switchAuthTab('login'); });
    document.getElementById('authTabRegister').addEventListener('click', function () { switchAuthTab('register'); });
    document.getElementById('authCancelBtn').addEventListener('click', function () { resolveLogin(false); });
    document.getElementById('loginModalOverlay').addEventListener('click', function (e) {
      if (e.target === document.getElementById('loginModalOverlay')) resolveLogin(false);
    });
    document.getElementById('regCaptchaRefresh').addEventListener('click', function () { freshCaptcha(); });
    // 登录提交
    document.getElementById('loginSubmitBtn').addEventListener('click', async function () {
      var btn = document.getElementById('loginSubmitBtn');
      btn.disabled = true;
      var old = btn.textContent;
      btn.textContent = '登录中...';
      try {
        var id = document.getElementById('loginIdInput').value;
        var pw = document.getElementById('loginPwInput').value;
        var remember = document.getElementById('loginRememberChk').checked;
        var res = await login(id, pw, remember);
        showAuthMsg('登录成功，欢迎回来，' + (res.user.name || res.userId), false);
        hideIpBar();
        renderTopNav();
        refreshManagePanel();
        if (onAuthChanged) onAuthChanged(getCurrentUser());
        setTimeout(function () { resolveLogin(true); }, 600);
      } catch (e) {
        showAuthMsg(e.message || '登录失败', true);
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });
    // 注册提交
    document.getElementById('regSubmitBtn').addEventListener('click', async function () {
      var btn = document.getElementById('regSubmitBtn');
      btn.disabled = true;
      var old = btn.textContent;
      btn.textContent = '注册中...';
      try {
        var name = document.getElementById('regNameInput').value;
        var pw = document.getElementById('regPwInput').value;
        var pw2 = document.getElementById('regPw2Input').value;
        var cid = document.getElementById('regCaptchaText').dataset.id;
        var cval = document.getElementById('regCaptchaInput').value;
        if (!captchaVerify(cid, cval)) throw new Error('验证码错误，请重新输入');
        if (pw !== pw2) throw new Error('两次输入的密码不一致');
        var res = await register(name, pw);
        showAuthMsg('注册成功！您的用户 ID 是 ' + res.userId + '，已自动登录', false);
        document.getElementById('loginIdInput').value = res.userId;
        hideIpBar();
        renderTopNav();
        refreshManagePanel();
        if (onAuthChanged) onAuthChanged(getCurrentUser());
        setTimeout(function () { resolveLogin(true); }, 800);
      } catch (e) {
        showAuthMsg(e.message || '注册失败', true);
        freshCaptcha();
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });
  }

  // ==================== 设置面板：管理用户 ====================
  function openUserPanel() {
    var btn = document.getElementById('settingsBtn');
    var panel = document.getElementById('settingsPanel');
    if (btn && panel && panel.classList) {
      // 打开设置面板并切到「管理用户」
      if (!panel.classList.contains('visible')) {
        if (typeof window.toggleSettings === 'function') window.toggleSettings();
      }
      if (typeof window.switchSettingsNav === 'function') window.switchSettingsNav('user');
    }
  }

  function refreshManagePanel() {
    var wrap = document.getElementById('userManagePanel');
    if (!wrap) return;
    var user = getCurrentUser();
    if (!user) {
      wrap.innerHTML = '<div class="um-login-tip">请先登录后再管理个人信息</div>' +
        '<button class="primary" style="margin-top:10px;" onclick="UserAuth.openLoginModal()">去登录</button>';
      return;
    }
    var cfg;
    try { cfg = requireConfig(); } catch (e) { cfg = null; }
    var avatarHtml = renderAvatarHtml(user);
    var bl = (user.blacklist || []).join('\n');
    wrap.innerHTML =
      '<div class="um-profile">' +
        '<div class="um-avatar-lg">' + avatarHtml + '</div>' +
        '<div class="um-meta">' +
          '<div class="um-name" id="umName">' + esc(user.name || '') + '</div>' +
          '<div class="um-id">ID: ' + esc(user.id || '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="um-rows">' +
        '<div class="um-row"><span class="um-row-label">更换昵称</span><button class="um-btn" onclick="UserAuth.openRenameModal()">修改</button></div>' +
        '<div class="um-row"><span class="um-row-label">修改密码</span><button class="um-btn danger" onclick="UserAuth.openChangePwModal()">修改密码</button></div>' +
        '<div class="um-row"><span class="um-row-label">更换头像</span><button class="um-btn" onclick="UserAuth.openAvatarModal()">更换头像</button></div>' +
        '<div class="um-row"><span class="um-row-label">IP 黑名单</span><button class="um-btn" onclick="UserAuth.openBlacklistModal()">管理</button></div>' +
        '<div class="um-row"><span class="um-row-label">登录设备</span><button class="um-btn" onclick="UserAuth.toggleDevices()">查看</button></div>' +
      '</div>' +
      '<div class="um-devices" id="umDevices" style="display:none;"></div>' +
      '<div class="um-footer">' +
        '<button class="um-btn danger" onclick="UserAuth.logout()">退出登录</button>' +
        '<button class="um-btn danger" onclick="UserAuth.switchAccount()">切换登录</button>' +
        '<button class="um-btn danger" onclick="UserAuth.openDeleteAccountModal()">注销账户</button>' +
      '</div>';
    // 渲染设备列表
    var devEl = document.getElementById('umDevices');
    if (devEl && user.devices && user.devices.length) {
      devEl.innerHTML = '<div class="um-dev-title">最近登录设备</div>' +
        user.devices.map(function (d) {
          return '<div class="um-dev-item"><span class="um-dev-ip">' + esc(d.ip || '') + '</span>' +
            '<span class="um-dev-time">' + formatTime(d.time) + '</span>' +
            '<span class="um-dev-action">' + esc(d.action || 'login') + '</span></div>';
        }).join('');
    }
    // 渲染黑名单文本（供弹窗预填）
    var blEl = document.getElementById('blacklistTextarea');
    if (blEl) blEl.value = bl;
  }

  function toggleDevices() {
    var el = document.getElementById('umDevices');
    if (!el) return;
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }

  // ==================== 昵称修改模态框 ====================
  function openRenameModal() {
    var user = getCurrentUser();
    if (!user) { showToast('请先登录'); return; }
    var overlay = document.getElementById('renameModalOverlay');
    document.getElementById('renameInput').value = user.name || '';
    document.getElementById('renameMsg').style.display = 'none';
    overlay.classList.add('visible');
  }
  function closeRenameModal() {
    document.getElementById('renameModalOverlay').classList.remove('visible');
  }
  function initRenameModal() {
    document.getElementById('renameCancelBtn').addEventListener('click', closeRenameModal);
    document.getElementById('renameConfirmBtn').addEventListener('click', async function () {
      var msg = document.getElementById('renameMsg');
      try {
        var v = document.getElementById('renameInput').value;
        var u = await changeName(v);
        msg.style.display = 'block';
        msg.style.color = '#16a34a';
        msg.textContent = '昵称已更新';
        renderTopNav();
        refreshManagePanel();
        setTimeout(closeRenameModal, 700);
      } catch (e) {
        msg.style.display = 'block';
        msg.style.color = '#dc2626';
        msg.textContent = e.message || '修改失败';
      }
    });
    document.getElementById('renameModalOverlay').addEventListener('click', function (e) {
      if (e.target === document.getElementById('renameModalOverlay')) closeRenameModal();
    });
  }

  // ==================== 密码修改模态框 ====================
  function openChangePwModal() {
    var overlay = document.getElementById('changePwModalOverlay');
    ['changePwOld', 'changePwNew', 'changePwNew2'].forEach(function (id) {
      document.getElementById(id).value = '';
    });
    document.getElementById('changePwMsg').style.display = 'none';
    overlay.classList.add('visible');
  }
  function closeChangePwModal() {
    document.getElementById('changePwModalOverlay').classList.remove('visible');
  }
  function initChangePwModal() {
    document.getElementById('changePwCancelBtn').addEventListener('click', closeChangePwModal);
    document.getElementById('changePwConfirmBtn').addEventListener('click', async function () {
      var msg = document.getElementById('changePwMsg');
      try {
        var oldPw = document.getElementById('changePwOld').value;
        var newPw = document.getElementById('changePwNew').value;
        var newPw2 = document.getElementById('changePwNew2').value;
        if (newPw !== newPw2) throw new Error('两次输入的新密码不一致');
        await changePassword(oldPw, newPw);
        msg.style.display = 'block';
        msg.style.color = '#16a34a';
        msg.textContent = '密码修改成功';
        setTimeout(closeChangePwModal, 800);
      } catch (e) {
        msg.style.display = 'block';
        msg.style.color = '#dc2626';
        msg.textContent = e.message || '修改失败';
      }
    });
    document.getElementById('changePwModalOverlay').addEventListener('click', function (e) {
      if (e.target === document.getElementById('changePwModalOverlay')) closeChangePwModal();
    });
  }

  // ==================== IP 黑名单模态框 ====================
  function openBlacklistModal() {
    var overlay = document.getElementById('blacklistModalOverlay');
    var user = getCurrentUser();
    document.getElementById('blacklistTextarea').value = (user && user.blacklist || []).join('\n');
    document.getElementById('blacklistMsg').style.display = 'none';
    overlay.classList.add('visible');
  }
  function closeBlacklistModal() {
    document.getElementById('blacklistModalOverlay').classList.remove('visible');
  }
  function initBlacklistModal() {
    document.getElementById('blacklistCancelBtn').addEventListener('click', closeBlacklistModal);
    document.getElementById('blacklistSaveBtn').addEventListener('click', async function () {
      var msg = document.getElementById('blacklistMsg');
      try {
        var raw = document.getElementById('blacklistTextarea').value.split(/[\n,，\s]+/);
        var list = raw.map(function (x) { return x.trim(); }).filter(Boolean);
        await setBlacklist(list);
        msg.style.display = 'block';
        msg.style.color = '#16a34a';
        msg.textContent = 'IP 黑名单已更新';
        refreshManagePanel();
        setTimeout(closeBlacklistModal, 700);
      } catch (e) {
        msg.style.display = 'block';
        msg.style.color = '#dc2626';
        msg.textContent = e.message || '保存失败';
      }
    });
    document.getElementById('blacklistModalOverlay').addEventListener('click', function (e) {
      if (e.target === document.getElementById('blacklistModalOverlay')) closeBlacklistModal();
    });
  }

  // ==================== 注销账户模态框 ====================
  function openDeleteAccountModal() {
    var overlay = document.getElementById('deleteAccountOverlay');
    var user = getCurrentUser();
    if (!user) { showToast('请先登录'); return; }
    document.getElementById('deleteAccountId').textContent = user.id || '';
    document.getElementById('deleteAccountPw').value = '';
    var msg = document.getElementById('deleteAccountMsg');
    if (msg) msg.style.display = 'none';
    overlay.classList.add('visible');
  }
  function closeDeleteAccountModal() {
    document.getElementById('deleteAccountOverlay').classList.remove('visible');
  }
  function initDeleteAccountModal() {
    document.getElementById('deleteAccountCancelBtn').addEventListener('click', closeDeleteAccountModal);
    document.getElementById('deleteAccountConfirmBtn').addEventListener('click', async function () {
      var btn = this;
      var msg = document.getElementById('deleteAccountMsg');
      var pw = document.getElementById('deleteAccountPw').value;
      if (!pw) {
        msg.style.display = 'block'; msg.style.color = '#dc2626'; msg.textContent = '请输入当前账号密码';
        return;
      }
      // 第一步：校验密码
      btn.disabled = true;
      var old = btn.textContent;
      btn.textContent = '验证中...';
      try {
        await verifyPassword(pw);
      } catch (e) {
        msg.style.display = 'block'; msg.style.color = '#dc2626'; msg.textContent = e.message || '密码验证失败';
        btn.disabled = false; btn.textContent = old;
        return;
      }
      btn.disabled = false; btn.textContent = old;
      // 第二步：二次确认（不可逆操作）
      var user = getCurrentUser();
      showConfirm('注销账户', '确定要永久注销账号「' + (user ? user.name || user.id : '') + '」吗？该账号在仓库中的所有数据（资料、云端项目、头像、分享内容）将被删除，且无法恢复。', '确定注销', async function () {
        try {
          await deleteUserAccount(user.id);
          closeDeleteAccountModal();
          renderTopNav();
          refreshManagePanel();
          if (onAuthChanged) onAuthChanged(null);
          showToast('账号已注销');
        } catch (e) {
          msg.style.display = 'block'; msg.style.color = '#dc2626'; msg.textContent = e.message || '注销失败';
        }
      }, function () { /* 取消注销：留在注销弹窗 */ });
    });
    document.getElementById('deleteAccountOverlay').addEventListener('click', function (e) {
      if (e.target === document.getElementById('deleteAccountOverlay')) closeDeleteAccountModal();
    });
  }

  // ==================== 头像模态框 ====================
  // 头像选择状态：{type:'upload'|'public'|'default', file?, dataUrl?, path?, url?}
  var avatarSelected = null;

  function openAvatarModal() {
    var overlay = document.getElementById('avatarModalOverlay');
    avatarSelected = null;
    var confirmBtn = document.getElementById('avatarConfirmBtn');
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '确定'; }
    var msg = document.getElementById('avatarMsg');
    if (msg) msg.style.display = 'none';
    var fi = document.getElementById('avatarFileInput');
    if (fi) fi.value = '';
    var listEl = document.getElementById('avatarList');
    if (listEl) listEl.innerHTML = '正在读取公共头像...';
    // 渲染原头像
    var oldEl = document.getElementById('avatarOldPreview');
    if (oldEl) {
      var user = getCurrentUser();
      var cfg;
      try { cfg = requireConfig(); } catch (e) { cfg = null; }
      if (user && user.avatar && cfg) {
        var v = user.avatarUpdated ? ('?v=' + user.avatarUpdated) : '';
        oldEl.innerHTML = '<img src="' + esc(avatarCdnUrl(cfg, user.avatar) + v) + '" alt="原头像">';
      } else if (user) {
        oldEl.innerHTML = '<span class="avatar-preview-char" style="background:' + avatarColor(user.id) + ';">' + esc((user.name || '?').charAt(0)) + '</span>';
      } else {
        oldEl.innerHTML = '<span class="avatar-preview-char">?</span>';
      }
    }
    setNewPreview('<span class="avatar-empty-hint">尚未选择</span>');
    overlay.classList.add('visible');
    loadAvatarList();
  }
  function closeAvatarModal() {
    document.getElementById('avatarModalOverlay').classList.remove('visible');
  }
  function setNewPreview(html) {
    var el = document.getElementById('avatarNewPreview');
    if (el) el.innerHTML = html;
  }
  function showAvatarMsg(text, isError) {
    var msg = document.getElementById('avatarMsg');
    if (!msg) return;
    msg.style.display = 'block';
    msg.style.color = isError ? '#dc2626' : '#16a34a';
    msg.textContent = text;
  }
  function clearCellSelected() {
    var cells = document.querySelectorAll('#avatarList .avatar-cell');
    cells.forEach(function (c) { c.classList.remove('selected'); });
  }
  function previewUploadDataUrl(dataUrl) {
    setNewPreview('<img src="' + dataUrl + '" alt="新头像">');
    avatarSelected = { type: 'upload', dataUrl: dataUrl };
  }
  async function loadAvatarList() {
    var listEl = document.getElementById('avatarList');
    try {
      var list = await listAvatars();
      if (!list.length) {
        listEl.innerHTML = '<div class="avatar-empty">公共头像目录为空，可上传图片</div>';
        return;
      }
      listEl.innerHTML = '<div class="avatar-grid">' + list.map(function (f) {
        return '<div class="avatar-cell" data-path="' + esc(f.path) + '" data-url="' + esc(f.url) + '"><img src="' + esc(f.url) + '" alt="' + esc(f.name) + '" loading="lazy"><div class="avatar-cell-name">' + esc(f.name) + '</div></div>';
      }).join('') + '</div>';
      listEl.querySelectorAll('.avatar-cell').forEach(function (cell) {
        cell.addEventListener('click', function () {
          // 点击公共头像：仅预览高亮，不立即替换，点确定后才生效
          clearCellSelected();
          cell.classList.add('selected');
          setNewPreview('<img src="' + cell.dataset.url + '" alt="新头像">');
          avatarSelected = { type: 'public', path: cell.dataset.path, url: cell.dataset.url };
          showAvatarMsg('已选择公共头像，点击「确定」后生效', false);
        });
      });
    } catch (e) {
      listEl.innerHTML = '<div class="avatar-empty">读取公共头像失败：' + esc(e.message) + '</div>';
    }
  }
  function initAvatarModal() {
    document.getElementById('avatarCancelBtn').addEventListener('click', closeAvatarModal);
    // 上传按钮：选择文件后预览，不立即上传
    document.getElementById('avatarUploadBtn').addEventListener('click', function () {
      document.getElementById('avatarFileInput').click();
    });
    document.getElementById('avatarFileInput').addEventListener('change', function () {
      var file = this.files[0];
      var msg = document.getElementById('avatarMsg');
      if (!file) return;
      if (!/image\/(png|jpe?g|gif|webp)/i.test(file.type || '')) {
        showAvatarMsg('仅支持 png/jpg/jpeg/gif/webp 图片', true);
        this.value = '';
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        showAvatarMsg('头像图片不能超过 5MB', true);
        this.value = '';
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        previewUploadDataUrl(String(reader.result));
        clearCellSelected();
        showAvatarMsg('已预览新头像，点击「确定」后上传生效', false);
      };
      reader.onerror = function () { showAvatarMsg('图片读取失败', true); };
      reader.readAsDataURL(file);
    });
    // 恢复默认：预览默认头像，点确定后生效
    document.getElementById('avatarClearBtn').addEventListener('click', function () {
      clearCellSelected();
      var user = getCurrentUser();
      var ch = (user && user.name) ? user.name.charAt(0) : '?';
      setNewPreview('<span class="avatar-preview-char" style="background:' + avatarColor(user ? user.id : '') + ';">' + esc(ch) + '</span>');
      avatarSelected = { type: 'default' };
      showAvatarMsg('已选择默认头像，点击「确定」后生效', false);
    });
    // 确定：应用选中头像
    document.getElementById('avatarConfirmBtn').addEventListener('click', async function () {
      var btn = this;
      if (!avatarSelected) {
        showAvatarMsg('请先上传图片或选择公共头像', true);
        return;
      }
      try {
        btn.disabled = true;
        btn.textContent = '应用中...';
        if (avatarSelected.type === 'upload') {
          var fi = document.getElementById('avatarFileInput');
          await uploadAvatar(fi.files[0]);
          showAvatarMsg('头像上传成功', false);
        } else if (avatarSelected.type === 'public') {
          await setAvatar(avatarSelected.path);
          showAvatarMsg('头像已更新', false);
        } else {
          await setAvatar('');
          showAvatarMsg('已恢复默认头像', false);
        }
        renderTopNav();
        refreshManagePanel();
        setTimeout(closeAvatarModal, 700);
      } catch (e) {
        showAvatarMsg(e.message || '设置失败', true);
        btn.disabled = false;
        btn.textContent = '确定';
      }
    });
    document.getElementById('avatarModalOverlay').addEventListener('click', function (e) {
      if (e.target === document.getElementById('avatarModalOverlay')) closeAvatarModal();
    });
  }

  // ==================== 设置面板：管理者 ====================
  function loadAdminConfig() {
    var cfg = getConfig();
    if (!cfg) return;
    ['admToken', 'admOwner', 'admRepo', 'admBranch', 'admUsersRoot', 'admAvatarsRoot', 'admShareRoot', 'admImgRoot', 'admImgMaxSize', 'admImgWhitelist'].forEach(function (id) {
      var key = { admToken: 'token', admOwner: 'owner', admRepo: 'repo', admBranch: 'branch', admUsersRoot: 'usersRoot', admAvatarsRoot: 'avatarsRoot', admShareRoot: 'shareRoot', admImgRoot: 'imgRoot', admImgMaxSize: 'imgMaxSize', admImgWhitelist: 'imgWhitelist' }[id];
      var el = document.getElementById(id);
      if (el) el.value = cfg[key] || (id === 'admImgRoot' ? 'user_images' : id === 'admImgMaxSize' ? '5' : id === 'admImgWhitelist' ? 'jpg,png,webp,svg' : '');
    });
    var cdn = cfg.avatarCdn || 'fastly';
    var radio = document.querySelector('input[name="admAvatarCdn"][value="' + cdn + '"]');
    if (radio) radio.checked = true;
    ['admImgUploadEnabled', 'admImgRemoteEnabled'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.checked = cfg[id === 'admImgUploadEnabled' ? 'imgUploadEnabled' : 'imgRemoteEnabled'] !== false;
    });
  }
  function saveAdminConfig() {
    var cdnRadio = document.querySelector('input[name="admAvatarCdn"]:checked');
    var cfg = {
      token: document.getElementById('admToken').value.trim(),
      owner: document.getElementById('admOwner').value.trim(),
      repo: document.getElementById('admRepo').value.trim(),
      branch: document.getElementById('admBranch').value.trim() || 'main',
      usersRoot: document.getElementById('admUsersRoot').value.trim() || 'users',
      avatarsRoot: document.getElementById('admAvatarsRoot').value.trim() || 'avatars',
      shareRoot: document.getElementById('admShareRoot').value.trim() || 'share',
      imgRoot: document.getElementById('admImgRoot').value.trim() || 'user_images',
      imgMaxSize: parseFloat(document.getElementById('admImgMaxSize').value) || 5,
      imgWhitelist: document.getElementById('admImgWhitelist').value.trim() || 'jpg,png,webp,svg',
      imgUploadEnabled: document.getElementById('admImgUploadEnabled').checked,
      imgRemoteEnabled: document.getElementById('admImgRemoteEnabled').checked,
      avatarCdn: cdnRadio ? cdnRadio.value : 'fastly'
    };
    saveConfig(cfg);
    renderTopNav();
    return cfg;
  }
  function initAdminPanel() {
    loadAdminConfig();
    document.getElementById('admSaveBtn').addEventListener('click', function () {
      var msg = document.getElementById('admMsg');
      var cfg = saveAdminConfig();
      msg.style.display = 'block';
      msg.style.color = '#16a34a';
      msg.textContent = '配置已保存' + (cfg.token ? '（仓库 ' + cfg.owner + '/' + cfg.repo + '）' : '');
    });
    document.getElementById('admListUsersBtn').addEventListener('click', async function () {
      var wrap = document.getElementById('admUsersList');
      var msg = document.getElementById('admMsg');
      wrap.innerHTML = '正在读取用户列表...';
      try {
        var users = await listUsers();
        if (!users.length) {
          wrap.innerHTML = '<div class="adm-empty">仓库中暂无注册用户</div>';
          return;
        }
        wrap.innerHTML = '<div class="adm-users-title">已注册用户（' + users.length + '）</div>' +
          users.map(function (u) {
            return '<div class="adm-user-row">' +
              '<div class="adm-user-main"><span class="adm-user-id">' + esc(u.id) + '</span>' +
              '<span class="adm-user-name">' + esc(u.name) + '</span></div>' +
              '<span class="adm-user-ip">' + esc(u.ip || '') + '</span>' +
              '<span class="adm-user-time">' + formatTime(u.registeredAt) + '</span>' +
              '<button class="um-btn" data-reset="' + esc(u.id) + '">重置密码</button>' +
            '</div>';
          }).join('');
        wrap.querySelectorAll('[data-reset]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            var uid = btn.dataset.reset;
            var npw = window.prompt('请输入「' + uid + '」的新密码（8-16 位，含大小写字母和数字）：');
            if (!npw) return;
            try {
              await adminResetPassword(uid, npw);
              msg.style.display = 'block';
              msg.style.color = '#16a34a';
              msg.textContent = '用户 ' + uid + ' 密码已重置';
            } catch (e) {
              msg.style.display = 'block';
              msg.style.color = '#dc2626';
              msg.textContent = e.message || '重置失败';
            }
          });
        });
      } catch (e) {
        wrap.innerHTML = '<div class="adm-empty">读取失败：' + esc(e.message) + '</div>';
      }
    });
    var scanBtn = document.getElementById('admImgScanBtn');
    if (scanBtn) {
      scanBtn.addEventListener('click', function () {
        try {
          saveAdminConfig();
          if (window.MDEDIT && typeof MDEDIT.openOrphanManager === 'function') MDEDIT.openOrphanManager();
          else { showToast('MD 编辑器尚未加载'); }
        } catch (e) { showToast(e.message || '扫描失败'); }
      });
    }
  }

  // ==================== 登出 / 切换 ====================
  function logout() {
    clearSession();
    renderTopNav();
    refreshManagePanel();
    if (onAuthChanged) onAuthChanged(null);
    showToast('已退出登录');
  }
  function switchAccount() {
    clearSession();
    renderTopNav();
    refreshManagePanel();
    if (onAuthChanged) onAuthChanged(null);
    showLoginModal();
  }
  function openLoginModal() {
    showLoginModal();
  }

  // ==================== Toast 提示 ====================
  function showToast(text) {
    var el = document.getElementById('authToast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  // ==================== 顶部 IP 注册提示条 ====================
  async function initIpNotice() {
    if (isLoggedIn()) return;
    var res = await detectIpRegistered();
    if (!res || isLoggedIn()) return;
    var bar = document.getElementById('ipRegisteredBar');
    if (!bar) return;
    bar.style.display = 'flex';
    var txt = document.getElementById('ipRegisteredText');
    if (txt) txt.textContent = '检测到本机 IP（' + res.ip + '）曾注册过账号，点击登录后可继续使用';
  }

  function hideIpBar() {
    var bar = document.getElementById('ipRegisteredBar');
    if (bar) bar.style.display = 'none';
  }

  // ==================== 初始化 ====================
  function init() {
    try {
      initTopNav();
      initLoginModal();
      initRenameModal();
      initChangePwModal();
      initBlacklistModal();
      initAvatarModal();
      initDeleteAccountModal();
      initAdminPanel();
      renderTopNav();
      refreshManagePanel();
      // 设置面板切到管理用户/管理者时刷新
      if (window.switchSettingsNav) {
        var orig = window.switchSettingsNav;
        window.switchSettingsNav = function (name) {
          orig(name);
          if (name === 'user') { refreshManagePanel(); }
          if (name === 'admin') { loadAdminConfig(); }
        };
      }
      initIpNotice();
    } catch (e) {
      console.error('UserAuth init error:', e);
    }
  }

  // 暴露全局接口
  var UserAuth = {
    getConfig: getConfig,
    saveConfig: saveConfig,
    requireConfig: requireConfig,
    getClientIP: getClientIP,
    register: register,
    login: login,
    logout: logout,
    switchAccount: switchAccount,
    openLoginModal: openLoginModal,
    requireLogin: requireLogin,
    isLoggedIn: isLoggedIn,
    getSession: getSession,
    getCurrentUser: getCurrentUser,
    refreshUser: refreshUser,
    changeName: changeName,
    changePassword: changePassword,
    setBlacklist: setBlacklist,
    setAvatar: setAvatar,
    uploadAvatar: uploadAvatar,
    listAvatars: listAvatars,
    listUsers: listUsers,
    adminResetPassword: adminResetPassword,
    deleteUserAccount: deleteUserAccount,
    verifyPassword: verifyPassword,
    captchaNew: captchaNew,
    captchaVerify: captchaVerify,
    detectIpRegistered: detectIpRegistered,
    openRenameModal: openRenameModal,
    openChangePwModal: openChangePwModal,
    openAvatarModal: openAvatarModal,
    openBlacklistModal: openBlacklistModal,
    toggleDevices: toggleDevices,
    openDeleteAccountModal: openDeleteAccountModal,
    refreshManagePanel: refreshManagePanel,
    renderTopNav: renderTopNav,
    setAuthListener: setAuthListener,
    rawUrl: rawUrl,
    avatarCdnUrl: avatarCdnUrl,
    ghRead: ghRead,
    ghWrite: ghWrite,
    ghDelete: ghDelete,
    listCloudProjects: listCloudProjects,
    readCloudProject: readCloudProject,
    writeCloudProject: writeCloudProject,
    shareCloudProject: shareCloudProject,
    genProjectId: genProjectId,
    formatTime: formatTime,
    showToast: showToast,
    init: init
  };

  global.UserAuth = UserAuth;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { UserAuth.init(); });
  } else {
    UserAuth.init();
  }
})(window);
