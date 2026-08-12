/**
 * 我的项目（四列平铺卡片）+ 我的公开作品
 *
 * 项目数据绑定：users/<userId>/projects/<项目文件夹>/，一个项目一个文件夹。
 * 每个项目文件夹下存放绘制数据（project.json + question.txt + analysis.txt）与 info.json 元数据。
 *
 * 平铺卡片交互：
 *  1. 卡片以网格平铺展示（一行四个），内容保持：标题、ID、打开入口、修改时间、创作者、分享状态；
 *  2. 进入页面时卡片按顺序依次上下翻折出现，相邻间隙 100ms；
 *  3. 点击「打开」新标签页跳转函数绘制器（plotter/）加载该项目，点击「分享 / 取消分享」写分享索引 share/<id>/share/works.json +
 *     双写 info.json 的 shared 字段；卡片勾选后顶部批量栏可批量分享/取消（队列 + 600ms 间隔 + 额度检查）。
 */
import { toast, busyButton, showSkeleton, ERR_MSG } from './utils.js';
import { requireConfig, buildPath, ghRead, ghWrite, listFiles, listDirs, cdnUrls, withGhLock, checkRateLimit } from './github.js';
import { getCurrentUser, userFolder, appendUploadLog } from './user.js';
import { recordFileStatus } from './filestatus.js';
import { GAL_CATEGORIES } from './data.js';
import { shareWork, unshareWork, listMyWorks, readShareIndex, writeShareIndex, entryFromMeta, SHARE_INTERVAL } from './share.js';

/* ---------- 我的项目 ---------- */
let projList = [];          // 项目数组（含 folder 字段）
let shareBusy = false;      // 单个分享/取消进行中：禁用其余分享按钮
let batchBusy = false;      // 批量操作进行中：禁用批量栏按钮
let myWorks = [];           // 我的公开作品（索引条目，含 folder/path/name）

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 分享/取消进行中：禁用/恢复所有分享按钮（含批量渲染后的新按钮由 renderDeck 兜底） */
function setShareBusy(v) {
  shareBusy = v;
  const deck = document.getElementById('projDeck');
  if (deck) deck.querySelectorAll('.proj-share').forEach((b) => { b.disabled = v; });
}

function setBatchBusy(v) {
  batchBusy = v;
  const bar = document.getElementById('projBatchBar');
  if (bar) bar.querySelectorAll('button').forEach((b) => { b.disabled = v; });
  const deck = document.getElementById('projDeck');
  if (deck) deck.querySelectorAll('.proj-check').forEach((b) => { b.disabled = v; });
}

function selectedProjects() {
  return projList.filter((p) => p.checked);
}

function syncBatchBar() {
  const bar = document.getElementById('projBatchBar');
  const count = document.getElementById('projBatchCount');
  const sel = selectedProjects();
  if (bar) bar.classList.toggle('hidden', !sel.length);
  if (count) count.textContent = '已选 ' + sel.length + ' 项';
}

function setBatchProgress(text) {
  const count = document.getElementById('projBatchCount');
  if (count && text) count.textContent = text;
}

function projEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 读取 <usersRoot>/<userId>/projects 下的所有项目文件夹 */
async function loadProjects() {
  const cfg = requireConfig();
  const user = getCurrentUser();
  if (!user || !user.id) throw new Error('请先登录');
  const base = buildPath(userFolder(cfg, user.id), 'projects');
  const dirs = await listDirs(cfg, base);
  const projects = [];
  for (const d of dirs) {
    const folder = d.name;
    /* 一个项目一个文件夹：先找 info.json，退而求其次用第一个 json 文件 */
    let meta = null;
    try {
      const infoRaw = await ghRead(cfg, buildPath(base, folder, 'info.json'));
      if (infoRaw) meta = JSON.parse(infoRaw);
    } catch (e) {}
    if (!meta) {
      try {
        const files = await listFiles(cfg, buildPath(base, folder));
        const json = files.find((f) => /\.json$/i.test(f.name));
        if (json) {
          const raw = await ghRead(cfg, buildPath(base, folder, json.name));
          if (raw) meta = JSON.parse(raw);
        }
      } catch (e) {}
    }
    projects.push({
      folder,
      name: (meta && meta.name) || folder,
      id: (meta && meta.id) || folder,
      updatedAt: (meta && meta.updatedAt) || 0,
      author: (meta && meta.author) || user.name || '我',
      shared: !!(meta && meta.shared),
      meta,
    });
  }
  /* 兼容旧格式：直接散落在 projects 下的 *.json 文件 */
  try {
    const loose = await listFiles(cfg, base);
    for (const f of loose) {
      if (!/\.json$/i.test(f.name)) continue;
      const name = f.name.replace(/\.json$/i, '');
      if (projects.some((p) => p.folder === name || p.name === name)) continue;
      const raw = await ghRead(cfg, buildPath(base, f.name));
      let meta = null;
      try { meta = JSON.parse(raw); } catch (e) {}
      projects.push({
        folder: name,
        name: (meta && meta.name) || name,
        id: (meta && meta.id) || name,
        updatedAt: (meta && meta.updatedAt) || 0,
        author: (meta && meta.author) || user.name || '我',
        shared: !!(meta && meta.shared),
        meta,
      });
    }
  } catch (e) {}
  projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return projects;
}

