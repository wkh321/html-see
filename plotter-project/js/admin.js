import { adminTabs, adminData, icons } from './data.js';
import { toast, busyButton, showSkeleton, ERR_MSG } from './utils.js';
import {
  getConfig, saveConfig, hasConfig, requireConfig,
  ghRead, cdnUrls, buildPath, withGhLock, rawUrl,
} from './github.js';
import { readIndex, readUser, writeUser, validatePassword, parseIndex, getCurrentUser } from './user.js';
import { dbTest, dbGetFields, dbQuery, dbInsert, dbUpdate, dbRemove } from './dbstable.js';
import { mailSendCode, mailEnabled } from './mail.js';

export function initAdmin() {
  renderTabs();
  renderPanes();
  bindInteractions();
  loadAdminConfig();
  if (hasConfig()) refreshUsers();
}

function renderTabs() {
  const container = document.getElementById('adminTabs');
  container.innerHTML = adminTabs
    .map((tab, i) => `<button class="admin-tab${i === 0 ? ' active' : ''}" data-tab="${tab.key}">${tab.icon}${tab.label}</button>`)
    .join('');

  container.addEventListener('click', (e) => {
    const tab = e.target.closest('.admin-tab[data-tab]');
    if (!tab) return;
    container.querySelectorAll('.admin-tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.admin-pane').forEach((p) =>
      p.classList.toggle('active', p.dataset.pane === tab.dataset.tab)
    );
    if (tab.dataset.tab === 'users' && hasConfig()) refreshUsers();
    if (tab.dataset.tab === 'tree' && hasConfig()) {
      const run = withGhLock('load-tree', loadTree);
      if (run) run.catch(() => {});
    }
  });
}

function renderPanes() {
  const container = document.getElementById('adminPanes');
  container.innerHTML = `
    ${githubPane()}
    ${aiPane()}
    ${musicPane()}
    ${treePane()}
    ${usersPane()}
    ${worksPane()}
    ${reviewPane()}
    ${permsPane()}
    ${batchPane()}
    ${dbsPane()}
    ${mailPane()}
  `;
}

/* ---------- ① 对接 GitHub 知识点仓库（借鉴 auth.js 配置结构） ---------- */
function githubPane() {
  const cfg = getConfig() || {};
  const cdn = (cfg.cdn && typeof cfg.cdn === 'object') ? cfg.cdn : {};
  return `
    <div class="admin-pane active" data-pane="github">
      <div class="admin-card glass-card">
        <h3>${icons.github} 对接 GitHub 知识点仓库</h3>
        <p class="desc">配置后按仓库目录同步账号与知识库：users/_index.txt（用户索引）、users/&lt;id&gt;/info.json（用户数据）、private/（头像）、projects/（项目）</p>
        <div class="form-grid">
          <div class="form-field"><label>Token</label><input class="text-input" id="admToken" type="password" placeholder="ghp_xxxxxxxx" value="${cfg.token || ''}" /></div>
          <div class="form-field"><label>Owner</label><input class="text-input" id="admOwner" placeholder="GitHub 用户名" value="${cfg.owner || ''}" /></div>
          <div class="form-field"><label>Repo</label><input class="text-input" id="admRepo" placeholder="仓库名" value="${cfg.repo || ''}" /></div>
          <div class="form-field"><label>Branch</label><input class="text-input" id="admBranch" value="${cfg.branch || 'main'}" /></div>
          <div class="form-field"><label>usersRoot（用户目录）</label><input class="text-input" id="admUsersRoot" value="${cfg.usersRoot || 'users'}" /></div>
          <div class="form-field"><label>avatarsRoot（公共头像）</label><input class="text-input" id="admAvatarsRoot" value="${cfg.avatarsRoot || 'avatars'}" /></div>
          <div class="form-field"><label>shareRoot（公开作品）</label><input class="text-input" id="admShareRoot" value="${cfg.shareRoot || 'share'}" /></div>
        </div>
        <div class="cdn-links-block">
          <div class="cdn-links-title">${icons.spark} 文件访问链接前缀（留空使用默认 CDN 地址）</div>
          <div class="form-grid">
            <div class="form-field"><label>fastly 前缀（默认 jsdelivr）</label><input class="text-input" id="admCdnFastly" placeholder="https://fastly.jsdelivr.net/gh/OWNER/REPO@BRANCH/" value="${escapeAttr(cdn.fastly || '')}" /></div>
            <div class="form-field"><label>gcore 前缀（默认 jsdelivr）</label><input class="text-input" id="admCdnGcore" placeholder="https://gcore.jsdelivr.net/gh/OWNER/REPO@BRANCH/" value="${escapeAttr(cdn.gcore || '')}" /></div>
            <div class="form-field"><label>raw 前缀（默认 raw.githubusercontent）</label><input class="text-input" id="admCdnRaw" placeholder="https://raw.githubusercontent.com/OWNER/REPO/BRANCH/" value="${escapeAttr(cdn.raw || '')}" /></div>
          </div>
        </div>
        <div class="form-row">
          <button class="btn" id="admSaveBtn">保存配置</button>
          <button class="btn-ghost btn" id="admTestBtn">测试连接</button>
          <span class="conn-status" id="admConnStatus"><span class="dot"></span><span id="admConnText">未连接</span></span>
        </div>
        <div class="cdn-links hidden" id="cdnLinks"></div>
      </div>
    </div>`;
}

