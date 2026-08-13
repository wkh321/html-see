/**
 * GitHub 仓库后端模块（借鉴 auth.js 的 GitHub 仓库绑定封装）
 *
 * 配置项：token / owner / repo / branch / usersRoot / avatarsRoot / shareRoot
 * 数据目录结构：
 *   <usersRoot>/_index.txt                     用户索引（快速登录定位）
 *   <usersRoot>/<userId>/info.json             用户数据
 *   <usersRoot>/<userId>/private/avatar.ext    头像（隐私目录）
 *   <usersRoot>/<userId>/projects/<name>.json  云端项目
 *   <shareRoot>/<userId>/share/works.json      公开作品索引（相对路径 + 分类元信息）
 */

export const CFG_KEY = 'fnplt_gh_config_v2';
export const CFG_DEFAULTS = {
  branch: 'main',
  usersRoot: 'users',
  avatarsRoot: 'avatars',
  shareRoot: 'share',
  cdn: { fastly: '', gcore: '', raw: '' },
};

/* ---------- 编码 / 路径工具 ---------- */
export function base64ToString(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export function stringToBase64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function buildPath(root, ...parts) {
  const r = String(root || '').replace(/^\/+|\/+$/g, '');
  const p = parts.map((x) => String(x || '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return [r].concat(p).filter(Boolean).join('/');
}

export function sanitizeName(name) {
  return String(name || '').replace(/[|\n\r]/g, '').slice(0, 40);
}

/* ---------- 配置 ---------- */
export function getConfig() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
  } catch (e) {
    return null;
  }
}

export function saveConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

export function hasConfig() {
  const cfg = getConfig();
  return !!(cfg && cfg.token && cfg.owner && cfg.repo);
}

export function requireConfig() {
  const cfg = getConfig();
  if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) {
    throw new Error('尚未配置 GitHub 仓库，请先在 管理者设置 - 对接GitHub知识点仓库 中填写 token/owner/repo');
  }
  cfg.branch = cfg.branch || CFG_DEFAULTS.branch;
  cfg.usersRoot = cfg.usersRoot || CFG_DEFAULTS.usersRoot;
  cfg.avatarsRoot = cfg.avatarsRoot || CFG_DEFAULTS.avatarsRoot;
  cfg.shareRoot = cfg.shareRoot || CFG_DEFAULTS.shareRoot;
  if (!cfg.cdn || typeof cfg.cdn !== 'object') cfg.cdn = { fastly: '', gcore: '', raw: '' };
  return cfg;
}

/* ---------- GitHub Contents API ---------- */
function apiUrl(cfg, path) {
  return 'https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + path;
}

function ghHeaders(cfg) {
  return { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'User-Agent': 'fnplotter-mine' };
}

/* ---------- 统一节流：同路径 GET 短缓存合并去重 + 最小请求间隔 + 超时 + 403 退避 ---------- */
const GH_MIN_INTERVAL = 300; // 相邻请求最小间隔（ms）
const GH_CACHE_TTL = 500; // 同路径 GET 短缓存时长（ms），缓存期内合并复用
const GH_TIMEOUT = 20000; // 单请求超时（ms）
const GH_BACKOFF_MS = 30000; // 403 触发退避时长（ms）

const ghGetCache = new Map(); // key(branch:path) -> { at, promise }
let ghLastAt = 0; // 上次请求发起时间
let ghBackoffUntil = 0; // 403 退避截止时间

function ghSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* 发起请求前节流：退避期内直接拒绝；否则保证与上次请求间隔 >= GH_MIN_INTERVAL */
async function ghThrottle() {
  if (Date.now() < ghBackoffUntil) {
    throw new Error('GitHub API 触发限流保护，请稍候再试（退避中）');
  }
  const wait = ghLastAt + GH_MIN_INTERVAL - Date.now();
  if (wait > 0) await ghSleep(wait);
  ghLastAt = Date.now();
}