/* 渲染平铺卡片网格 */
function renderDeck() {
  const deck = document.getElementById('projDeck');
  const empty = document.getElementById('projEmpty');
  if (!deck) return;
  deck.innerHTML = '';
  if (!projList.length) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  projList.forEach((p, i) => {
    const el = document.createElement('article');
    el.className = 'proj-card';
    /* 入场动画：按顺序依次上下翻折出现，间隙 100ms */
    el.style.animationDelay = i * 100 + 'ms';
    el.innerHTML = cardInner(p);
    if (shareBusy) {
      const sb = el.querySelector('.proj-share');
      if (sb) sb.disabled = true;
    }
    deck.appendChild(el);
  });
}

/* 卡片内容：勾选框 / 标题 / ID / 打开入口 / 修改时间 / 创作者 / 分享状态 */
function cardInner(p) {
  const time = p.updatedAt ? fmtTime(p.updatedAt) : '—';
  const sharedText = p.shared ? '已分享' : '未分享';
  const sharedCls = p.shared ? 'on' : 'off';
  return `
    <div class="proj-card-top">
      <input type="checkbox" class="proj-check" data-folder="${projEsc(p.folder)}" title="选择以批量分享/取消" ${p.checked ? 'checked' : ''} />
      <div class="proj-card-title">
        <strong>${projEsc(p.name)}</strong>
        <span>ID：${projEsc(p.id)}</span>
      </div>
      <button class="proj-open" data-folder="${projEsc(p.folder)}">打开</button>
    </div>
    <ul class="proj-meta">
      <li><span>修改时间</span><b>${time}</b></li>
      <li><span>创作者</span><b>${projEsc(p.author)}</b></li>
      <li><span>分享状态</span><b class="proj-shared-${sharedCls}">${sharedText}</b></li>
    </ul>
    <div class="proj-card-foot">
      <button class="proj-edit" data-folder="${projEsc(p.folder)}">编辑信息</button>
      <button class="proj-share" data-folder="${projEsc(p.folder)}">${p.shared ? '取消分享' : '分享'}</button>
    </div>
  `;
}

/* 打开项目：对接函数绘制器（plotter/），新标签页加载该项目数据 */
function onOpenProject(folder) {
  const p = projList.find((x) => x.folder === folder);
  if (!p) return;
  const user = getCurrentUser();
  const url = 'plotter/index.html?u=' + encodeURIComponent(user.id) + '&p=' + encodeURIComponent(folder);
  window.open(url, '_blank', 'noopener');
  toast('已打开项目：' + p.name);
}

/* 分享 / 取消分享：写分享索引 works.json（存相对路径） + 双写 info.json.shared。
 * 处理期间禁用本页所有分享/取消分享按钮，处理完才恢复，避免并发触发 API 限流。 */
async function onToggleShare(folder, btn) {
  const p = projList.find((x) => x.folder === folder);
  if (!p) return;
  const task = async () => {
    const cfg = requireConfig();
    const uid = getCurrentUser().id;
    const base = buildPath(userFolder(cfg, uid), 'projects', folder);
    const infoPath = buildPath(base, 'info.json');
    const next = !p.shared;
    const restore = busyButton(btn, '处理中…');
    setShareBusy(true);
    try {
      const meta = Object.assign({}, p.meta || {}, { name: p.name, id: p.id });
      if (next) {
        await shareWork(cfg, uid, folder, meta, infoPath);
      } else {
        await unshareWork(cfg, uid, folder, infoPath);
      }
      await appendUploadLog(cfg, uid, (next ? '分享项目：' : '取消分享：') + p.name);
      recordFileStatus('项目', p.name, next ? '已分享' : '已取消分享');
      p.shared = next;
      toast(next ? '已分享项目：' + p.name : '已取消分享：' + p.name);
      renderDeck();
    } catch (e) {
      toast(e.message || '分享操作失败');
    } finally {
      restore();
      setShareBusy(false);
    }
  };
  if (!withGhLock('share:' + folder, task)) {
    toast('操作进行中，请稍候…');
  }
}

