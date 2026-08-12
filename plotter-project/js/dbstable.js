/**
 * 点鸭数据表接入层（多表：logs 记录表 + users 用户表，与 GitHub 共存双写，读取优先数据表）。
 *
 * 依赖 js/dbs-all.js（记录表）与 js/dbs-users.js（用户表），均为独立 script 引入，
 * 暴露 window.DbsApi 与 window.__dbsConfigs 配置池。本模块做运行时适配：
 *   - 把 dbs-all.js 写入 window.module.exports 的记录表配置搬进 __dbsConfigs['logs']
 *   - 用户表配置由 dbs-users.js 注册到 __dbsConfigs['users']
 *   - DbsApi.init({ table }) 按表名取配置（增强版 DbsApi 支持；旧版自动回退）
 *
 * 配置存于 localStorage cfg.db = { logs:{enabled,configUrl}, users:{enabled,configUrl} }，
 * 由「管理者设置 - 点鸭数据表」填写；兼容旧结构 cfg.db={enabled,configUrl}。
 *
 * 记录表字段（logs）：id / type / user_id / name / status / detail（createdAt/updatedAt 系统自动）
 *   type 取值：file_status=文件处理状态、upload_log=上传日志；detail 存附加 JSON 文本。
 * 用户表字段（users）：id / name / role / avatar / stats / whitelist / devices / ip
 */
import { requireConfig } from './github.js';

export const DB_TABLES = {
  LOGS: 'logs',
  USERS: 'users',
};

/* 记录类型（logs 表） */
export const DB_TYPES = {
  FILE_STATUS: 'file_status',
  UPLOAD_LOG: 'upload_log',
};

/* 兼容旧结构 cfg.db={enabled,configUrl} → 迁移为 cfg.db={logs,users} */
export function normalizeDbCfg(cfg) {
  const d = cfg.db || {};
  if (typeof d.enabled === 'boolean') {
    const legacy = { enabled: d.enabled, configUrl: d.configUrl || '' };
    delete d.enabled;
    delete d.configUrl;
    if (!d.logs) d.logs = legacy;
    if (!d.users) d.users = { enabled: false, configUrl: '' };
  }
  if (!d.logs) d.logs = { enabled: false, configUrl: '' };
  if (!d.users) d.users = { enabled: false, configUrl: '' };
  return cfg;
}

/* 把 dbs-all.js 的记录表配置（window.module.exports）搬进 __dbsConfigs 池 */
function ensureConfigPool() {
  if (typeof window === 'undefined') return;
  try {
    window.__dbsConfigs = window.__dbsConfigs || {};
    if (window.module && window.module.exports && Object.keys(window.module.exports).length) {
      const slot = window.__dbsConfigs[DB_TABLES.LOGS];
      if (!slot || !Object.keys(slot.exports || {}).length) {
        window.__dbsConfigs[DB_TABLES.LOGS] = { exports: window.module.exports };
      }
    }
  } catch (e) {}
}

/* 指定表是否启用：cfg.db[table].enabled 且 DbsApi 已加载 */
export function dbEnabled(table) {
  try {
    const cfg = normalizeDbCfg(requireConfig());
    const t = table || DB_TABLES.LOGS;
    return !!(cfg.db[t] && cfg.db[t].enabled && window.DbsApi);
  } catch (e) {
    return false;
  }
}

const dbCache = {};

/* 获取指定表的 DbsApi 实例（Promise）；未启用 / 未加载时 reject */
export function getDb(table) {
  const t = table || DB_TABLES.LOGS;
  if (dbCache[t]) return dbCache[t];
  if (!dbEnabled(t)) return Promise.reject(new Error('数据表未启用'));
  ensureConfigPool();
  const tb = (normalizeDbCfg(requireConfig()).db[t]) || {};
  dbCache[t] = Promise.resolve()
    .then(() => {
      if (tb.configUrl) return window.DbsApi.init({ configUrl: tb.configUrl });
      return window.DbsApi.init({ table: t });
    })
    .catch((e) => {
      delete dbCache[t];
      throw e;
    });
  return dbCache[t];
}

export function resetDb() {
  Object.keys(dbCache).forEach((k) => delete dbCache[k]);
}

/* 连接测试：返回 { ok, text } */
export async function dbTest(table) {
  const db = await getDb(table);
  const info = await db.info();
  const text = ['uid=' + info.uid, 'nickname=' + info.nickname, 'tablen=' + info.tablen]
    .filter((x) => x.indexOf('undefined') < 0)
    .join(' / ');
  return { ok: true, text: text || '连接成功' };
}

/* 查询表字段：返回字段名数组 */
export async function dbGetFields(table) {
  const db = await getDb(table);
  const json = await db.getFields();
  if (!json || json.code !== 200) throw new Error((json && json.msg) || '读取字段失败');
  const fields = json.all || [];
  return Array.isArray(fields) ? fields : Object.keys(fields);
}

/* 通用查询：返回 { rows, count }；filter 为 SQL 风格 WHERE（如 type='file_status'） */
export async function dbQuery(filter, opts) {
  const table = (opts && opts.table) || DB_TABLES.LOGS;
  const db = await getDb(table);
  const json = await db.query({
    fields: (opts && opts.fields) || '',
    sort: (opts && opts.sort) || '',
    filter: filter || '',
    page: (opts && opts.page) || 1,
    limit: (opts && opts.limit) || 50,
  });
  if (!json || json.code !== 200) throw new Error((json && json.msg) || '查询失败');
  return { rows: json.fields || [], count: json.count || 0 };
}

/* 插入记录 */
export async function dbInsert(data, table) {
  const db = await getDb(table || DB_TABLES.LOGS);
  const json = await db.insert(data || {});
  if (!json || json.code !== 200) throw new Error((json && json.msg) || '插入失败');
  return json;
}

/* 更新记录：filter 定位行，data 为待更新字段 */
export async function dbUpdate(filter, data, table) {
  const db = await getDb(table || DB_TABLES.LOGS);
  const json = await db.update(filter, data || {});
  if (!json || json.code !== 200) throw new Error((json && json.msg) || '更新失败');
  return json;
}

/* 删除记录：filter 定位行（危险操作，调用方需确认） */
export async function dbRemove(filter, table) {
  const db = await getDb(table || DB_TABLES.LOGS);
  const json = await db.remove(filter);
  if (!json || json.code !== 200) throw new Error((json && json.msg) || '删除失败');
  return json;
}

function escVal(v) {
  return String(v == null ? '' : v).replace(/'/g, "''");
}

/* 追加一条日志类记录（尽力而为：失败静默，不打断主流程；GitHub 为权威存储） */
export async function dbAppendLog(type, userId, name, status, detail) {
  if (!dbEnabled(DB_TABLES.LOGS)) return;
  try {
    await dbInsert(
      {
        type: String(type || ''),
        user_id: String(userId || ''),
        name: String(name || ''),
        status: String(status || ''),
        detail: detail ? JSON.stringify(detail) : '',
      },
      DB_TABLES.LOGS
    );
  } catch (e) {}
}

/* 查询某用户某类型日志记录（新记录在前） */
export async function dbQueryLogs(type, userId, limit) {
  const r = await dbQuery(
    "type='" + escVal(type) + "' AND user_id='" + escVal(userId) + "'",
    { sort: 'createdAt DESC', limit: limit || 200, table: DB_TABLES.LOGS }
  );
  return r.rows;
}
