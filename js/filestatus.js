/**
 * 文件处理状态：把上传 / 操作仓库的记录追加到用户文件夹 file-status.log，
 * 「文件处理状态」页读取并展示（仿管理者设置-管理公开作品列表样式）。
 * 记录行格式：ISO时间\t类型\t作品名\t状态
 */
import { buildPath, ghRead, ghWrite, requireConfig } from './github.js';
import { getCurrentUser } from './user.js';
import { dbEnabled, dbAppendLog, dbQueryLogs, DB_TYPES } from './dbstable.js';

export const FS_TYPES = ['错题上传', '题目', '知识库', '项目', '分享'];

function fsLogPath(cfg, userId) {
  return buildPath(cfg.usersRoot, String(userId), 'file-status.log');
}

function fsEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fsFmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* 追加一条文件处理记录（尽力而为：失败静默，不打断主流程；GitHub 与数据表共存双写） */
export async function recordFileStatus(type, name, status) {
  const s = getCurrentUser();
  if (!s || !s.id) return;
  if (dbEnabled()) {
    await dbAppendLog(DB_TYPES.FILE_STATUS, s.id, name, status, { type, name, status });
  }
  try {
    const cfg = requireConfig();
    const path = fsLogPath(cfg, s.id);
    const existing = await ghRead(cfg, path);
    const lines = existing ? existing.split('\n').filter(Boolean) : [];
    lines.push([new Date().toISOString(), String(type || ''), String(name || ''), String(status || '')].join('\t'));
    await ghWrite(cfg, path, lines.join('\n'), 'Update file status ' + s.id);
  } catch (e) {}
}

/* 读取并解析文件处理记录（新记录在前；读取优先数据表，失败回退 GitHub） */
export async function getFileStatusList() {
  const s = getCurrentUser();
  if (!s || !s.id) return [];
  if (dbEnabled()) {
    try {
      const rows = await dbQueryLogs(DB_TYPES.FILE_STATUS, s.id, 200);
      if (rows && rows.length) {
        return rows.map((r) => {
          let det = {};
          try {
            det = JSON.parse(r.detail || '{}');
          } catch (e) {}
          return {
            time: r.createdAt || r.updatedAt || '',
            type: det.type || '',
            name: r.name || '',
            status: r.status || '',
          };
        });
      }
    } catch (e) {}
  }
  const cfg = requireConfig();
  const content = await ghRead(cfg, fsLogPath(cfg, s.id));
  if (!content) return [];
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const p = line.split('\t');
      return { time: p[0] || '', type: p[1] || '', name: p[2] || '', status: p[3] || '' };
    })
    .reverse();
}

/* 打开文件处理状态页：渲染仿「管理公开作品」的列表 */
export async function openFileStatusPage() {
  const box = document.getElementById('filestatusList');
  if (!box) return;
  try {
    const list = await getFileStatusList();
    if (!list.length) {
      box.innerHTML = '<div class="adm-empty">暂无文件处理记录。上传、分享或操作仓库后，记录会保存在你的用户文件夹 file-status.log 中</div>';
      return;
    }
    box.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>作品名称</th><th>作品类型</th><th>状态</th><th>操作时间</th></tr></thead>
        <tbody>${list
          .map(
            (r) => `
          <tr>
            <td>${fsEsc(r.name) || '—'}</td>
            <td><span class="badge">${fsEsc(r.type) || '—'}</span></td>
            <td><span class="badge ${r.status === '失败' ? 'wait' : 'ok'}">${fsEsc(r.status) || '—'}</span></td>
            <td>${fsEsc(fsFmtTime(r.time))}</td>
          </tr>`
          )
          .join('')}</tbody>
      </table>`;
  } catch (e) {
    box.innerHTML = '<div class="adm-empty">服务器超时啦～ฅ(´・̥ω・̥`)ฅ</div>';
  }
}
