/**
 * 点鸭用户表适配层：把 GitHub 用户数据（info.json）渐进式同步到用户表（users），
 * 与 GitHub 共存双写、读取优先数据表。用户表字段：id / user_id / name / email / role /
 * avatar / stats / whitelist / devices / ip（点鸭主键 id 不写入，GitHub 用户 ID 存
 * user_id 字段；email 存绑定邮箱，供邮箱登录与唯一性检查读优先查询）。
 */
import { getDb, dbEnabled, dbInsert, dbUpdate, DB_TABLES } from './dbstable.js';

export function dbUserEnabled() {
  return dbEnabled(DB_TABLES.USERS);
}

function escQ(v) {
  return String(v == null ? '' : v).replace(/'/g, "''");
}

/* avatar：仅存短文本（链接/路径）；base64 超长则截断至单格上限 */
function dbAvatarValue(av) {
  if (!av) return '';
  const s = String(av);
  if (/^data:/i.test(s)) return s.slice(0, 65530);
  return s.slice(0, 500);
}

/* 把 GitHub 用户对象 upsert 到用户表（按 name 匹配，尽力而为：失败静默） */
export async function dbUserSync(user) {
  if (!dbUserEnabled() || !user || !user.id) return;
  try {
    const data = {
      user_id: String(user.id || '').slice(0, 40),
      name: String(user.name || '').slice(0, 60),
      role: String(user.role || 'user'),
      avatar: dbAvatarValue(user.avatar),
      stats: JSON.stringify(user.stats || {}),
      whitelist: JSON.stringify(Array.isArray(user.whitelist) ? user.whitelist : []),
      devices: JSON.stringify((Array.isArray(user.devices) ? user.devices : []).slice(0, 30)),
      ip: String(user.ip || '').slice(0, 100),
      email: String(user.email || '').slice(0, 120),
    };
    const filter = "user_id='" + escQ(user.id) + "'";
    const json = await getDb(DB_TABLES.USERS).then((db) => db.query({ filter, page: 1, limit: 1 }));
    if (json && json.code === 200 && json.fields && json.fields.length) {
      await dbUpdate(filter, data, DB_TABLES.USERS);
      return;
    }
    /* 兼容存量：早期按 name 匹配写入的行（无 user_id）→ 按 name 补写并补齐 user_id */
    const nameFilter = "name='" + escQ(String(user.name || '').slice(0, 60)) + "'";
    const old = await getDb(DB_TABLES.USERS).then((db) => db.query({ filter: nameFilter, page: 1, limit: 1 }));
    if (old && old.code === 200 && old.fields && old.fields.length) {
      await dbUpdate(nameFilter, data, DB_TABLES.USERS);
    } else {
      await dbInsert(data, DB_TABLES.USERS);
    }
  } catch (e) {}
}

/* 用户表读取：按 user_id 查用户（无则返回 null） */
export async function dbUserGet(userId) {
  if (!dbUserEnabled()) return null;
  const db = await getDb(DB_TABLES.USERS);
  const json = await db.query({ filter: "user_id='" + escQ(userId) + "'", page: 1, limit: 1 });
  if (json && json.code === 200 && json.fields && json.fields.length) return json.fields[0];
  return null;
}

/* 用户表按邮箱查询：返回行（含 user_id），无则 null */
export async function dbUserFindByEmail(email) {
  if (!dbUserEnabled() || !email) return null;
  const db = await getDb(DB_TABLES.USERS);
  const json = await db.query({ filter: "email='" + escQ(String(email).toLowerCase()) + "'", page: 1, limit: 1 });
  if (json && json.code === 200 && json.fields && json.fields.length) return json.fields[0];
  return null;
}