/* ---------- ② AI 助手配置 ---------- */
function aiPane() {
  const ai = (getConfig() && getConfig().ai) || {};
  const params = Array.isArray(ai.params) && ai.params.length ? ai.params : [{ key: '', value: '' }];
  const paramRows = params
    .map(
      (p) => `
      <div class="ai-param-row">
        <input class="text-input ai-param-key" placeholder="参数名（如 model）" value="${escapeAttr(p.key || '')}" />
        <input class="text-input ai-param-value" placeholder="参数值：{{input}}=输入 / {{rules}}=守则 / {{id}}=用户ID" value="${escapeAttr(p.value || '')}" />
        <button class="btn-mini danger ai-param-del" type="button">删除</button>
      </div>`
    )
    .join('');
  return `
    <div class="admin-pane" data-pane="ai">
      <div class="admin-card glass-card">
        <h3>${icons.ai} AI 助手配置</h3>
        <p class="desc">配置后，AI 助手面板将按此接口请求。参数值可用 {{input}} 表示用户当前输入、{{rules}} 表示 AI 守则（守则仅在新对话首次请求注入；若无 {{rules}} 参数，守则自动拼在输入内容前）、{{id}} 表示当前用户 ID</p>
        <div class="form-grid">
          <div class="form-field" style="grid-column:1/-1"><label>API 地址</label><input class="text-input" id="admAiUrl" placeholder="https://example.com/api/chat" value="${escapeAttr(ai.url || '')}" /></div>
          <div class="form-field"><label>请求方式</label>
            <select id="admAiMethod">
              <option value="POST"${ai.method === 'GET' ? '' : ' selected'}>POST（参数放 JSON body）</option>
              <option value="GET"${ai.method === 'GET' ? ' selected' : ''}>GET（参数拼接 URL query）</option>
            </select>
          </div>
          <div class="form-field"><label>回复内容路径（JSON 点分，如 mag.answer）</label><input class="text-input" id="admAiPath" placeholder="mag.answer" value="${escapeAttr(ai.path || '')}" /></div>
          <div class="form-field" style="grid-column:1/-1"><label>AI 守则（可留空）</label><textarea class="ai-rules-input" id="admAiRules" rows="3" placeholder="如：你是一名数学老师，只解答数学问题，回答用中文">${escapeText(ai.rules || '')}</textarea></div>
        </div>
        <div class="form-field" style="margin-bottom:14px;">
          <label>参数列表（键值对字典）</label>
          <div id="admAiParams">${paramRows}</div>
          <button class="btn-mini ghost" id="admAiAddParam" type="button">+ 添加参数</button>
        </div>
        <div class="form-row">
          <label class="ai-enabled-toggle"><input type="checkbox" id="admAiEnabled" ${ai.enabled === false ? '' : 'checked'} /> 启用 AI 助手</label>
          <button class="btn" id="admAiSaveBtn">保存 AI 配置</button>
        </div>
      </div>
    </div>`;
}

/* ---------- ③ 音乐播放配置（与 AI 配置同构：API / 参数字典 / 请求方式，无守则字段） ---------- */
function musicPane() {
  const m = (getConfig() && getConfig().music) || {};
  const params = Array.isArray(m.params) && m.params.length ? m.params : [{ key: '', value: '' }];
  const paramRows = params
    .map(
      (p) => `
      <div class="ai-param-row">
        <input class="text-input ai-param-key" placeholder="参数名（如 id）" value="${escapeAttr(p.key || '')}" />
        <input class="text-input ai-param-value" placeholder="参数值：{{id}}=歌曲ID" value="${escapeAttr(p.value || '')}" />
        <button class="btn-mini danger ai-param-del" type="button">删除</button>
      </div>`
    )
    .join('');
  const playlist = Array.isArray(m.playlist) ? m.playlist.join('\n') : String(m.playlist || '');
  return `
    <div class="admin-pane" data-pane="music">
      <div class="admin-card glass-card">
        <h3>${icons.music} 音乐播放配置</h3>
        <p class="desc">配置后网页左侧将出现玻璃拟态悬浮音乐卡片。参数值用 {{id}} 表示歌曲 ID；播放列表每行一个歌曲 ID；开启随机播放后，网页有 60%-70% 概率播放列表中的歌曲，其余由网页随机挑选 ID。以 BugPk 音乐接口为例：API 地址填 https://api.bugpk.com/api/163_music，参数列表加 type=song 与 id={{id}}；该接口扁平返回 name/ar_name/al_name/pic/url，播放器自动识别</p>
        <div class="form-grid">
          <div class="form-field" style="grid-column:1/-1"><label>音乐获取 API</label><input class="text-input" id="admMusicUrl" placeholder="https://example.com/api/music" value="${escapeAttr(m.url || '')}" /></div>
          <div class="form-field"><label>请求方式</label>
            <select id="admMusicMethod">
              <option value="GET"${m.method === 'POST' ? '' : ' selected'}>GET（参数拼接 URL query）</option>
              <option value="POST"${m.method === 'POST' ? ' selected' : ''}>POST（参数放 JSON body）</option>
            </select>
          </div>
          <div class="form-field"><label>歌曲信息路径（JSON 点分，留空自动识别根/ data）</label><input class="text-input" id="admMusicPath" placeholder="留空自动识别，如 data" value="${escapeAttr(m.path || '')}" /></div>
        </div>
        <div class="form-field" style="margin-bottom:14px;">
          <label>参数列表（键值对字典，{{id}}=歌曲ID）</label>
          <div id="admMusicParams">${paramRows}</div>
          <button class="btn-mini ghost" id="admMusicAddParam" type="button">+ 添加参数</button>
        </div>
        <div class="form-field" style="margin-bottom:14px;">
          <label>播放列表（每行一个歌曲 ID）</label>
          <textarea class="ai-rules-input" id="admMusicPlaylist" rows="4" placeholder="每行一个歌曲 ID，如：&#10;185668&#10;186016">${escapeText(playlist)}</textarea>
        </div>
        <div class="form-row">
          <label class="ai-enabled-toggle"><input type="checkbox" id="admMusicRandom" ${m.random !== false ? 'checked' : ''} /> 允许播放其他随机音乐</label>
          <label class="ai-enabled-toggle"><input type="checkbox" id="admMusicEnabled" ${m.enabled === false ? '' : 'checked'} /> 启用音乐播放</label>
          <button class="btn" id="admMusicSaveBtn">保存音乐配置</button>
          <button class="btn-ghost" id="admMusicRefreshBtn" type="button">刷新卡片</button>
        </div>
      </div>
    </div>`;
}

/* ---------- ④ 仓库文件总览：递归遍历整个仓库渲染文件树 ---------- */
function treePane() {
  return `
    <div class="admin-pane" data-pane="tree">
      <div class="admin-card glass-card">
        <h3>${icons.tree} 仓库文件总览</h3>
        <p class="desc">递归遍历绑定仓库的全部文件并渲染文件树；点击文件夹可展开 / 收起</p>
        <div class="form-row" style="margin-bottom:14px;">
          <button class="btn-ghost btn" id="admTreeLoadBtn">加载文件树</button>
          <span class="conn-status"><span id="admTreeMeta">未加载</span></span>
        </div>
        <div id="admTreeRoot"><div class="adm-empty">点击「加载文件树」查看仓库全部文件</div></div>
      </div>
    </div>`;
}