/* 带超时的 fetch */
async function ghFetch(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GH_TIMEOUT);
  opts.signal = ctrl.signal;
  try {
    const res = await fetch(url, opts);
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('GitHub 请求超时（20 秒），请检查网络后重试');
    throw new Error('GitHub 网络请求失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

async function ghRequest(cfg, path, method, body, noCache) {
  const cacheKey = (cfg.branch || 'main') + ':' + path;
  if (method === 'GET' && !noCache) {
    const hit = ghGetCache.get(cacheKey);
    if (hit && Date.now() - hit.at < GH_CACHE_TTL) return hit.promise;
  }
  const promise = (async () => {
    await ghThrottle();
    const url = apiUrl(cfg, path) + (method === 'GET' ? '?ref=' + encodeURIComponent(cfg.branch) : '');
    const opts = { method, headers: ghHeaders(cfg) };
    if (body) opts.body = JSON.stringify(body);
    const res = await ghFetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 200 || res.status === 201) return data;
    if (res.status === 404) return null;
    if (res.status === 403) {
      ghBackoffUntil = Date.now() + GH_BACKOFF_MS;
      throw new Error('GitHub API 限流或权限不足，已暂停请求 ' + (GH_BACKOFF_MS / 1000) + ' 秒：' + (data.message || 'HTTP 403'));
    }
    if (res.status === 401) throw new Error('GitHub token 无效或无权限：' + (data.message || 'HTTP 401'));
    throw new Error(data.message || ('GitHub HTTP ' + res.status));
  })();
  if (method === 'GET' && !noCache) {
    ghGetCache.set(cacheKey, { at: Date.now(), promise });
    promise.catch(() => {
      if (ghGetCache.get(cacheKey) && ghGetCache.get(cacheKey).promise === promise) ghGetCache.delete(cacheKey);
    });
  }
  return promise;
}

/* 读取文件文本（base64 解码）；目录返回数组 */
export async function ghRead(cfg, path) {
  const d = await ghRequest(cfg, path, 'GET');
  if (d == null) return null;
  if (Array.isArray(d)) return d;
  if (d.content) return base64ToString(d.content);
  return null;
}

export async function ghWrite(cfg, path, content, message, isBase64) {
  const existing = await ghRequest(cfg, path, 'GET', null, true);
  const body = {
    message: message || ('Update ' + path),
    content: isBase64 ? content : stringToBase64(content),
    branch: cfg.branch,
  };
  if (existing && existing.sha) body.sha = existing.sha;
  return ghRequest(cfg, path, 'PUT', body);
}

export async function ghDelete(cfg, path, message) {
  const existing = await ghRequest(cfg, path, 'GET', null, true);
  if (!existing || !existing.sha) return true;
  const body = { message: message || ('Delete ' + path), branch: cfg.branch, sha: existing.sha };
  const res = await ghFetch(apiUrl(cfg, path), { method: 'DELETE', headers: ghHeaders(cfg), body: JSON.stringify(body) });
  return res.status === 200;
}

export function rawUrl(cfg, path) {
  return 'https://raw.githubusercontent.com/' + cfg.owner + '/' + cfg.repo + '/' + cfg.branch + '/' + path;
}

/**
 * 生成文件的三个 CDN 访问链接（借鉴 auth.js avatarCdnUrl）
 * 其中 fastly.jsdelivr.net 为快速地址，作为默认加载源。
 * 管理者可在配置中自定义三个链接前缀（cfg.cdn.fastly/gcore/raw），留空用默认地址。
 */
export function cdnUrls(cfg, path) {
  const p = String(path || '').replace(/^\/+/, '');
  const gh = cfg.owner + '/' + cfg.repo + '@' + cfg.branch + '/' + p;
  const custom = (cfg.cdn && cfg.cdn) || {};
  const trim = (s) => String(s || '').trim().replace(/\/+$/, '');
  return {
    raw: trim(custom.raw) || 'https://raw.githubusercontent.com/' + gh,
    gcore: trim(custom.gcore) || 'https://gcore.jsdelivr.net/gh/' + gh,
    fastly: trim(custom.fastly) || 'https://fastly.jsdelivr.net/gh/' + gh,
  };
}

/* 头像 / 通用文件加载链接：默认用快速地址 */
export function fileUrl(cfg, path) {
  return cdnUrls(cfg, path).fastly;
}

/* 列出目录下所有文件 */
export async function listFiles(cfg, dir) {
  const list = await ghRead(cfg, dir);
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f && f.type === 'file');
}

/* 列出目录下所有子目录 */
export async function listDirs(cfg, dir) {
  const list = await ghRead(cfg, dir);
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f && f.type === 'dir');
}

/* 检查 GitHub API 剩余额度（resources.core.remaining）；need 为预计需要的请求数。
 * 查询失败或无需鉴权时不阻塞：remaining 取 -1 表示未知，视为通过。 */
export async function checkRateLimit(cfg, need) {
  try {
    await ghThrottle();
    const res = await ghFetch('https://api.github.com/rate_limit', { headers: ghHeaders(cfg) });
    const d = await res.json().catch(() => ({}));
    const core = (d && d.resources && d.resources.core) || {};
    const remaining = typeof core.remaining === 'number' ? core.remaining : -1;
    const limit = typeof core.limit === 'number' ? core.limit : 0;
    return { ok: remaining < 0 || remaining >= need, remaining, limit };
  } catch (e) {
    return { ok: true, remaining: -1, limit: 0 };
  }
}

/* 防频繁触发：同一 key 并发时直接返回 null（调用方按“已在处理中”处理） */
const ghLocks = {};
export function withGhLock(key, fn) {
  if (ghLocks[key]) return null;
  ghLocks[key] = true;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      ghLocks[key] = false;
    });
}