/* ---------- 批量分享 / 取消分享 ---------- */
/* 队列顺序处理：先查 /rate_limit 额度，每个作品写 info.json（间隔 SHARE_INTERVAL），
 * 索引 works.json 一次性写回；处理期间禁用批量栏与分享按钮。 */
async function runBatchShare(mode) {
  const sel = selectedProjects();
  if (!sel.length) {
    toast('请先勾选要处理的作品');
    return;
  }
  const cfg = requireConfig();
  const uid = getCurrentUser().id;
  const label = mode === 'share' ? '分享' : '取消分享';
  const need = sel.length * 3 + 2; // 每个作品约 2-3 次写请求，预留余量
  const rate = await checkRateLimit(cfg, need);
  if (!rate.ok) {
    toast('GitHub API 剩余额度不足（' + rate.remaining + '），请稍后再试');
    return;
  }
  setBatchBusy(true);
  setShareBusy(true);
  try {
    const works = await readShareIndex(cfg, uid);
    for (let i = 0; i < sel.length; i++) {
      const p = sel[i];
      setBatchProgress('处理中 ' + (i + 1) + '/' + sel.length + '：' + p.name);
      const infoPath = buildPath(userFolder(cfg, uid), 'projects', p.folder, 'info.json');
      if (mode === 'share') {
        const meta = Object.assign({}, p.meta || {}, { name: p.name, id: p.id });
        works[p.folder] = entryFromMeta(cfg, uid, p.folder, meta);
      } else {
        delete works[p.folder];
      }
      let meta = {};
      try {
        const raw = await ghRead(cfg, infoPath);
        if (raw) meta = JSON.parse(raw);
      } catch (e) {}
      meta.name = meta.name || p.name;
      meta.shared = mode === 'share';
      meta.updatedAt = Date.now();
      await ghWrite(cfg, infoPath, JSON.stringify(meta, null, 2), (mode === 'share' ? 'Share ' : 'Unshare ') + p.folder);
      if (i < sel.length - 1) await sleep(SHARE_INTERVAL);
    }
    await writeShareIndex(cfg, uid, works);
    for (const p of sel) {
      p.shared = mode === 'share';
      p.checked = false;
    }
    await appendUploadLog(cfg, uid, '批量' + label + '：' + sel.map((x) => x.name).join('、'));
    recordFileStatus('分享', sel.length + ' 个作品', '批量' + label);
    toast('批量' + label + '完成');
    await openProjectsPage();
  } catch (e) {
    toast(e.message || ERR_MSG);
  } finally {
    setBatchBusy(false);
    setShareBusy(false);
    setBatchProgress('');
    syncBatchBar();
  }
}

/* 打开我的项目页（数据读取前显示骨架屏） */
export async function openProjectsPage() {
  const deck = document.getElementById('projDeck');
  /* 未登录：直接显示空态，不发请求 */
  const user = getCurrentUser();
  if (!user || !user.id) {
    projList = [];
    renderDeck();
    return;
  }
  showSkeleton(deck, 4, 'sk-card');
  try {
    projList = await loadProjects();
  } catch (e) {
    projList = [];
    toast(ERR_MSG);
  }
  renderDeck();
}

export function initProjects() {
  const deck = document.getElementById('projDeck');
  if (!deck) return;
  deck.addEventListener('click', (e) => {
    const open = e.target.closest('.proj-open');
    if (open) {
      onOpenProject(open.dataset.folder);
      return;
    }
    const edit = e.target.closest('.proj-edit');
    if (edit) {
      openProjEdit(edit.dataset.folder);
      return;
    }
    const share = e.target.closest('.proj-share');
    if (share) onToggleShare(share.dataset.folder, share);
  });
  deck.addEventListener('change', (e) => {
    const cb = e.target.closest('.proj-check');
    if (cb) onCheckChanged();
  });
  const checkAll = document.getElementById('projCheckAll');
  if (checkAll) checkAll.addEventListener('click', onCheckAll);
  const batchShare = document.getElementById('projBatchShare');
  if (batchShare) batchShare.addEventListener('click', () => runBatchShare('share'));
  const batchUnshare = document.getElementById('projBatchUnshare');
  if (batchUnshare) batchUnshare.addEventListener('click', () => runBatchShare('unshare'));
}