/* ---------- ⑤ 查看全部用户数据（users/_index.txt） ---------- */
function usersPane() {
  return `
    <div class="admin-pane" data-pane="users">
      <div class="admin-card glass-card">
        <h3>${icons.users} 查看全部用户数据</h3>
        <p class="desc" id="admUsersCount">读取 users/_index.txt 用户索引</p>
        <div class="form-row" style="margin-bottom:14px;">
          <button class="btn-ghost btn" id="admRefreshUsersBtn">刷新用户列表</button>
        </div>
        <div id="admUsersList"><div class="adm-empty">未读取用户列表</div></div>
      </div>
    </div>`;
}

/* ---------- ④ 管理公开作品（演示数据） ---------- */
function worksPane() {
  const rows = adminData.works
    .map(
      (w, i) => `
      <tr data-row="${i}">
        <td>${w.name}</td>
        <td>${w.author}</td>
        <td><span class="badge ${w.status === '已上架' ? 'ok' : w.status === '已下架' ? 'wait' : ''}">${w.status}</span></td>
        <td>
          <div class="actions-row">
            <button class="btn-mini ghost" data-op="toggle-work" data-i="${i}">${w.status === '已上架' ? '下架' : '上架'}</button>
            <button class="btn-mini danger" data-op="del-work" data-i="${i}">删除</button>
          </div>
        </td>
      </tr>`
    )
    .join('');
  return `
    <div class="admin-pane" data-pane="works">
      <div class="admin-card glass-card">
        <h3>${icons.image} 管理公开作品</h3>
        <p class="desc">控制广场作品的上下架状态</p>
        <table class="admin-table">
          <thead><tr><th>作品名称</th><th>作者</th><th>状态</th><th>操作</th></tr></thead>
          <tbody id="worksTbody">${rows}</tbody>
        </table>
      </div>
    </div>`;
}

/* ---------- ⑤ 审核用户上传题目（演示数据） ---------- */
function reviewPane() {
  const rows = adminData.reviews
    .map(
      (r, i) => `
      <div class="batch-item" data-row="${i}">
        <span class="batch-name">${r.name}</span>
        <span class="batch-meta">${r.author} · ${r.time}</span>
        <div class="actions-row">
          <button class="btn-mini ok" data-op="pass-review" data-i="${i}">通过</button>
          <button class="btn-mini danger" data-op="reject-review" data-i="${i}">驳回</button>
        </div>
      </div>`
    )
    .join('');
  return `
    <div class="admin-pane" data-pane="review">
      <div class="admin-card glass-card">
        <h3>${icons.file} 审核用户上传题目</h3>
        <p class="desc">审核通过后，题目才会进入公共知识库</p>
        <div id="reviewList">${rows}</div>
      </div>
    </div>`;
}

/* ---------- ⑥ 权限管控（演示数据） ---------- */
function permsPane() {
  const rows = adminData.perms
    .map(
      (p) => `
      <div class="batch-item">
        <span class="batch-name">${p.role}</span>
        <span class="batch-meta">${p.desc}</span>
        <label class="perm-toggle">
          <input type="checkbox" data-op="toggle-perm" data-role="${p.role}" ${p.on ? 'checked' : ''} />
          <span></span>
        </label>
      </div>`
    )
    .join('');
  return `
    <div class="admin-pane" data-pane="perms">
      <div class="admin-card glass-card">
        <h3>${icons.shield} 权限管控</h3>
        <p class="desc">管理各角色的功能权限开关</p>
        ${rows}
      </div>
    </div>`;
}

/* ---------- ⑦ 批量操作素材（演示数据） ---------- */
function batchPane() {
  const items = adminData.batches
    .map(
      (b, i) => `
      <div class="batch-item">
        <input type="checkbox" data-op="select-batch" data-i="${i}" data-name="${b.name}" />
        <span class="batch-name">${b.name}</span>
        <span class="batch-meta">${b.meta}</span>
      </div>`
    )
    .join('');
  return `
    <div class="admin-pane" data-pane="batch">
      <div class="admin-card glass-card">
        <h3>${icons.folder} 批量操作素材</h3>
        <p class="desc">勾选素材后统一执行操作</p>
        <div class="batch-bar">
          <span class="selected-tip" id="batchTip">已选 0 项</span>
          <button class="btn-mini ghost" data-op="select-all-batch">全选</button>
          <button class="btn-mini ok" data-op="batch-publish">批量上架</button>
          <button class="btn-mini warn" data-op="batch-move">批量移动</button>
          <button class="btn-mini danger" data-op="batch-delete">批量删除</button>
        </div>
        <div id="batchList">${items}</div>
      </div>
    </div>`;
}

