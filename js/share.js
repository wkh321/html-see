/**
 * 公开作品分享索引（整改）：
 * 不再把作品文件复制到公开作品目录，改为在 <shareRoot>/<userId>/share/works.json
 * 存作品的仓库内相对路径 + 分类等元信息，实时同步原项目，节省仓库空间。
 *  - works.json 为聚合索引：{ [作品folder]: { path, name, desc, category, tags, updatedAt } }
 *  - path 为仓库内相对路径，如 users/<uid>/projects/<folder>
 *  - 分享/取消同时双写项目 info.json 的 shared 字段
 *  - 批量操作：顺序队列 + 每操作间隔 SHARE_INTERVAL + 先查 /rate_limit 额度
 */
import { buildPath, ghRead, ghWrite } from './github.js';

export const SHARE_INTERVAL = 600; // 批量操作每个写请求的间隔（ms）
export const SHARE_DIR = 'share'; // 用户公开作品索引目录（share 目录内为 JSON 索引，非作品本体）
export const SHARE_FILE = 'works.json';

export function shareIndexPath(cfg, uid) {
  return buildPath(cfg.shareRoot, String(uid), SHARE_DIR, SHARE_FILE);
}

/* 读取用户分享索引（容错：不存在 / 解析失败 → 空对象） */
export async function readShareIndex(cfg, uid) {
  try {
    const raw = await ghRead(cfg, shareIndexPath(cfg, uid));
    if (!raw) return {};
    const d = JSON.parse(raw);
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (e) {
    return {};
  }
}

export async function writeShareIndex(cfg, uid, works) {
  await ghWrite(cfg, shareIndexPath(cfg, uid), JSON.stringify(works, null, 2), 'Update share index ' + uid);
}

/* 由项目 meta 构造分享索引条目（path 指向原项目文件夹） */
export function entryFromMeta(cfg, uid, folder, meta) {
  return {
    path: buildPath(cfg.usersRoot, String(uid), 'projects', folder),
    name: (meta && meta.name) || folder,
    desc: (meta && meta.desc) || '',
    category: (meta && meta.category) || '',
    tags: (meta && Array.isArray(meta.tags)) ? meta.tags : [],
    updatedAt: (meta && meta.updatedAt) || Date.now(),
  };
}

/* 分享单个作品：写索引（读-改-写）+ 双写 info.json.shared */
export async function shareWork(cfg, uid, folder, meta, infoPath) {
  meta = meta || {};
  meta.shared = true;
  meta.updatedAt = Date.now();
  const works = await readShareIndex(cfg, uid);
  works[folder] = entryFromMeta(cfg, uid, folder, meta);
  await writeShareIndex(cfg, uid, works);
  if (infoPath) {
    await ghWrite(cfg, infoPath, JSON.stringify(meta, null, 2), 'Share ' + folder);
  }
  return works;
}

/* 取消分享单个作品：从索引移除条目 + 双写 info.json.shared */
export async function unshareWork(cfg, uid, folder, infoPath) {
  const works = await readShareIndex(cfg, uid);
  const had = Object.prototype.hasOwnProperty.call(works, folder);
  delete works[folder];
  if (had) await writeShareIndex(cfg, uid, works);
  if (infoPath) {
    let meta = {};
    try {
      const raw = await ghRead(cfg, infoPath);
      if (raw) meta = JSON.parse(raw);
    } catch (e) {}
    meta.shared = false;
    meta.updatedAt = Date.now();
    await ghWrite(cfg, infoPath, JSON.stringify(meta, null, 2), 'Unshare ' + folder);
  }
  return works;
}

/* 我的公开作品列表：读用户分享索引 */
export async function listMyWorks(cfg, uid) {
  const index = await readShareIndex(cfg, uid);
  return Object.keys(index).map((folder) => ({ folder, ...index[folder] }));
}