/* 勾选变化：同步选中状态 + 批量栏显隐 */
function onCheckChanged() {
  const deck = document.getElementById('projDeck');
  deck.querySelectorAll('.proj-check').forEach((cb) => {
    const p = projList.find((x) => x.folder === cb.dataset.folder);
    if (p) p.checked = cb.checked;
  });
  syncBatchBar();
}

function onCheckAll() {
  const deck = document.getElementById('projDeck');
  const boxes = deck.querySelectorAll('.proj-check');
  const all = boxes.length > 0 && Array.from(boxes).every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !all; });
  onCheckChanged();
}

/* ---------- 编辑作品信息（名称/说明/分类/标签） ---------- */
let projEditing = null;

function buildProjEditModal() {
  if (document.getElementById('projEditOverlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'proj-modal-overlay hidden';
  overlay.id = 'projEditOverlay';
  const cats = GAL_CATEGORIES.filter((c) => c !== '全部')
    .map((c) => `<option value="${projEsc(c)}">${projEsc(c)}</option>`)
    .join('');
  overlay.innerHTML = `
    <div class="proj-modal">
      <h3>编辑作品信息</h3>
      <p class="desc">信息随 info.json 上传；已分享的作品会同步到公开作品广场</p>
      <div class="form-field"><label>作品名称</label><input class="text-input" id="peName" /></div>
      <div class="form-field"><label>作品说明</label><textarea class="ai-rules-input" id="peDesc" rows="2" placeholder="一句话描述作品内容"></textarea></div>
      <div class="form-field"><label>作品分类</label><select id="peCat">${cats}<option value="">未分类</option></select></div>
      <div class="form-field"><label>作品标签（逗号分隔）</label><input class="text-input" id="peTags" placeholder="如：函数, 动画" /></div>
      <div class="actions-row">
        <button class="btn-ghost" id="peCancel" type="button">取消</button>
        <button class="btn" id="peSave" type="button">保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('peCancel').addEventListener('click', closeProjEdit);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeProjEdit();
  });
  document.getElementById('peSave').addEventListener('click', onSaveProjEdit);
}

function openProjEdit(folder) {
  const p = projList.find((x) => x.folder === folder);
  if (!p) return;
  buildProjEditModal();
  projEditing = p;
  document.getElementById('peName').value = p.name;
  document.getElementById('peDesc').value = (p.meta && p.meta.desc) || '';
  document.getElementById('peCat').value = (p.meta && p.meta.category) || '';
  document.getElementById('peTags').value = (p.meta && Array.isArray(p.meta.tags)) ? p.meta.tags.join(',') : '';
  document.getElementById('projEditOverlay').classList.remove('hidden');
}

function closeProjEdit() {
  projEditing = null;
  const ov = document.getElementById('projEditOverlay');
  if (ov) ov.classList.add('hidden');
}

async function onSaveProjEdit() {
  if (!projEditing) return;
  const p = projEditing;
  const saveBtn = document.getElementById('peSave');
  const restore = busyButton(saveBtn, '保存中…');
  try {
    const cfg = requireConfig();
    const user = getCurrentUser();
    const base = buildPath(userFolder(cfg, user.id), 'projects', p.folder);
    const infoPath = buildPath(base, 'info.json');
    const existing = await ghRead(cfg, infoPath);
    let meta = {};
    try { meta = existing ? JSON.parse(existing) : {}; } catch (e) {}
    meta.name = document.getElementById('peName').value.trim() || p.folder;
    meta.desc = document.getElementById('peDesc').value.trim();
    meta.category = document.getElementById('peCat').value;
    meta.tags = document.getElementById('peTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    meta.updatedAt = Date.now();
    if (!meta.id) meta.id = p.id;
    if (!meta.author) meta.author = p.author;
    await ghWrite(cfg, infoPath, JSON.stringify(meta, null, 2), 'Edit project ' + p.folder);
    /* 已分享：同步更新分享索引 works.json 的条目，公开作品广场立即生效 */
    if (p.shared) {
      const works = await readShareIndex(cfg, user.id);
      if (works[p.folder]) {
        works[p.folder] = Object.assign({}, works[p.folder], {
          path: buildPath(cfg.usersRoot, user.id, 'projects', p.folder),
          name: meta.name,
          desc: meta.desc,
          category: meta.category,
          tags: meta.tags,
          updatedAt: meta.updatedAt,
        });
        await writeShareIndex(cfg, user.id, works);
      }
    }
    recordFileStatus('项目', meta.name, '已更新信息');
    projList = await loadProjects();
    renderDeck();
    closeProjEdit();
    toast('作品信息已保存');
  } catch (e) {
    toast(e.message || ERR_MSG);
  } finally {
    restore();
  }
}

/* ---------- 我的公开作品（读 <shareRoot>/<userId>/share/works.json 索引） ---------- */
export async function openMyWorksPage() {
  const listEl = document.getElementById('myworksList');
  if (!listEl) return;
  showSkeleton(listEl, 3, 'sk-row');
  let cfg = null;
  let user = null;
  myWorks = [];
  try {
    const u = getCurrentUser();
    if (!u || !u.id) throw new Error('请先登录');
    user = u;
    cfg = requireConfig();
    myWorks = await listMyWorks(cfg, user.id);
  } catch (e) {
    const msg = (e && e.message === '请先登录') ? '请先登录后查看公开作品' : ERR_MSG;
    listEl.innerHTML = '<div class="myworks-empty">' + msg + '</div>';
    return;
  }
  if (!myWorks.length) {
    listEl.innerHTML = '<div class="myworks-empty">还没有分享的作品，去「我的项目」里点分享吧</div>';
    return;
  }
  listEl.innerHTML = myWorks
    .map(
      (w) => `
      <article class="myworks-item glass-mini" data-folder="${projEsc(w.folder)}">
        <div class="myworks-item-main">
          <strong>${projEsc(w.name || w.folder)}</strong>
          <span>${projEsc(w.path || '')}</span>
        </div>
        <div class="myworks-item-actions">
          <button class="btn myworks-open">打开</button>
          <button class="btn-ghost myworks-unshare">取消分享</button>
        </div>
      </article>`
    )
    .join('');
  listEl.onclick = onMyWorksClick;
}

function onMyWorksClick(e) {
  const item = e.target.closest('.myworks-item');
  if (!item) return;
  const folder = item.dataset.folder;
  if (e.target.closest('.myworks-open')) {
    onOpenWork(folder);
    return;
  }
  if (e.target.closest('.myworks-unshare')) {
    onUnshare(folder, item);
  }
}

/* 打开公开作品：从索引 path（users/<uid>/projects/<folder>）解析项目定位并跳转函数绘制器 */
function onOpenWork(folder) {
  try {
    const w = myWorks.find((x) => x.folder === folder);
    const p = String((w && w.path) ? w.path : '').split('/').filter(Boolean);
    const i = p.indexOf('projects');
    const uid = i >= 1 ? p[i - 1] : '';
    const proj = i >= 0 && p.length > i + 1 ? p[i + 1] : folder;
    if (!uid) {
      toast(ERR_MSG);
      return;
    }
    const url = 'plotter/index.html?u=' + encodeURIComponent(uid) + '&p=' + encodeURIComponent(proj);
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    toast(ERR_MSG);
  }
}

/* 取消分享：从 works.json 索引移除条目 + 双写 info.json.shared */
async function onUnshare(folder, item) {
  const w = myWorks.find((x) => x.folder === folder) || {};
  const name = w.name || folder;
  const ok = window.confirm('确定取消分享「' + name + '」吗？');
  if (!ok) return;
  const task = async () => {
    const cfg = requireConfig();
    const user = getCurrentUser();
    const infoPath = buildPath(userFolder(cfg, user.id), 'projects', folder, 'info.json');
    const btn = item && item.querySelector('.myworks-unshare');
    const restore = busyButton(btn, '处理中…');
    try {
      await unshareWork(cfg, user.id, folder, infoPath);
      await appendUploadLog(cfg, user.id, '取消分享作品：' + name);
      recordFileStatus('分享', name, '已取消');
      toast('已取消分享');
      if (item) item.remove();
      const listEl = document.getElementById('myworksList');
      if (listEl && !listEl.querySelector('.myworks-item')) {
        listEl.innerHTML = '<div class="myworks-empty">还没有分享的作品，去「我的项目」里点分享吧</div>';
      }
    } catch (err) {
      toast(ERR_MSG);
    } finally {
      restore();
    }
  };
  if (!withGhLock('unshare:' + folder, task)) {
    toast('操作进行中，请稍候…');
  }
}