/* ---------- ⑧ 点鸭数据表（记录表：日志类数据，与 GitHub 共存双写） ---------- */
function dbsPane() {
  const db = (getConfig() && getConfig().db) || {};
  const logs = (db.logs && typeof db.logs === 'object') ? db.logs : {};
  const users = (db.users && typeof db.users === 'object') ? db.users : {};
  return `
    <div class="admin-pane" data-pane="dbs">
      <div class="admin-card glass-card">
        <h3>${icons.database} 点鸭数据表</h3>
        <p class="desc">对接点鸭数据表（js/dbs-all.js 记录表 + js/dbs-users.js 用户表）。记录表存日志类数据（文件处理状态 / 上传日志），用户表存用户数据，均与 GitHub 共存双写、读取优先数据表。表格顶部选择要操作的数据表。</p>
        <div class="form-row dbs-select-row">
          <label>选择数据表</label>
          <select id="admDbSelect">
            <option value="logs">记录表（文件处理状态 / 上传日志）</option>
            <option value="users">用户表（用户数据）</option>
          </select>
        </div>
        <div id="admDbCfgLogs">
          <div class="form-grid">
            <div class="form-field" style="grid-column:1/-1"><label>记录表配置地址 configUrl（留空使用 dbs-all.js 内置配置）</label><input class="text-input" id="admDbConfigUrlLogs" placeholder="https://xxx/dbs-api.js（非必填）" value="${escapeAttr(logs.configUrl || '')}" /></div>
          </div>
          <div class="form-row">
            <label class="ai-enabled-toggle"><input type="checkbox" id="admDbEnabledLogs" ${logs.enabled ? 'checked' : ''} /> 启用记录表</label>
            <button class="btn" id="admDbSaveLogs">保存配置</button>
            <button class="btn-ghost btn" id="admDbTestLogs">连接测试</button>
            <button class="btn-ghost btn" id="admDbFieldsLogs">查看字段</button>
            <span class="conn-status" id="admDbConnLogs"><span class="dot"></span><span id="admDbConnLogsText">未连接</span></span>
          </div>
          <div class="cdn-links hidden" id="admDbFieldsLogsBox"></div>
        </div>
        <div id="admDbCfgUsers" class="hidden">
          <div class="form-grid">
            <div class="form-field" style="grid-column:1/-1"><label>用户表配置地址 configUrl（留空使用 dbs-users.js 内置配置）</label><input class="text-input" id="admDbConfigUrlUsers" placeholder="https://xxx/dbs-api.js（非必填）" value="${escapeAttr(users.configUrl || '')}" /></div>
          </div>
          <div class="form-row">
            <label class="ai-enabled-toggle"><input type="checkbox" id="admDbEnabledUsers" ${users.enabled ? 'checked' : ''} /> 启用用户表</label>
            <button class="btn" id="admDbSaveUsers">保存配置</button>
            <button class="btn-ghost btn" id="admDbTestUsers">连接测试</button>
            <button class="btn-ghost btn" id="admDbFieldsUsers">查看字段</button>
            <span class="conn-status" id="admDbConnUsers"><span class="dot"></span><span id="admDbConnUsersText">未连接</span></span>
          </div>
          <div class="cdn-links hidden" id="admDbFieldsUsersBox"></div>
        </div>
      </div>
      <div class="admin-card glass-card">
        <h3>${icons.database} 数据表后台操作</h3>
        <p class="desc">对 <b id="admDbOpTable">记录表</b> 执行查询 / 插入 / 更新 / 删除。filter 为 SQL 风格 WHERE 条件，字段值用单引号包裹。</p>
        <div class="dbs-op-grid">
          <div class="dbs-op-card">
            <div class="dbs-op-title">查询 / 行数</div>
            <div class="form-field"><label>filter（可留空=全部）</label><input class="text-input" id="admDbQFilter" placeholder="type='file_status' AND user_id='u1'" /></div>
            <div class="form-row"><label>limit</label><input class="text-input" id="admDbQLimit" style="width:90px" value="50" /></div>
            <button class="btn" id="admDbQueryBtn">查询</button>
          </div>
          <div class="dbs-op-card">
            <div class="dbs-op-title">插入记录</div>
            <div class="form-field"><label>type</label><input class="text-input" id="admDbIType" placeholder="file_status / upload_log" /></div>
            <div class="form-field"><label>user_id</label><input class="text-input" id="admDbIUid" placeholder="u1" /></div>
            <div class="form-field"><label>name</label><input class="text-input" id="admDbIName" placeholder="作品名" /></div>
            <div class="form-field"><label>status</label><input class="text-input" id="admDbIStatus" placeholder="已上传" /></div>
            <div class="form-field"><label>detail（JSON 文本）</label><input class="text-input" id="admDbIDetail" placeholder='{"type":"项目"}' /></div>
            <button class="btn" id="admDbInsertBtn">插入</button>
          </div>
          <div class="dbs-op-card">
            <div class="dbs-op-title">更新</div>
            <div class="form-field"><label>filter（必填）</label><input class="text-input" id="admDbUFilter" placeholder="id='1'" /></div>
            <div class="form-field"><label>更新数据（JSON）</label><textarea class="ai-rules-input" id="admDbUData" rows="2" placeholder='{"status":"已分享"}'></textarea></div>
            <button class="btn" id="admDbUpdateBtn">更新</button>
          </div>
          <div class="dbs-op-card">
            <div class="dbs-op-title">删除</div>
            <div class="form-field"><label>filter（必填，定位要删的行）</label><input class="text-input" id="admDbDFilter" placeholder="id='1'" /></div>
            <button class="btn-ghost btn danger" id="admDbDeleteBtn">删除匹配行</button>
          </div>
        </div>
        <div id="admDbResult" class="dbs-result hidden"></div>
      </div>
    </div>`;
}

function mailPane() {
  const cfg = getConfig();
  const mail = (cfg && cfg.mail) || {};
  return `
    <div class="admin-pane" data-pane="mail">
      <div class="admin-card glass-card">
        <h3>${icons.mail} 邮件验证码服务</h3>
        <p class="desc">验证码邮件由 Serverless 接口 /api/mail 发送（api/mail.js，可部署到 Vercel 或本地 qqmail-server）。在此填写服务根域名并启用后：注册需邮箱+验证码，个人资料页可绑定 / 换绑邮箱，登录页支持邮箱+密码登录。本地联调填 http://localhost:3000，Vercel 上线填 https://xxx.vercel.app。</p>
        <div class="form-row">
          <label class="ai-enabled-toggle"><input type="checkbox" id="admMailEnabled" ${mail.enabled ? 'checked' : ''} /> 启用邮件验证码服务</label>
        </div>
        <div class="form-grid">
          <div class="form-field" style="grid-column:1/-1"><label>邮件服务域名（/api/mail 所在根地址）</label><input class="text-input" id="admMailBase" placeholder="https://xxx.vercel.app 或 http://localhost:3000" value="${escapeAttr(mail.base || '')}" /></div>
          <div class="form-field"><label>发信测试收件邮箱（可留空）</label><input class="text-input" id="admMailTestTo" placeholder="test@qq.com" /></div>
        </div>
        <div class="form-row">
          <button class="btn" id="admMailSave">保存配置</button>
          <button class="btn-ghost btn" id="admMailTest">发信测试</button>
          <span class="conn-status" id="admMailStatus"><span class="dot"></span><span id="admMailStatusText">未测试</span></span>
        </div>
      </div>
    </div>`;
}

/* ---------- 配置读写 ---------- */
function loadAdminConfig() {
  const cfg = getConfig();
  if (!cfg) return;
  [
    ['admToken', 'token'], ['admOwner', 'owner'], ['admRepo', 'repo'], ['admBranch', 'branch'],
    ['admUsersRoot', 'usersRoot'], ['admAvatarsRoot', 'avatarsRoot'], ['admShareRoot', 'shareRoot'],
    ['admCdnFastly', 'cdnFastly'], ['admCdnGcore', 'cdnGcore'], ['admCdnRaw', 'cdnRaw'],
    ['admMailBase', 'mailBase'],
  ].forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    let v;
    if (key.startsWith('cdn')) {
      v = (cfg.cdn && cfg.cdn[key.replace('cdn', '').toLowerCase()]) || '';
    } else if (key === 'mailBase') {
      v = (cfg.mail && cfg.mail.base) || '';
    } else {
      v = cfg[key];
    }
    if (v) el.value = v;
  });
  const mailEnabledEl = document.getElementById('admMailEnabled');
  if (mailEnabledEl && cfg.mail) mailEnabledEl.checked = !!cfg.mail.enabled;
}

function collectAdminConfig() {
  const cfg = {
    token: document.getElementById('admToken').value.trim(),
    owner: document.getElementById('admOwner').value.trim(),
    repo: document.getElementById('admRepo').value.trim(),
    branch: document.getElementById('admBranch').value.trim() || 'main',
    usersRoot: document.getElementById('admUsersRoot').value.trim() || 'users',
    avatarsRoot: document.getElementById('admAvatarsRoot').value.trim() || 'avatars',
    shareRoot: document.getElementById('admShareRoot').value.trim() || 'share',
    cdn: {
      fastly: document.getElementById('admCdnFastly').value.trim(),
      gcore: document.getElementById('admCdnGcore').value.trim(),
      raw: document.getElementById('admCdnRaw').value.trim(),
    },
    ai: collectAiConfig(),
    music: collectMusicConfig(),
    db: {
      logs: {
        enabled: document.getElementById('admDbEnabledLogs').checked,
        configUrl: document.getElementById('admDbConfigUrlLogs').value.trim(),
      },
      users: {
        enabled: document.getElementById('admDbEnabledUsers').checked,
        configUrl: document.getElementById('admDbConfigUrlUsers').value.trim(),
      },
    },
    mail: {
      enabled: document.getElementById('admMailEnabled').checked,
      base: document.getElementById('admMailBase').value.trim(),
    },
  };
  return cfg;
}

function collectAiConfig() {
  const params = [...document.querySelectorAll('#admAiParams .ai-param-row')].map((row) => ({
    key: row.querySelector('.ai-param-key').value.trim(),
    value: row.querySelector('.ai-param-value').value.trim(),
  })).filter((p) => p.key);
  return {
    enabled: document.getElementById('admAiEnabled').checked,
    url: document.getElementById('admAiUrl').value.trim(),
    method: document.getElementById('admAiMethod').value || 'POST',
    path: document.getElementById('admAiPath').value.trim(),
    rules: document.getElementById('admAiRules').value.trim(),
    params,
  };
}

function collectMusicConfig() {
  const params = [...document.querySelectorAll('#admMusicParams .ai-param-row')].map((row) => ({
    key: row.querySelector('.ai-param-key').value.trim(),
    value: row.querySelector('.ai-param-value').value.trim(),
  })).filter((p) => p.key);
  const playlist = String(document.getElementById('admMusicPlaylist').value || '')
    .split(/[\n\r,，、;；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    enabled: document.getElementById('admMusicEnabled').checked,
    random: document.getElementById('admMusicRandom').checked,
    url: document.getElementById('admMusicUrl').value.trim(),
    method: document.getElementById('admMusicMethod').value || 'GET',
    path: document.getElementById('admMusicPath').value.trim(),
    params,
    playlist,
  };
}

async function testConnection() {
  const status = document.getElementById('admConnStatus');
  const text = document.getElementById('admConnText');
  const linksBox = document.getElementById('cdnLinks');
  const cfg = collectAdminConfig();
  if (!cfg.token || !cfg.owner || !cfg.repo) {
    text.textContent = '请先填写 token/owner/repo';
    return;
  }
  saveConfig(cfg);
  status.classList.remove('connected');
  text.textContent = '连接中...';
  try {
    const indexPath = buildPath(cfg.usersRoot, '_index.txt');
    const raw = await ghRead(cfg, indexPath);
    const userCount = raw == null ? 0 : Object.keys(parseIndex(raw)).length;
    status.classList.add('connected');
    text.textContent = '连接成功：' + cfg.owner + '/' + cfg.repo + '@' + cfg.branch + '，索引 ' + userCount + ' 位用户';
    renderCdnLinks(cfg, indexPath);
  } catch (e) {
    text.textContent = '连接失败：' + (e.message || '未知错误');
    linksBox.classList.add('hidden');
  }
}

/* 展示文件访问的三种链接，fastly.jsdelivr.net 为快速地址 */
function renderCdnLinks(cfg, path) {
  const box = document.getElementById('cdnLinks');
  const links = cdnUrls(cfg, path);
  const item = (name, url, fast) => `
    <div class="link-item${fast ? ' link-fastly' : ''}">
      <span class="link-name">${name}</span>
      <code>${url}</code>
      ${fast ? '<span class="fastly-badge">快速地址</span>' : ''}
    </div>`;
  box.innerHTML = `
    <div class="cdn-title">${icons.spark} 文件访问链接（示例：${path}）</div>
    ${item('fastly', links.fastly, true)}
    ${item('gcore', links.gcore, false)}
    ${item('raw', links.raw, false)}`;
  box.classList.remove('hidden');
}

/* ---------- 用户列表（users/_index.txt） ---------- */
async function refreshUsers() {
  const wrap = document.getElementById('admUsersList');
  const count = document.getElementById('admUsersCount');
  if (!wrap) return;
  showSkeleton(wrap, 4, 'sk-row');
  try {
    const cfg = requireConfig();
    const map = await readIndex(cfg);
    const users = Object.keys(map)
      .map((k) => map[k])
      .sort((a, b) => (b.registeredAt || 0) - (a.registeredAt || 0));
    count.textContent = '读取 users/_index.txt 用户索引，共 ' + users.length + ' 位用户';
    if (!users.length) {
      wrap.innerHTML = '<div class="adm-empty">仓库中暂无注册用户，可前往「个人信息」右上角头像菜单注册</div>';
      return;
    }
    wrap.innerHTML = users
      .map(
        (u) => `
        <div class="adm-user-row">
          <div class="adm-user-main">
            <span class="adm-user-id">${escapeHtml(u.id)}</span>
            <span class="adm-user-name">${escapeHtml(u.name || '')}</span>
            <span class="adm-user-folder">${escapeHtml(u.folder || '')}</span>
          </div>
          <span class="adm-user-time">${formatTime(u.registeredAt)}</span>
          <button class="um-btn" data-reset="${escapeHtml(u.id)}">重置密码</button>
        </div>`
      )
      .join('');
    wrap.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.reset;
        const npw = window.prompt('请输入「' + uid + '」的新密码（至少 6 位）：');
        if (!npw) return;
        const task = async () => {
          validatePassword(npw);
          const cfg2 = requireConfig();
          const user = await readUser(cfg2, uid);
          if (!user) throw new Error('用户数据读取失败');
          user.password = npw;
          await writeUser(cfg2, user);
          toast('用户 ' + uid + ' 密码已重置');
        };
        const run = withGhLock('reset-pw:' + uid, task);
        if (!run) {
          toast('正在处理中，请稍候…');
          return;
        }
        const restore = busyButton(btn, '重置中…');
        try {
          await run;
        } catch (e) {
          toast(e.message || '重置失败');
        } finally {
          restore();
        }
      });
    });
  } catch (e) {
    wrap.innerHTML = '<div class="adm-empty">' + ERR_MSG + '</div>';
  }
}

/* ---------- 仓库文件总览：递归遍历文件树 ---------- */
async function walkTree(cfg, dir) {
  const list = await ghRead(cfg, dir);
  if (!Array.isArray(list)) return null;
  const nodes = [];
  for (const it of list) {
    const full = buildPath(dir, it.name);
    if (it.type === 'dir') {
      const children = await walkTree(cfg, full);
      nodes.push({ name: it.name, type: 'dir', path: full, children: children || [] });
    } else {
      nodes.push({ name: it.name, type: 'file', path: full, size: it.size || 0 });
    }
  }
  nodes.sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : 1) : a.type === 'dir' ? -1 : 1));
  return nodes;
}

function treeCount(nodes) {
  let dirs = 0;
  let files = 0;
  for (const n of nodes) {
    if (n.type === 'dir') {
      dirs += 1;
      const c = treeCount(n.children || []);
      dirs += c.dirs;
      files += c.files;
    } else {
      files += 1;
    }
  }
  return { dirs, files };
}

function treeHtml(nodes, depth) {
  return '<ul class="tree-list' + (depth > 0 ? ' tree-collapsed' : '') + '">' +
    nodes
      .map((n) => {
        if (n.type === 'dir') {
          return '<li class="tree-item tree-dir" data-path="' + escapeAttr(n.path) + '">' +
            '<span class="tree-toggle">▸</span><span class="tree-icon">' + icons.folder + '</span>' +
            '<span class="tree-name">' + escapeHtml(n.name) + '</span>' +
            '<span class="tree-meta">' + (n.children ? n.children.length : 0) + ' 项</span>' +
            treeHtml(n.children || [], depth + 1) +
            '</li>';
        }
        return '<li class="tree-item tree-file"><span class="tree-toggle"></span><span class="tree-icon">' + icons.file + '</span><span class="tree-name">' + escapeHtml(n.name) + '</span></li>';
      })
      .join('') +
    '</ul>';
}

async function loadTree() {
  const root = document.getElementById('admTreeRoot');
  const meta = document.getElementById('admTreeMeta');
  if (!root) return;
  showSkeleton(root, 6, 'sk-row');
  try {
    const cfg = requireConfig();
    const nodes = await walkTree(cfg, '');
    const c = treeCount(nodes || []);
    if (meta) meta.textContent = '共 ' + c.dirs + ' 个文件夹，' + c.files + ' 个文件';
    if (!nodes || !nodes.length) {
      root.innerHTML = '<div class="adm-empty">仓库为空</div>';
      return;
    }
    root.innerHTML = treeHtml(nodes, 0);
  } catch (e) {
    root.innerHTML = '<div class="adm-empty">' + ERR_MSG + '</div>';
  }
}

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function escapeText(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------- 交互绑定 ---------- */
function bindInteractions() {
  const panes = document.getElementById('adminPanes');

  document.getElementById('admSaveBtn').addEventListener('click', () => {
    const cfg = collectAdminConfig();
    saveConfig(cfg);
    toast('配置已保存（仓库 ' + cfg.owner + '/' + cfg.repo + '）');
  });

  document.getElementById('admTestBtn').addEventListener('click', testConnection);

  document.getElementById('admRefreshUsersBtn').addEventListener('click', () => {
    if (!hasConfig()) {
      toast('请先在上方配置并保存 GitHub 仓库');
      return;
    }
    refreshUsers();
  });

  document.getElementById('admAiSaveBtn').addEventListener('click', () => {
    const cfg = collectAdminConfig();
    saveConfig(cfg);
    const ai = cfg.ai;
    toast('AI 配置已保存' + (ai.enabled ? '（AI 助手已启用）' : '（AI 助手已停用）'));
  });

  document.getElementById('admAiAddParam').addEventListener('click', () => {
    const wrap = document.getElementById('admAiParams');
    const row = document.createElement('div');
    row.className = 'ai-param-row';
    row.innerHTML = '<input class="text-input ai-param-key" placeholder="参数名（如 model）" />' +
      '<input class="text-input ai-param-value" placeholder="参数值：{{input}}=输入 / {{rules}}=守则 / {{id}}=用户ID" />' +
      '<button class="btn-mini danger ai-param-del" type="button">删除</button>';
    wrap.appendChild(row);
  });

  document.getElementById('admMusicSaveBtn').addEventListener('click', () => {
    const cfg = collectAdminConfig();
    saveConfig(cfg);
    const m = cfg.music;
    /* 保存后立即按配置渲染/移除播放器（无需刷新页面） */
    initMusicPanel();
    toast('音乐配置已保存' + (m.enabled && m.url ? '（播放器已就绪）' : '（音乐播放已停用）'));
  });

  /* 刷新卡片：强制重建播放器（播放卡死后可恢复） */
  document.getElementById('admMusicRefreshBtn').addEventListener('click', () => {
    initMusicPanel(true);
    toast('播放卡片已刷新');
  });

  document.getElementById('admMusicAddParam').addEventListener('click', () => {
    const wrap = document.getElementById('admMusicParams');
    const row = document.createElement('div');
    row.className = 'ai-param-row';
    row.innerHTML = '<input class="text-input ai-param-key" placeholder="参数名（如 id）" />' +
      '<input class="text-input ai-param-value" placeholder="参数值：{{id}}=歌曲ID" />' +
      '<button class="btn-mini danger ai-param-del" type="button">删除</button>';
    wrap.appendChild(row);
  });

  document.getElementById('admTreeLoadBtn').addEventListener('click', () => {
    if (!hasConfig()) {
      toast('请先在上方配置并保存 GitHub 仓库');
      return;
    }
    const run = withGhLock('load-tree', loadTree);
    if (!run) {
      toast('文件树加载中，请稍候…');
      return;
    }
    run.catch(() => {});
  });

  /* 点鸭数据表：顶部下拉切换表 + 双表保存/测试/字段 */
  const dbSelect = document.getElementById('admDbSelect');
  const dbTabLabel = {
    logs: ['记录表', 'admDbCfgLogs'],
    users: ['用户表', 'admDbCfgUsers'],
  };
  const dbSwitchTable = () => {
    const key = dbSelect.value;
    document.getElementById('admDbCfgLogs').classList.toggle('hidden', key !== 'logs');
    document.getElementById('admDbCfgUsers').classList.toggle('hidden', key !== 'users');
    document.getElementById('admDbOpTable').textContent = dbTabLabel[key][0];
  };
  dbSelect.addEventListener('change', dbSwitchTable);
  dbSwitchTable();

  document.getElementById('admDbSaveLogs').addEventListener('click', () => {
    const cfg = collectAdminConfig();
    saveConfig(cfg);
    toast('记录表配置已保存' + (cfg.db.logs.enabled ? '（记录表已启用）' : '（记录表已停用）'));
  });
  document.getElementById('admDbSaveUsers').addEventListener('click', () => {
    const cfg = collectAdminConfig();
    saveConfig(cfg);
    toast('用户表配置已保存' + (cfg.db.users.enabled ? '（用户表已启用）' : '（用户表已停用）'));
  });

  /* 邮件验证码服务：保存 + 发信测试 */
  document.getElementById('admMailSave').addEventListener('click', () => {
    const cfg = collectAdminConfig();
    saveConfig(cfg);
    toast('邮件验证码服务配置已保存' + (cfg.mail.enabled && cfg.mail.base ? '（已启用）' : '（未启用）'));
  });
  document.getElementById('admMailTest').addEventListener('click', async () => {
    const to = document.getElementById('admMailTestTo').value.trim();
    const statusText = document.getElementById('admMailStatusText');
    const status = document.getElementById('admMailStatus');
    if (!to) {
      statusText.textContent = '请先填写测试收件邮箱';
      return;
    }
    if (!mailEnabled()) {
      statusText.textContent = '请先填写域名并启用服务';
      return;
    }
    statusText.textContent = '发送中…';
    const r = await mailSendCode(to);
    if (r.ok) {
      status.classList.add('connected');
      statusText.textContent = '验证码已发送到 ' + to + '，请查收';
    } else {
      status.classList.remove('connected');
      statusText.textContent = '发送失败：' + (r.msg || '请检查域名配置');
    }
  });

  document.getElementById('admDbTestLogs').addEventListener('click', () => dbTestConnection('logs'));
  document.getElementById('admDbTestUsers').addEventListener('click', () => dbTestConnection('users'));
  document.getElementById('admDbFieldsLogs').addEventListener('click', () => dbLoadFields('logs'));
  document.getElementById('admDbFieldsUsers').addEventListener('click', () => dbLoadFields('users'));

  document.getElementById('admDbQueryBtn').addEventListener('click', () => dbRunOp('query'));
  document.getElementById('admDbInsertBtn').addEventListener('click', () => dbRunOp('insert'));
  document.getElementById('admDbUpdateBtn').addEventListener('click', () => dbRunOp('update'));
  document.getElementById('admDbDeleteBtn').addEventListener('click', () => dbRunOp('delete'));

  /* 文件树：点击文件夹展开 / 收起 */
  const treeRoot = document.getElementById('admTreeRoot');
  treeRoot.addEventListener('click', (e) => {
    const dir = e.target.closest('.tree-dir');
    if (!dir) return;
    dir.classList.toggle('open');
    const ul = dir.querySelector(':scope > .tree-list');
    if (ul) ul.classList.toggle('tree-collapsed', !dir.classList.contains('open'));
    const toggle = dir.querySelector(':scope > .tree-toggle');
    if (toggle) toggle.textContent = dir.classList.contains('open') ? '▾' : '▸';
  });

  panes.addEventListener('click', (e) => {
    const del = e.target.closest('.ai-param-del');
    if (del) {
      const wrap = del.closest('[id$="Params"]') || panes;
      const rows = wrap.querySelectorAll('.ai-param-row');
      if (rows.length > 1) del.closest('.ai-param-row').remove();
      else toast('至少保留一个参数行');
      return;
    }
    const btn = e.target.closest('button[data-op]');
    if (!btn) return;
    const op = btn.dataset.op;

    switch (op) {
      case 'toggle-work': {
        const i = Number(btn.dataset.i);
        const row = document.getElementById('worksTbody').querySelector(`tr[data-row="${i}"]`);
        const w = adminData.works[i];
        w.status = w.status === '已上架' ? '已下架' : '已上架';
        const badge = row.querySelector('.badge');
        badge.textContent = w.status;
        badge.className = `badge ${w.status === '已上架' ? 'ok' : 'wait'}`;
        btn.textContent = w.status === '已上架' ? '下架' : '上架';
        toast(`作品「${w.name}」已${w.status === '已上架' ? '上架' : '下架'}`);
        break;
      }
      case 'del-work': {
        const i = Number(btn.dataset.i);
        const w = adminData.works[i];
        btn.closest('tr').remove();
        toast(`已删除作品「${w.name}」`);
        break;
      }
      case 'pass-review':
      case 'reject-review': {
        const i = Number(btn.dataset.i);
        const r = adminData.reviews[i];
        btn.closest('.batch-item').remove();
        toast(op === 'pass-review' ? `题目「${r.name}」已通过审核` : `题目「${r.name}」已驳回`);
        break;
      }
      case 'select-all-batch': {
        const boxes = panes.querySelectorAll('input[data-op="select-batch"]');
        const allChecked = [...boxes].every((b) => b.checked);
        boxes.forEach((b) => (b.checked = !allChecked));
        updateBatchTip();
        break;
      }
      case 'batch-publish':
      case 'batch-move':
      case 'batch-delete': {
        const names = getSelectedBatchNames();
        if (!names.length) {
          toast('请先勾选要操作的素材');
          return;
        }
        const label = op === 'batch-publish' ? '上架' : op === 'batch-move' ? '移动' : '删除';
        toast(`已对 ${names.length} 项素材执行批量${label}`);
        break;
      }
      default:
        break;
    }
  });

  panes.addEventListener('change', (e) => {
    const input = e.target;
    if (input.dataset.op === 'select-batch') updateBatchTip();
    if (input.dataset.op === 'toggle-perm') {
      toast(`角色「${input.dataset.role}」权限已${input.checked ? '开启' : '关闭'}`);
    }
  });
}

/* 点鸭数据表后台操作处理：table = 'logs' | 'users' */
function dbSelEnabled(table) {
  return table === 'users'
    ? document.getElementById('admDbEnabledUsers').checked
    : document.getElementById('admDbEnabledLogs').checked;
}

async function dbTestConnection(table) {
  const status = document.getElementById('admDbConn' + (table === 'users' ? 'Users' : 'Logs'));
  const text = document.getElementById('admDbConn' + (table === 'users' ? 'Users' : 'Logs') + 'Text');
  if (!dbSelEnabled(table)) {
    text.textContent = '请先勾选「启用' + (table === 'users' ? '用户表' : '记录表') + '」';
    status.classList.remove('connected');
    return;
  }
  saveConfig(collectAdminConfig());
  status.classList.remove('connected');
  text.textContent = '连接中...';
  try {
    const r = await dbTest(table);
    status.classList.add('connected');
    text.textContent = '已连接（' + r.text + '）';
  } catch (e) {
    text.textContent = '连接失败：' + String((e && e.message) || e);
  }
}

async function dbLoadFields(table) {
  const box = document.getElementById('admDbFields' + (table === 'users' ? 'Users' : 'Logs') + 'Box');
  if (!dbSelEnabled(table)) {
    toast('请先勾选「启用' + (table === 'users' ? '用户表' : '记录表') + '」');
    return;
  }
  saveConfig(collectAdminConfig());
  box.classList.remove('hidden');
  box.innerHTML = '<div class="adm-empty">加载字段中…</div>';
  try {
    const fields = await dbGetFields(table);
    box.innerHTML =
      '<div class="cdn-links-title">' + icons.spark + ' ' + (table === 'users' ? '用户表' : '记录表') + '字段（' + fields.length + '）</div><div class="dbs-fields">' +
      fields.map((f) => '<span class="dbs-field">' + escapeAttr(String(f)) + '</span>').join('') +
      '</div>';
  } catch (e) {
    box.innerHTML = '<div class="adm-empty">读取字段失败：' + escapeAttr(String((e && e.message) || e)) + '</div>';
  }
}

async function dbRunOp(op) {
  const table = document.getElementById('admDbSelect').value || 'logs';
  if (!dbSelEnabled(table)) {
    toast('请先勾选「启用' + (table === 'users' ? '用户表' : '记录表') + '」');
    return;
  }
  saveConfig(collectAdminConfig());
  const res = document.getElementById('admDbResult');
  res.classList.remove('hidden');
  const el = (id) => document.getElementById(id);
  try {
    if (op === 'query') {
      const filter = el('admDbQFilter').value.trim();
      const limit = Number(el('admDbQLimit').value) || 50;
      const r = await dbQuery(filter, { limit, table });
      res.innerHTML = '<div class="dbs-result-count">' + (table === 'users' ? '用户表' : '记录表') + '：共 ' + r.count + ' 行（显示 ' + r.rows.length + ' 行）</div>' + dbsRowsTable(r.rows);
    } else if (op === 'insert') {
      const data = {
        type: el('admDbIType').value.trim(),
        user_id: el('admDbIUid').value.trim(),
        name: el('admDbIName').value.trim(),
        status: el('admDbIStatus').value.trim(),
        detail: el('admDbIDetail').value.trim(),
      };
      await dbInsert(data, table);
      res.innerHTML = '<div class="dbs-result-msg ok">插入成功</div>';
      toast('插入成功');
    } else if (op === 'update') {
      const filter = el('admDbUFilter').value.trim();
      if (!filter) {
        toast('请填写 filter');
        return;
      }
      let data = {};
      try {
        data = JSON.parse(el('admDbUData').value || '{}');
      } catch (e) {
        toast('更新数据不是合法 JSON');
        return;
      }
      await dbUpdate(filter, data, table);
      res.innerHTML = '<div class="dbs-result-msg ok">更新成功</div>';
      toast('更新成功');
    } else if (op === 'delete') {
      const filter = el('admDbDFilter').value.trim();
      if (!filter) {
        toast('请填写 filter');
        return;
      }
      if (!window.confirm('确认删除 filter=' + filter + ' 匹配的所有行？此操作不可恢复。')) return;
      await dbRemove(filter, table);
      res.innerHTML = '<div class="dbs-result-msg ok">删除成功</div>';
      toast('删除成功');
    }
  } catch (e) {
    res.innerHTML = '<div class="dbs-result-msg err">操作失败：' + escapeAttr(String((e && e.message) || e)) + '</div>';
  }
}

function dbsRowsTable(rows) {
  if (!rows || !rows.length) return '<div class="adm-empty">没有匹配的记录</div>';
  const keys = Object.keys(rows[0]);
  return (
    '<div class="dbs-table-wrap"><table class="admin-table"><thead><tr>' +
    keys.map((k) => '<th>' + escapeAttr(k) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows
      .map(
        (r) =>
          '<tr>' +
          keys
            .map((k) => '<td>' + escapeAttr(String(r[k] == null ? '' : r[k])).slice(0, 120) + '</td>')
            .join('') +
          '</tr>'
      )
      .join('') +
    '</tbody></table></div>'
  );
}

function updateBatchTip() {
  const tip = document.getElementById('batchTip');
  const count = document.querySelectorAll('input[data-op="select-batch"]:checked').length;
  if (tip) tip.textContent = `已选 ${count} 项`;
}

function getSelectedBatchNames() {
  return [...document.querySelectorAll('input[data-op="select-batch"]:checked')].map((b) => b.dataset.name);
}
