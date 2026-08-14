/* ===== admin.js ===== */







function initAdmin() {
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

/* ===== ai-panel.js ===== */
/**
 * AI 球形助手（v2）：
 *  - 收起态：小球体（44px），可自由拖拽；松手后自动判断距左/右哪侧更近，
 *    从快到慢贴向侧壁（贴壁侧圆角取消成半圆）。
 *  - 拖拽过程中始终保持圆球形态（不做正方形/长方形）。
 *  - 双击展开：球先弹向屏幕中央（保持球）→ 球体原地膨胀放大成圆 →
 *    垂直拉长展开为面板（圆角平滑过渡），全程以“球”的形式展开。
 *  - 收起：严格按打开的逆序 —— 先减小高度（面板压回圆形）→ 再缩小宽度（圆缩回球体）→ 贴壁。
 *  - 定位使用 transform: translate3d，走 GPU 合成器，不触发重排。
 */
const ORB = 44;            // 球形尺寸（略小）
const PANEL_W = 340;       // 展开面板宽
const PANEL_H = 460;       // 展开面板高
const TOP = 76;            // 顶部留白（导航栏下方）
const MARGIN = 14;         // 侧边 / 底部留白

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);





/* 会话内首次请求才注入 AI 守则；「新对话」按钮会重置 */
let aiSessionStarted = false;

function initAiPanel() {
  const orb = document.getElementById('aiOrb');
  const fab = document.getElementById('aiOrbFab');
  const head = document.getElementById('aiPanelHead');
  const toggleBtn = document.getElementById('aiToggleBtn');
  const newChatBtn = document.getElementById('aiNewChatBtn');
  const input = document.getElementById('aiInput');
  const sendBtn = document.getElementById('aiSendBtn');
  const chat = document.getElementById('aiChat');
  if (!orb || !fab || !head || !chat) return;

  initWelcome(chat);

  /* ---------- 状态 ---------- */
  const state = {
    x: 0,
    y: 0,
    w: ORB,
    h: ORB,
    dockedSide: 'right',
    expanded: false,
    dragging: false,
    moved: false,
    animating: false,
  };
  let animId = 0;
  let dragStart = null;
  let taps = 0;
  let tapTimer = null;

  const setPos = (x, y) => {
    state.x = x;
    state.y = y;
    orb.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  };
  const setSize = (w, h) => {
    state.w = w;
    state.h = h;
    orb.style.width = w + 'px';
    orb.style.height = h + 'px';
  };

  const applyShape = () => {
    orb.classList.toggle('docked-right', !state.expanded && state.dockedSide === 'right');
    orb.classList.toggle('docked-left', !state.expanded && state.dockedSide === 'left');
  };

  /* ---------- 动画（rAF，x/y/w/h 同步过渡，从快到慢） ---------- */
  function animate(to, dur, ease, onDone) {
    cancelAnimationFrame(animId);
    const from = { x: state.x, y: state.y, w: state.w, h: state.h };
    state.animating = true;
    const t0 = performance.now();
    const step = (now) => {
      let t = (now - t0) / dur;
      if (t >= 1) t = 1;
      const e = ease ? ease(t) : t;
      setPos(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      setSize(from.w + (to.w - from.w) * e, from.h + (to.h - from.h) * e);
      if (t < 1) {
        animId = requestAnimationFrame(step);
      } else {
        state.animating = false;
        if (onDone) onDone();
      }
    };
    animId = requestAnimationFrame(step);
  }

  /* 松手贴边：判断距左/右哪侧近，从快到慢靠岸，贴壁侧变半圆 */
  function dock() {
    const side = state.x + ORB / 2 < window.innerWidth / 2 ? 'left' : 'right';
    const tx = side === 'right' ? window.innerWidth - ORB : 0;
    const ty = clamp(state.y, TOP, window.innerHeight - ORB - MARGIN);
    animate({ x: tx, y: ty, w: ORB, h: ORB }, 540, easeOutExpo, () => {
      state.dockedSide = side;
      applyShape();
    });
  }

  /* 展开面板拖拽后吸附回可视区域 */
  function snapIntoView() {
    const nx = clamp(state.x, MARGIN, window.innerWidth - state.w - MARGIN);
    const ny = clamp(state.y, TOP, window.innerHeight - state.h - MARGIN);
    if (nx !== state.x || ny !== state.y) {
      animate({ x: nx, y: ny, w: state.w, h: state.h }, 240, easeOutCubic);
    }
  }

  /* 展开：弹向中央(球) → 球体膨胀成圆 → 垂直拉长成面板 */
  function expand() {
    if (state.expanded || state.animating) return;
    state.expanded = true;
    orb.classList.add('expanding');

    const cx = (window.innerWidth - ORB) / 2;
    const cy = clamp(state.y, TOP, window.innerHeight - PANEL_H - MARGIN);
    let lx = cx;
    if (lx + PANEL_W > window.innerWidth - MARGIN) lx = window.innerWidth - PANEL_W - MARGIN;
    if (lx < MARGIN) lx = MARGIN;
    const top = clamp(state.y, TOP, window.innerHeight - PANEL_H - MARGIN);
    /* 面板中心：拉长阶段保持圆心与面板中心一致 */
    const pcx = lx + PANEL_W / 2;
    const pcy = top + PANEL_H / 2;
    /* 膨胀圆直径上限：不超过可视高度 */
    const growR = Math.min(PANEL_W, window.innerHeight - TOP - MARGIN * 2);

    /* 阶段1：球弹向中央（保持球体） */
    animate({ x: cx, y: cy, w: ORB, h: ORB }, 420, easeOutExpo, () => {
      /* 阶段2：球体膨胀成圆（w=h=growR，圆心与面板中心对齐，保持圆形） */
      const rx = pcx - growR / 2;
      const ry = pcy - growR / 2;
      animate({ x: rx, y: ry, w: growR, h: growR }, 380, easeOutCubic, () => {
        /* 阶段3：垂直拉长成面板（中心不变，圆角平滑过渡） */
        orb.classList.add('expanded');
        applyShape();
        animate({ x: lx, y: top, w: PANEL_W, h: PANEL_H }, 420, easeOutCubic, () => {
          orb.classList.remove('expanding');
        });
      });
    });
  }

  /* 收起：按打开逆序 —— 先减高度（压回圆）→ 再减宽度（缩回球）→ 贴壁 */
  function collapse() {
    if (!state.expanded || state.animating) return;
    state.expanded = false;
    orb.classList.remove('expanded');
    applyShape();

    const pcx = state.x + state.w / 2;
    const pcy = state.y + state.h / 2;

    /* 阶段1：高度减小 → 压成圆（w 保持 PANEL_W，h 回到 PANEL_W，圆心保持） */
    animate({ x: pcx - PANEL_W / 2, y: pcy - PANEL_W / 2, w: PANEL_W, h: PANEL_W }, 320, easeOutCubic, () => {
      /* 阶段2：宽度减小 → 缩回球体（圆心保持） */
      animate({ x: pcx - ORB / 2, y: pcy - ORB / 2, w: ORB, h: ORB }, 340, easeOutCubic, () => {
        /* 阶段3：贴回侧壁 */
        dock();
      });
    });
  }

  /* ---------- 拖拽 ---------- */
  const canStart = (target) =>
    state.expanded ? !!target.closest('#aiPanelHead') : !!target.closest('#aiOrbFab');

  fab.addEventListener('pointerdown', (e) => {
    if (!canStart(e.target)) return;
    onPointerDown(e);
  });
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.ai-head-actions')) return;
    if (!canStart(e.target)) return;
    onPointerDown(e);
  });

  function onPointerDown(e) {
    if (state.animating) return;
    if (e.pointerType !== 'mouse' && e.button) return;
    e.preventDefault();
    state.dragging = true;
    state.moved = false;
    dragStart = { px: e.clientX, py: e.clientY, ox: state.x, oy: state.y };
    orb.classList.add('dragging');
    /* 拖动中始终保持球体（移除贴壁半圆） */
    orb.classList.remove('docked-right', 'docked-left');
    try {
      orb.setPointerCapture(e.pointerId);
    } catch (err) {}
  }

  function onPointerMove(e) {
    if (!state.dragging) return;
    const dx = e.clientX - dragStart.px;
    const dy = e.clientY - dragStart.py;
    if (!state.moved && Math.hypot(dx, dy) > 4) state.moved = true;
    let nx = dragStart.ox + dx;
    let ny = dragStart.oy + dy;
    if (state.expanded) {
      nx = clamp(nx, MARGIN, window.innerWidth - state.w - MARGIN);
      ny = clamp(ny, TOP, window.innerHeight - state.h - MARGIN);
    } else {
      nx = clamp(nx, 0, window.innerWidth - state.w);
      ny = clamp(ny, TOP, window.innerHeight - state.h - MARGIN);
    }
    setPos(nx, ny);
  }

  function onPointerUp() {
    if (!state.dragging) return;
    state.dragging = false;
    orb.classList.remove('dragging');
    if (state.moved) {
      if (state.expanded) snapIntoView();
      else dock();
    } else {
      handleTap();
    }
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  /* 双击（或触摸连点）识别 */
  function handleTap() {
    taps += 1;
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      taps = 0;
    }, 280);
    if (taps === 2) {
      taps = 0;
      clearTimeout(tapTimer);
      if (state.expanded) collapse();
      else expand();
    }
  }

  /* 收起按钮 */
  toggleBtn.addEventListener('click', () => {
    if (state.expanded) collapse();
  });

  /* 窗口尺寸变化时防止跑出屏幕 */
  window.addEventListener('resize', () => {
    if (state.expanded) {
      snapIntoView();
    } else {
      const nx = clamp(state.x, 0, window.innerWidth - ORB);
      const ny = clamp(state.y, TOP, window.innerHeight - ORB - MARGIN);
      if (nx !== state.x || ny !== state.y) setPos(nx, ny);
      dock();
    }
  });

  /* ---------- 聊天 ---------- */
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    appendMsg(chat, text, 'user');
    input.value = '';
    const ai = getAiConfig();
    if (ai && ai.enabled && ai.url) {
      sendToApi(chat, ai, text);
    } else {
      setTimeout(() => appendMsg(chat, replyFor(text), 'ai'), 600);
    }
  };
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });

  /* 新对话：清空聊天、重置会话（下次请求重新注入守则） */
  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      aiSessionStarted = false;
      chat.innerHTML = '';
      initWelcome(chat);
      toast('已开启新对话');
    });
  }

  /* 初始化形态 */
  state.x = window.innerWidth - ORB;
  state.y = window.innerHeight - ORB - 96;
  setSize(ORB, ORB);
  setPos(state.x, state.y);
  applyShape();
}

function initWelcome(chat) {
  appendMsg(chat, '你好，我是 AI 助手，可以帮你生成函数或解析数学题目。', 'ai');
}

function appendMsg(chat, text, who) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function replyFor(text) {
  if (/函数|y\s*=|f\(x\)|sin|cos|tan|抛物线|直线|二次/.test(text)) {
    return '已收到函数生成指令：将为你绘制对应函数图像（演示环境，绘制结果将在主页面呈现）。';
  }
  if (/题目|解析|求解|方程|不等式|三角/.test(text)) {
    return '正在解析题目：已提取题干关键信息并生成分步解答（演示环境）。';
  }
  return '已收到指令，我会按「分步执行」流程处理（演示环境）。';
}

function getAiConfig() {
  try {
    const cfg = getConfig();
    return (cfg && cfg.ai) || null;
  } catch (e) {
    return null;
  }
}

/* 按配置真实请求 AI 接口：
 *  - 参数值支持 {{input}}（用户输入）、{{rules}}（守则，仅会话首次注入）、{{id}}（当前用户 ID）
 *  - 无 {{input}} 参数时自动补一个 input 参数
 *  - 无 {{rules}} 参数且守则非空时，守则拼接在用户输入内容前（仅首次）
 *  - GET：参数拼 URL query；POST：参数放 JSON body
 *  - 回复按点分路径提取（如 mag.answer），路径留空取响应根
 */
async function sendToApi(chat, ai, text) {
  const first = !aiSessionStarted;
  aiSessionStarted = true;
  const rules = first ? String(ai.rules || '') : '';
  const userId = (getCurrentUser() && getCurrentUser().id) || '';
  const rawParams = (ai.params || []).filter((p) => p.key).map((p) => ({ key: p.key, value: String(p.value || '') }));

  let message = text;
  const hasRulesParam = rawParams.some((p) => /\{\{rules\}\}/.test(p.value));
  if (first && rules && !hasRulesParam) message = rules + '\n' + text;

  const hasInputParam = rawParams.some((p) => /\{\{input\}\}/.test(p.value));
  const params = rawParams.map((p) => ({
    key: p.key,
    value: p.value.replace(/\{\{input\}\}/g, message).replace(/\{\{rules\}\}/g, rules).replace(/\{\{id\}\}/g, userId),
  }));
  if (!hasInputParam) params.push({ key: 'input', value: message });

  const method = ai.method === 'GET' ? 'GET' : 'POST';
  let url = ai.url;
  if (method === 'GET') {
    const qs = params.map((p) => encodeURIComponent(p.key) + '=' + encodeURIComponent(p.value)).join('&');
    if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
  }
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (method === 'POST') {
    const body = {};
    params.forEach((p) => {
      body[p.key] = p.value;
    });
    opts.body = JSON.stringify(body);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let textBody = '';
    try {
      textBody = await res.text();
    } catch (e) {}
    let data;
    try {
      data = JSON.parse(textBody);
    } catch (e) {
      data = textBody;
    }
    const answer = extractPath(data, ai.path);
    if (answer == null || String(answer).trim() === '') {
      throw new Error('未在响应中找到路径「' + (ai.path || '根') + '」');
    }
    appendMsg(chat, String(answer), 'ai');
  } catch (e) {
    const reason = e.name === 'AbortError' ? '请求超时（30s）' : e.message || '未知错误';
    appendMsg(chat, 'AI 请求失败：' + reason, 'ai');
  } finally {
    clearTimeout(timer);
  }
}

function extractPath(data, path) {
  if (!path) return data;
  const keys = String(path).split('.').filter(Boolean);
  let cur = data;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[k];
  }
  return cur;
}

/* ===== auth-ui.js ===== */
/**
 * 登录 / 注册 / 快速登录 UI
 * 快速登录：从 users/_index.txt 拉取用户索引，选择后自动定位用户 ID
 */





let authSuccessHandler = null;

function setAuthSuccessHandler(fn) {
  authSuccessHandler = fn;
}

function openAuthModal() {
  const overlay = document.getElementById('authOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  /* 每次打开重置输入框，避免残留上次登录/注册内容导致数据泄露 */
  document.getElementById('authUserId').value = '';
  document.getElementById('authName').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authMsg').textContent = '';
  document.getElementById('authUserSelect').innerHTML = '<option value="">— 加载中 —</option>';
  setTab('login');
  loadIndexUsers();
  if (!hasConfig()) {
    document.getElementById('authRepoHint').textContent = '未配置 GitHub 仓库：请在 管理者设置 - 对接GitHub知识点仓库 中填写 token/owner/repo 后再登录';
  } else {
    document.getElementById('authRepoHint').textContent = '';
  }
}

function closeAuthModal() {
  const overlay = document.getElementById('authOverlay');
  if (overlay) overlay.classList.remove('show');
}

function initAuthUI() {
  const overlay = document.getElementById('authOverlay');
  if (!overlay) return;

  document.getElementById('authCloseBtn').addEventListener('click', closeAuthModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeAuthModal();
  });

  /* 登录 / 注册 切换 */
  document.querySelectorAll('.auth-tab[data-auth-tab]').forEach((tab) => {
    tab.addEventListener('click', () => setTab(tab.dataset.authTab));
  });

  /* 用户索引快速定位 */
  document.getElementById('authUserSelect').addEventListener('change', (e) => {
    if (e.target.value) {
      document.getElementById('authUserId').value = e.target.value;
    }
  });

  /* 提交 */
  document.getElementById('authSubmitBtn').addEventListener('click', async () => {
    await submit();
  });
  const pw = document.getElementById('authPassword');
  pw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  /* 注册：获取邮箱验证码（60s 节流） */
  const codeBtn = document.getElementById('authCodeBtn');
  if (codeBtn) {
    codeBtn.addEventListener('click', sendAuthCode);
    document.getElementById('authCode').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  }
}

function setCountdown(btn, seconds, doneText) {
  const orig = btn.dataset.origText || btn.textContent;
  btn.dataset.origText = orig;
  btn.disabled = true;
  let left = seconds;
  const timer = setInterval(() => {
    left -= 1;
    btn.textContent = left + 's 后重试';
    if (left <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = orig;
    }
  }, 1000);
  return () => {
    clearInterval(timer);
    btn.disabled = false;
    btn.textContent = orig;
  };
}

async function sendAuthCode() {
  const msg = document.getElementById('authMsg');
  msg.textContent = '';
  let email;
  try {
    email = validateEmail(document.getElementById('authEmail').value);
  } catch (e) {
    msg.textContent = e.message;
    return;
  }
  if (!mailEnabled()) {
    msg.textContent = '邮件验证码服务未配置：请先在 管理者设置 - 邮件验证码服务 中填写域名';
    return;
  }
  try {
    const dup = await findUserByEmail(email);
    if (dup) {
      msg.textContent = '该邮箱已被绑定，可直接用邮箱登录';
      return;
    }
  } catch (e) {}
  const btn = document.getElementById('authCodeBtn');
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

function setTab(name) {
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.authTab === name));
  /* 注册模式下隐藏登录专属选项（用户索引快速登录 / 2 天免登录） */
  document.querySelectorAll('.register-only').forEach((el) => el.classList.toggle('hidden', name !== 'register'));
  document.querySelectorAll('.login-only').forEach((el) => el.classList.toggle('hidden', name !== 'login'));
  document.getElementById('authSubmitBtn').textContent = name === 'login' ? '登录' : '注册';
}

async function loadIndexUsers() {
  const select = document.getElementById('authUserSelect');
  select.innerHTML = '<option value="">— 从 _index.txt 选择用户（快速登录） —</option>';
  if (!hasConfig()) return;
  try {
    const cfg = requireConfig();
    const map = await readIndex(cfg);
    const ids = Object.keys(map).sort((a, b) => (map[b].registeredAt || 0) - (map[a].registeredAt || 0));
    ids.forEach((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = map[id].name ? id + '（' + map[id].name + '）' : id;
      select.appendChild(opt);
    });
    if (!ids.length) {
      select.innerHTML = '<option value="">索引为空：暂无注册用户，请切换「注册」创建</option>';
    }
  } catch (e) {
    select.innerHTML = '<option value="">读取用户索引失败：' + e.message + '</option>';
  }
}

async function submit() {
  const msg = document.getElementById('authMsg');
  const btn = document.getElementById('authSubmitBtn');
  const remember = document.getElementById('authRemember').checked;
  msg.textContent = '';
  const task = async () => {
    const activeTab = document.querySelector('.auth-tab.active').dataset.authTab;
    btn.disabled = true;
    btn.textContent = '处理中...';
    let result;
    if (activeTab === 'register') {
      result = await register(
        document.getElementById('authName').value,
        document.getElementById('authPassword').value,
        remember,
        document.getElementById('authEmail').value,
        document.getElementById('authCode').value
      );
      toast('注册成功！您的用户 ID：' + result.userId + '（请妥善保存，登录时使用）');
    } else {
      result = await login(
        document.getElementById('authUserId').value,
        document.getElementById('authPassword').value,
        remember
      );
    }
    closeAuthModal();
    if (authSuccessHandler) authSuccessHandler(result.user);
  };
  const run = withGhLock('auth-submit', task);
  if (!run) {
    msg.textContent = '正在处理中，请稍候…';
    return;
  }
  btn.disabled = true;
  btn.textContent = '处理中...';
  try {
    await run;
  } catch (e) {
    msg.textContent = e.message || '操作失败';
  } finally {
    btn.disabled = false;
    btn.textContent = document.querySelector('.auth-tab.active').dataset.authTab === 'login' ? '登录' : '注册';
  }
}

/* ===== avatar.js ===== */
/**
 * 头像渲染：优先 fastly.jsdelivr.net 快速地址，加载失败回退
 * raw.githubusercontent.com，最终统一回退文字「学」。
 * 图片 URL 命中缓存时立即显示，保证顶栏 / 个人信息 / 个人资料三处同步。
 */


const FALLBACK_TEXT = '学';
const imgCache = {};

function renderAvatar(holderId, imgId, user, fallbackLetter) {
  const holder = document.getElementById(holderId);
  const img = document.getElementById(imgId);
  if (!holder || !img) return;
  let letter = holder.querySelector('.avatar-letter');
  if (!letter) {
    letter = document.createElement('span');
    letter.className = 'avatar-letter';
    holder.appendChild(letter);
  }

  const showLetter = () => {
    img.classList.add('hidden');
    letter.classList.remove('hidden');
    letter.textContent = FALLBACK_TEXT;
  };

  const path = user && user.avatar;
  if (path) {
    let candidates = [];
    try {
      const cfg = requireConfig();
      candidates = [fileUrl(cfg, path), rawUrl(cfg, path)];
    } catch (e) {
      candidates = [];
    }
    if (candidates.length) {
      if (imgCache[candidates[0]]) {
        img.src = candidates[0];
        img.classList.remove('hidden');
        letter.classList.add('hidden');
        return;
      }
      let i = 0;
      const tryLoad = () => {
        img.onload = () => {
          imgCache[candidates[0]] = true;
          img.classList.remove('hidden');
          letter.classList.add('hidden');
        };
        img.onerror = () => {
          i += 1;
          if (i < candidates.length) {
            img.src = candidates[i];
          } else {
            showLetter();
          }
        };
        img.src = candidates[i];
      };
      tryLoad();
      return;
    }
  }
  showLetter();
}

/* ===== data.js ===== */
/* 图标库：统一内联 SVG，分块维护时共用 */
const icons = {
  upload:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>',
  plus:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
  book:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>',
  file:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>',
  grid:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>',
  arrowDown:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>',
  github:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>',
  users:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
  image:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
  shield:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
  spark:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"></path></svg>',
  ai:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="2"></rect><path d="M12 8V4"></path><circle cx="12" cy="3" r="1"></circle><path d="M9 13h.01"></path><path d="M15 13h.01"></path><path d="M9.5 16.5h5"></path></svg>',
  tree:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>',
  music:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>',
  database:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>',
  mail:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><polyline points="22,6 12,13 2,6"></polyline></svg>',
};

/* 顶部个人总览统计块：数据由 js/user.js 按仓库实时计算，此处不再硬编码 */
const STAT_BLOCKS = [
  { key: 'cloudProjects', label: '云端项目' },
  { key: 'uploadedQuestions', label: '上传题目' },
  { key: 'knowledgePoints', label: '知识点' },
  { key: 'mistakes', label: '错题' },
  { key: 'sharedWorks', label: '公开作品' },
];

/* 2x2 功能网格卡片 */
const funcItems = [
  {
    icon: icons.upload,
    title: '上传数学题目',
    desc: '上传题目并自动生成解析',
    page: 'upload',
  },
  {
    icon: icons.folder,
    title: '我的项目',
    desc: '洗牌卡片切换，管理云端项目',
    page: 'projects',
  },
  {
    icon: icons.book,
    title: '我的知识库',
    desc: '沉淀你的知识点与笔记',
    page: 'knowledge',
  },
  {
    icon: icons.grid,
    title: '公共作品广场',
    desc: '浏览他人公开的函数作品',
    page: 'gallery',
  },
];

/* 顶部加号新建下拉菜单 */
const newMenuItems = [
  { label: '上传数学题目', page: 'upload' },
  { label: '新建知识点', page: 'knowledge' },
  { label: '新建项目', page: 'projects' },
];

/* 通用占位页（我的知识库/上传题目/错题库） */
const placeholderPages = {
  content: { icon: icons.file, title: '我的内容', desc: '这里将展示你的绘图文件与知识点内容' },
  knowledge: { icon: icons.book, title: '我的知识库', desc: '这里是你的知识点与笔记的沉淀仓库' },
  upload: { icon: icons.upload, title: '上传题目', desc: '上传数学题目后，可在此查看解析与状态' },
  mistakes: { icon: icons.image, title: '错题库', desc: '错题将自动归档到这里，方便复习' },
};

/* 公开作品广场：作品分类（与项目编辑信息中的分类选项一致） */
const GAL_CATEGORIES = ['一次函数', '二次函数', '反比例函数', '动画', '旋转', '全部'];

/* 管理者设置：功能标签 */
const adminTabs = [
  { key: 'github', label: '对接GitHub知识点仓库', icon: icons.github },
  { key: 'ai', label: 'AI 助手配置', icon: icons.ai },
  { key: 'music', label: '音乐播放配置', icon: icons.music },
  { key: 'tree', label: '仓库文件总览', icon: icons.tree },
  { key: 'users', label: '查看全部用户数据', icon: icons.users },
  { key: 'works', label: '管理公开作品', icon: icons.image },
  { key: 'review', label: '审核用户上传题目', icon: icons.file },
  { key: 'perms', label: '权限管控', icon: icons.shield },
  { key: 'batch', label: '批量操作素材', icon: icons.folder },
  { key: 'dbs', label: '点鸭数据表', icon: icons.database },
  { key: 'mail', label: '邮件验证码服务', icon: icons.mail },
];

/* 管理者设置：示例数据 */
const adminData = {
  works: [
    { name: '正弦函数波动演示', author: '代数小能手', status: '已上架' },
    { name: '抛物线家族', author: '数学学习者', status: '已上架' },
    { name: '分形树的秘密', author: '几何爱好者', status: '待审核' },
    { name: '极坐标玫瑰线', author: '函数玩家', status: '已下架' },
  ],
  reviews: [
    { name: '二次函数顶点式求值', author: '代数小能手', time: '2026-08-05 14:20' },
    { name: '三角函数图像平移', author: '几何爱好者', time: '2026-08-06 09:41' },
    { name: '导数与切线斜率', author: '函数玩家', time: '2026-08-06 16:03' },
  ],
  perms: [
    { role: '管理员', desc: '拥有全部管理权限', on: true },
    { role: '高级用户', desc: '可上传题目并管理公开作品', on: true },
    { role: '普通用户', desc: '可浏览与创作', on: true },
    { role: '游客', desc: '仅可浏览公开内容', on: false },
  ],
  batches: [
    { name: '三角函数图像素材', meta: '32 个 · 5.8MB' },
    { name: '导数专题题目包', meta: '18 个 · 2.1MB' },
    { name: '空间几何三维模型', meta: '12 个 · 8.4MB' },
  ],
};

/* ===== dbstable.js ===== */
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


const DB_TABLES = {
  LOGS: 'logs',
  USERS: 'users',
};

/* 记录类型（logs 表） */
const DB_TYPES = {
  FILE_STATUS: 'file_status',
  UPLOAD_LOG: 'upload_log',
};

/* 兼容旧结构 cfg.db={enabled,configUrl} → 迁移为 cfg.db={logs,users} */
function normalizeDbCfg(cfg) {
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
function dbEnabled(table) {
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
function getDb(table) {
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

function resetDb() {
  Object.keys(dbCache).forEach((k) => delete dbCache[k]);
}

/* 连接测试：返回 { ok, text } */
async function dbTest(table) {
  const db = await getDb(table);
  const info = await db.info();
  const text = ['uid=' + info.uid, 'nickname=' + info.nickname, 'tablen=' + info.tablen]
    .filter((x) => x.indexOf('undefined') < 0)
    .join(' / ');
  return { ok: true, text: text || '连接成功' };
}

/* 查询表字段：返回字段名数组 */
async function dbGetFields(table) {
  const db = await getDb(table);
  const json = await db.getFields();
  if (!json || json.code !== 200) throw new Error((json && json.msg) || '读取字段失败');
  const fields = json.all || [];
  return Array.isArray(fields) ? fields : Object.keys(fields);
}

/* 通用查询：返回 { rows, count }；filter 为 SQL 风格 WHERE（如 type='file_status'） */
async function dbQuery(filter, opts) {
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
async function dbInsert(data, table) {
  const db = await getDb(table || DB_TABLES.LOGS);
  const json = await db.insert(data || {});
  if (!json || json.code !== 200) throw new Error((json && json.msg) || '插入失败');
  return json;
}

/* 更新记录：filter 定位行，data 为待更新字段 */
async function dbUpdate(filter, data, table) {
  const db = await getDb(table || DB_TABLES.LOGS);
  const json = await db.update(filter, data || {});
  if (!json || json.code !== 200) throw new Error((json && json.msg) || '更新失败');
  return json;
}

/* 删除记录：filter 定位行（危险操作，调用方需确认） */
async function dbRemove(filter, table) {
  const db = await getDb(table || DB_TABLES.LOGS);
  const json = await db.remove(filter);
  if (!json || json.code !== 200) throw new Error((json && json.msg) || '删除失败');
  return json;
}

function escVal(v) {
  return String(v == null ? '' : v).replace(/'/g, "''");
}

/* 追加一条日志类记录（尽力而为：失败静默，不打断主流程；GitHub 为权威存储） */
async function dbAppendLog(type, userId, name, status, detail) {
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
async function dbQueryLogs(type, userId, limit) {
  const r = await dbQuery(
    "type='" + escVal(type) + "' AND user_id='" + escVal(userId) + "'",
    { sort: 'createdAt DESC', limit: limit || 200, table: DB_TABLES.LOGS }
  );
  return r.rows;
}

/* ===== dbusers.js ===== */
/**
 * 点鸭用户表适配层：把 GitHub 用户数据（info.json）渐进式同步到用户表（users），
 * 与 GitHub 共存双写、读取优先数据表。用户表字段：id / user_id / name / email / role /
 * avatar / stats / whitelist / devices / ip（点鸭主键 id 不写入，GitHub 用户 ID 存
 * user_id 字段；email 存绑定邮箱，供邮箱登录与唯一性检查读优先查询）。
 */


function dbUserEnabled() {
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
async function dbUserSync(user) {
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
async function dbUserGet(userId) {
  if (!dbUserEnabled()) return null;
  const db = await getDb(DB_TABLES.USERS);
  const json = await db.query({ filter: "user_id='" + escQ(userId) + "'", page: 1, limit: 1 });
  if (json && json.code === 200 && json.fields && json.fields.length) return json.fields[0];
  return null;
}

/* 用户表按邮箱查询：返回行（含 user_id），无则 null */
async function dbUserFindByEmail(email) {
  if (!dbUserEnabled() || !email) return null;
  const db = await getDb(DB_TABLES.USERS);
  const json = await db.query({ filter: "email='" + escQ(String(email).toLowerCase()) + "'", page: 1, limit: 1 });
  if (json && json.code === 200 && json.fields && json.fields.length) return json.fields[0];
  return null;
}

/* ===== devices.js ===== */
/**
 * 登录设备记录页：
 *  - 卡片宽度撑满界面区域 70%（devices-shell 宽 70%）
 *  - 虚拟滚动懒加载：只渲染可视区域 + 前后缓存窗口，向下滑实时渲染新卡片并带翻折动画
 *  - 滚动阻尼回弹：顶部/底部过冲后自动归位（transform 合成器，不触发重排）
 *  - 底部文字提示「=^.^= 已经到底啦～ =^.^=」，跟随回弹区域移动
 *  - 兼容鼠标滚轮 / 手机触摸 / 鼠标左键按住拖动（拖动时禁止选中文本）
 *  - 右侧纵向滑动条
 */





const DVC_CARD_H = 76;      // 卡片高度
const DVC_GAP = 10;         // 卡片间距（不宜过宽）
const DVC_CACHE = 3;        // 可视区外缓存项数
const DVC_STAGGER = 100;    // 卡片翻折动画间隔 ms
const DVC_END_H = 40;       // 底部提示预留高度

const dvcClamp = (v, min, max) => Math.min(Math.max(v, min), max);

let dvcList = [];
let dvcPos = 0;
let dvcMax = 0;
let dvcH = 480;
let dvcVel = 0;
let dvcTicking = false;
let dvcRendered = new Map();   // index -> element
let dvcWin = { first: -1, last: -1 };

let scrollEl = null;
let listEl = null;
let endEl = null;
let barEl = null;
let thumbEl = null;

let pDrag = null;              // 鼠标拖动
let tStart = null;             // 触摸
let tLast = null;              // 触摸速度采样

function initDevices() {
  scrollEl = document.getElementById('devicesScroll');
  if (!scrollEl) return;
  listEl = document.getElementById('devicesList');
  endEl = document.getElementById('devicesEnd');
  barEl = document.getElementById('devicesScrollbar');
  thumbEl = document.getElementById('devicesThumb');

  document.getElementById('devicesBackBtn').addEventListener('click', () => switchPage('profileSettings'));

  /* 鼠标滚轮 */
  scrollEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    dvcVel = 0;
    dvcPos += e.deltaY;
    startTicker();
  }, { passive: false });

  /* 手机触摸滑动 */
  scrollEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    dvcVel = 0;
    tStart = { y: e.touches[0].clientY, pos: dvcPos };
    tLast = { y: e.touches[0].clientY, t: performance.now() };
  }, { passive: false });
  scrollEl.addEventListener('touchmove', (e) => {
    if (!tStart) return;
    e.preventDefault();
    const y = e.touches[0].clientY;
    const now = performance.now();
    const dt = Math.max(1, now - tLast.t);
    tLast = { y, t: now };
    dvcVel = ((tLast.y - tStart.y - (dvcPos - tStart.pos)) / dt) * 0.0003;
    dvcPos = tStart.pos - (y - tStart.y);
    startTicker();
  }, { passive: false });
  scrollEl.addEventListener('touchend', () => {
    if (!tStart) return;
    tStart = null;
  }, { passive: false });

  /* 鼠标左键按住拖动（阻止选中文本） */
  scrollEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target.closest('button')) return;
    e.preventDefault();
    dvcVel = 0;
    pDrag = { y: e.clientY, pos: dvcPos, t: performance.now() };
  });
  window.addEventListener('pointermove', (e) => {
    if (!pDrag || e.pointerType !== 'mouse') return;
    const now = performance.now();
    const dt = Math.max(1, now - pDrag.t);
    pDrag.t = now;
    dvcVel = ((e.clientY - pDrag.y - (dvcPos - pDrag.pos)) / dt) * 0.0003;
    dvcPos = pDrag.pos - (e.clientY - pDrag.y);
    startTicker();
  });
  window.addEventListener('pointerup', () => {
    pDrag = null;
  });

  /* 右侧滚动条拖动 */
  initScrollbar();
}

/* 打开设备记录页：读取当前用户设备历史，进入页面并初始化滚动 */
function openDevicesPage() {
  const user = getCurrentUser();
  if (!user) {
    toast('请先登录');
    openAuthModal();
    return;
  }
  dvcList = (user.devices || []).map((d) => ({
    ip: String(d.ip || '未知IP'),
    ua: String(d.ua || ''),
    time: Number(d.time) || 0,
    action: String(d.action || 'login'),
  }));
  switchPage('devices');
  resetDevices();
}

/* 测试 / 调试钩子：直接滚动到指定偏移（像素） */
function devicesScrollTo(pos) {
  if (!scrollEl) return;
  dvcPos = dvcClamp(pos, -320, dvcMax + 320);
  startTicker();
}

function resetDevices() {
  dvcPos = 0;
  dvcVel = 0;
  dvcRendered.clear();
  dvcWin = { first: -1, last: -1 };
  listEl.innerHTML = '';
  const sh = scrollEl.clientHeight || Math.max(300, window.innerHeight * 0.6);
  dvcH = sh;
  const step = DVC_CARD_H + DVC_GAP;
  const total = dvcList.length ? dvcList.length * step - DVC_GAP + DVC_END_H : 0;
  listEl.style.height = total + 'px';
  endEl.style.top = (dvcList.length ? dvcList.length * step - DVC_GAP + 6 : 0) + 'px';
  dvcMax = Math.max(0, total - dvcH);
  startTicker();
}

/* rAF 主循环：惯性 + 阻尼回弹 + 渲染窗口 + 滚动条 */
function startTicker() {
  if (dvcTicking) return;
  dvcTicking = true;
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.max(0, Math.min(32, now - last));
    last = now;
    if (dvcVel) {
      dvcPos += dvcVel * dt;
      dvcVel *= Math.pow(0.001, dt / 1000);
      if (Math.abs(dvcVel) < 0.02) dvcVel = 0;
    }
    if (dvcPos < 0 || dvcPos > dvcMax) {
      const t = dvcClamp(dvcPos, 0, dvcMax);
      dvcPos += (t - dvcPos) * Math.min(1, 0.16 * (dt / 16));
      if (Math.abs(t - dvcPos) < 0.4) dvcPos = t;
    }
    applyTransform();
    renderWindow();
    updateScrollbar();
    if (dvcVel || dvcPos < 0 || dvcPos > dvcMax) {
      requestAnimationFrame(tick);
    } else {
      dvcTicking = false;
    }
  };
  requestAnimationFrame(tick);
}

/* 边界阻尼回弹：过冲量压缩 35%，仅 transform 移动列表 */
function applyTransform() {
  const over = dvcPos < 0 ? dvcPos : dvcPos > dvcMax ? dvcPos - dvcMax : 0;
  const base = dvcClamp(dvcPos, 0, dvcMax);
  const off = base + over * 0.35;
  listEl.style.transform = 'translate3d(0,' + (-off) + 'px,0)';
  /* 触底提示：未触底隐藏，触底显示，跟随列表一起被 transform 移动 */
  const atEnd = dvcMax > 0 && dvcPos >= dvcMax - 2;
  endEl.classList.toggle('visible', atEnd);
}

/* 虚拟滚动窗口：可视区前后各缓存 DVC_CACHE 项 */
function renderWindow() {
  const step = DVC_CARD_H + DVC_GAP;
  const first = Math.max(0, Math.floor((dvcPos - DVC_CACHE * step) / step));
  const last = Math.min(dvcList.length - 1, Math.ceil((dvcPos + dvcH + DVC_CACHE * step) / step));
  if (first === dvcWin.first && last === dvcWin.last) return;
  dvcWin = { first, last };
  for (let i = first; i <= last; i++) ensureCard(i);
  for (const [idx, el] of [...dvcRendered]) {
    if (idx < first || idx > last) {
      el.remove();
      dvcRendered.delete(idx);
    }
  }
}

/* 未渲染的项实时渲染，并叠加翻折入场动画（100ms 递增） */
function ensureCard(i) {
  if (dvcRendered.has(i)) return;
  const d = dvcList[i];
  if (!d) return;
  const el = document.createElement('article');
  el.className = 'device-card glass-card';
  el.style.top = i * (DVC_CARD_H + DVC_GAP) + 'px';
  el.style.animationDelay = ((i - dvcWin.first) % 8) * DVC_STAGGER + 'ms';
  el.classList.add('flip-in');
  el.innerHTML = cardHTML(d);
  el.addEventListener('animationend', function handler() {
    el.classList.remove('flip-in');
    el.style.animationDelay = '';
    el.removeEventListener('animationend', handler);
  });
  listEl.appendChild(el);
  dvcRendered.set(i, el);
}

function cardHTML(d) {
  const time = d.time ? fmtTime(d.time) : '—';
  const ua = cleanUA(d.ua);
  const action = d.action === 'login' ? '登录' : esc(d.action || '访问');
  const cls = action === '登录' ? 'ok' : 'warn';
  return `
    <span class="device-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
    </span>
    <div class="device-main">
      <strong>${esc(d.ip)}</strong>
      <span class="device-ua">${esc(ua) || '未知设备'}</span>
      <span class="device-time">${time}</span>
    </div>
    <span class="device-badge ${cls}">${action}</span>`;
}

function cleanUA(ua) {
  const m = String(ua || '').replace(/^\(([^;]+);.*\)$/, '$1').trim();
  return m.slice(0, 40);
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- 右侧纵向滑动条 ---------- */
function initScrollbar() {
  if (!barEl || !thumbEl) return;
  let dragging = null;
  thumbEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = { y: e.clientY, pos: dvcPos };
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const trackH = barEl.clientHeight || 200;
    const th = parseFloat(thumbEl.style.height) || 30;
    const ratio = (e.clientY - dragging.y) / Math.max(1, trackH - th);
    dvcPos = dragging.pos + ratio * dvcMax;
    dvcVel = 0;
    startTicker();
  });
  window.addEventListener('pointerup', () => {
    dragging = null;
  });
}

function updateScrollbar() {
  if (!barEl || !thumbEl) return;
  if (dvcMax <= 0) {
    barEl.classList.remove('visible');
    return;
  }
  barEl.classList.add('visible');
  const trackH = barEl.clientHeight || 200;
  const th = Math.max(28, (dvcH * dvcH) / (dvcMax + dvcH));
  thumbEl.style.height = th + 'px';
  const maxTh = Math.max(0, trackH - th);
  const ratio = dvcClamp(dvcPos, 0, dvcMax) / dvcMax;
  thumbEl.style.transform = 'translate3d(0,' + ratio * maxTh + 'px,0)';
}

/* ===== filestatus.js ===== */
/**
 * 文件处理状态：把上传 / 操作仓库的记录追加到用户文件夹 file-status.log，
 * 「文件处理状态」页读取并展示（仿管理者设置-管理公开作品列表样式）。
 * 记录行格式：ISO时间\t类型\t作品名\t状态
 */




const FS_TYPES = ['错题上传', '题目', '知识库', '项目', '分享'];

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
async function recordFileStatus(type, name, status) {
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
async function getFileStatusList() {
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
async function openFileStatusPage() {
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

/* ===== gallery.js ===== */
/**
 * 公开作品广场：遍历 shareRoot 全部用户的公开作品并渲染。
 *  - 上方工具条卡片：分类筛选（一次函数/二次函数/反比例函数/动画/旋转/全部）+ 排序（默认=目录名顺序、最新=更新时间倒序）+ 搜索
 *  - 下方作品网格卡片：纵向滚动多行，每行 4 个作品卡片，玻璃拟态磨砂 + 翻折入场动画
 *  - 鼠标左键按住可拖拽滚动（禁止选中文字）；点击作品卡片在新窗口打开
 */




const GAL_STATE = { category: '全部', sort: 'default', keyword: '', error: '' };
let galWorks = [];

function galEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function galFmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 遍历 shareRoot 全部用户目录 → 每个用户的 share/works.json 分享索引 */
async function loadGalleryWorks() {
  const cfg = requireConfig();
  const users = await listDirs(cfg, cfg.shareRoot);
  const uinfoCache = {};
  const works = [];
  for (const u of users) {
    const uid = u.name;
    let uinfo = uinfoCache[uid];
    if (uinfo === undefined) {
      uinfo = null;
      try {
        const raw = await ghRead(cfg, buildPath(cfg.usersRoot, uid, 'info.json'));
        if (raw) uinfo = JSON.parse(raw);
      } catch (e) {}
      uinfoCache[uid] = uinfo;
    }
    let index = {};
    try {
      const raw = await ghRead(cfg, buildPath(cfg.shareRoot, uid, 'share', 'works.json'));
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object' && !Array.isArray(d)) index = d;
      }
    } catch (e) {}
    for (const folder of Object.keys(index)) {
      const e = index[folder] || {};
      works.push({
        folder,
        userId: uid,
        path: (e && e.path) || '',
        name: (e && e.name) || folder,
        desc: (e && e.desc) || '',
        category: (e && e.category) || '',
        tags: (e && Array.isArray(e.tags)) ? e.tags : [],
        updatedAt: (e && e.updatedAt) || 0,
        author: (e && e.author) || (uinfo && uinfo.name) || uid,
        userName: (uinfo && uinfo.name) || uid,
        avatar: (uinfo && uinfo.avatar) || '',
      });
    }
  }
  return works;
}

/* 筛选 + 排序（默认=目录名顺序，最新=更新时间倒序） */
function filteredWorks() {
  let list = galWorks.slice();
  const cat = GAL_STATE.category;
  if (cat && cat !== '全部') {
    list = list.filter((w) => (w.category || '未分类') === cat);
  }
  const kw = GAL_STATE.keyword.trim().toLowerCase();
  if (kw) {
    list = list.filter((w) =>
      w.name.toLowerCase().includes(kw) ||
      w.desc.toLowerCase().includes(kw) ||
      (w.tags || []).join(',').toLowerCase().includes(kw) ||
      w.userName.toLowerCase().includes(kw)
    );
  }
  if (GAL_STATE.sort === 'latest') {
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } else {
    list.sort((a, b) => String(a.folder).localeCompare(String(b.folder), 'zh'));
  }
  return list;
}

/* 渲染上方工具条卡片（分类按钮组 + 排序下拉 + 搜索框） */
function renderGalToolbar() {
  const box = document.getElementById('galCats');
  if (!box) return;
  box.innerHTML = GAL_CATEGORIES.map(
    (c) => `<button class="gal-cat${c === GAL_STATE.category ? ' active' : ''}" data-cat="${galEsc(c)}">${galEsc(c)}</button>`
  ).join('');
  box.querySelectorAll('.gal-cat').forEach((btn) => {
    btn.addEventListener('click', () => {
      GAL_STATE.category = btn.dataset.cat;
      renderGalToolbar();
      renderGalDeck();
    });
  });
}

/* 渲染下方作品网格卡片（每行 4 个，翻折入场动画，间隔 80ms） */
function renderGalDeck() {
  const deck = document.getElementById('galDeck');
  const empty = document.getElementById('galEmpty');
  if (!deck) return;
  deck.innerHTML = '';
  if (GAL_STATE.error) {
    if (empty) {
      empty.textContent = GAL_STATE.error;
      empty.classList.remove('hidden');
    }
    return;
  }
  const list = filteredWorks();
  if (!list.length) {
    if (empty) {
      empty.textContent = (GAL_STATE.keyword.trim() || GAL_STATE.category !== '全部')
        ? '没有找到匹配的公开作品'
        : '暂无公开作品';
      empty.classList.remove('hidden');
    }
    return;
  }
  if (empty) empty.classList.add('hidden');
  list.forEach((w, i) => {
    const el = document.createElement('article');
    el.className = 'gal-item';
    el.dataset.user = w.userId;
    el.dataset.folder = w.folder;
    el.style.animationDelay = i * 80 + 'ms';
    el.innerHTML = galCardInner(w);
    deck.appendChild(el);
    const img = el.querySelector('.gal-avatar-img');
    const letter = el.querySelector('.gal-avatar-letter');
    if (img && letter) galAvatar(w, img, letter);
  });
}

/* 作品卡片内容：右上角上传时间角标 → 作品名称 → 作品说明 → 作品分类 → 标签 → 用户头像 → 用户名称 */
function galCardInner(w) {
  const tags = (w.tags || []).slice(0, 4).map((t) => `<span class="gal-tag">${galEsc(t)}</span>`).join('');
  const cat = w.category || '未分类';
  return `
    <span class="gal-time">${galFmtTime(w.updatedAt)}</span>
    <h4 class="gal-name">${galEsc(w.name)}</h4>
    ${w.desc ? `<p class="gal-desc">${galEsc(w.desc)}</p>` : ''}
    <span class="gal-cat">${galEsc(cat)}</span>
    ${tags ? `<div class="gal-tags">${tags}</div>` : ''}
    <div class="gal-user">
      <span class="gal-avatar-wrap"><span class="gal-avatar-letter">学</span><img class="gal-avatar-img hidden" alt="" /></span>
      <span class="gal-user-name">${galEsc(w.userName)}</span>
    </div>
  `;
}

/* 头像：命中仓库路径则加载，失败回退文字「学」 */
function galAvatar(work, img, letter) {
  let cfg = null;
  try { cfg = requireConfig(); } catch (e) {}
  if (cfg && work.avatar) {
    img.onload = () => {
      img.classList.remove('hidden');
      letter.classList.add('hidden');
    };
    img.onerror = () => {
      img.classList.add('hidden');
      letter.classList.remove('hidden');
    };
    img.src = fileUrl(cfg, work.avatar);
  } else {
    img.classList.add('hidden');
    letter.classList.remove('hidden');
  }
}

/* 打开公开作品：从索引 path 读取文件夹内文件，优先 index.html */
async function onOpenGallery(item) {
  try {
    const cfg = requireConfig();
    const w = galWorks.find((x) => x.userId === item.dataset.user && x.folder === item.dataset.folder);
    const base = (w && w.path) ? w.path : buildPath(cfg.shareRoot, item.dataset.user, item.dataset.folder);
    const files = await listFiles(cfg, base);
    const html = files.find((f) => /\.html?$/i.test(f.name));
    const target = html
      ? buildPath(base, html.name)
      : files[0]
        ? buildPath(base, files[0].name)
        : base;
    window.open(cdnUrls(cfg, target).raw, '_blank', 'noopener');
  } catch (e) {
    toast(ERR_MSG);
  }
}

/* 第二个卡片：鼠标左键按住拖拽纵向滚动，禁止选中文字 */
function setupGalDrag(deck) {
  let dragging = false;
  let moved = false;
  let startY = 0;
  let startScroll = 0;
  deck.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    startScroll = deck.scrollTop;
    document.body.classList.add('gal-dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 3) moved = true;
    deck.scrollTop = startScroll - dy;
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.classList.remove('gal-dragging');
  });
  deck.addEventListener('dragstart', (e) => e.preventDefault());
  /* 点击作品卡片打开；拖拽滚动过则不触发 */
  deck.addEventListener('click', (e) => {
    if (moved) {
      moved = false;
      return;
    }
    const item = e.target.closest('.gal-item');
    if (item) onOpenGallery(item);
  });
}

/* 打开公开作品广场页面 */
async function openGalleryPage() {
  const deck = document.getElementById('galDeck');
  if (!deck) return;
  showSkeleton(deck, 4, 'sk-card');
  GAL_STATE.error = '';
  try {
    galWorks = await loadGalleryWorks();
  } catch (e) {
    galWorks = [];
    GAL_STATE.error = ERR_MSG;
  }
  renderGalDeck();
}

function initGallery() {
  renderGalToolbar();
  const sort = document.getElementById('galSort');
  if (sort) {
    sort.addEventListener('change', () => {
      GAL_STATE.sort = sort.value;
      renderGalDeck();
    });
  }
  const search = document.getElementById('galSearch');
  if (search) {
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        GAL_STATE.keyword = search.value;
        renderGalDeck();
      }, 250);
    });
  }
  const deck = document.getElementById('galDeck');
  if (deck) setupGalDrag(deck);
}

/* ===== github.js ===== */
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

const CFG_KEY = 'fnplt_gh_config_v2';
const CFG_DEFAULTS = {
  branch: 'main',
  usersRoot: 'users',
  avatarsRoot: 'avatars',
  shareRoot: 'share',
  cdn: { fastly: '', gcore: '', raw: '' },
};

/* ---------- 编码 / 路径工具 ---------- */
function base64ToString(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function stringToBase64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function buildPath(root, ...parts) {
  const r = String(root || '').replace(/^\/+|\/+$/g, '');
  const p = parts.map((x) => String(x || '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return [r].concat(p).filter(Boolean).join('/');
}

function sanitizeName(name) {
  return String(name || '').replace(/[|\n\r]/g, '').slice(0, 40);
}

/* ---------- 配置 ---------- */
function getConfig() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
  } catch (e) {
    return null;
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

function hasConfig() {
  const cfg = getConfig();
  return !!(cfg && cfg.token && cfg.owner && cfg.repo);
}

function requireConfig() {
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
async function ghRead(cfg, path) {
  const d = await ghRequest(cfg, path, 'GET');
  if (d == null) return null;
  if (Array.isArray(d)) return d;
  if (d.content) return base64ToString(d.content);
  return null;
}

async function ghWrite(cfg, path, content, message, isBase64) {
  const existing = await ghRequest(cfg, path, 'GET', null, true);
  const body = {
    message: message || ('Update ' + path),
    content: isBase64 ? content : stringToBase64(content),
    branch: cfg.branch,
  };
  if (existing && existing.sha) body.sha = existing.sha;
  return ghRequest(cfg, path, 'PUT', body);
}

async function ghDelete(cfg, path, message) {
  const existing = await ghRequest(cfg, path, 'GET', null, true);
  if (!existing || !existing.sha) return true;
  const body = { message: message || ('Delete ' + path), branch: cfg.branch, sha: existing.sha };
  const res = await ghFetch(apiUrl(cfg, path), { method: 'DELETE', headers: ghHeaders(cfg), body: JSON.stringify(body) });
  return res.status === 200;
}

function rawUrl(cfg, path) {
  return 'https://raw.githubusercontent.com/' + cfg.owner + '/' + cfg.repo + '/' + cfg.branch + '/' + path;
}

/**
 * 生成文件的三个 CDN 访问链接（借鉴 auth.js avatarCdnUrl）
 * 其中 fastly.jsdelivr.net 为快速地址，作为默认加载源。
 * 管理者可在配置中自定义三个链接前缀（cfg.cdn.fastly/gcore/raw），留空用默认地址。
 */
function cdnUrls(cfg, path) {
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
function fileUrl(cfg, path) {
  return cdnUrls(cfg, path).fastly;
}

/* 列出目录下所有文件 */
async function listFiles(cfg, dir) {
  const list = await ghRead(cfg, dir);
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f && f.type === 'file');
}

/* 列出目录下所有子目录 */
async function listDirs(cfg, dir) {
  const list = await ghRead(cfg, dir);
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f && f.type === 'dir');
}

/* 检查 GitHub API 剩余额度（resources.core.remaining）；need 为预计需要的请求数。
 * 查询失败或无需鉴权时不阻塞：remaining 取 -1 表示未知，视为通过。 */
async function checkRateLimit(cfg, need) {
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
function withGhLock(key, fn) {
  if (ghLocks[key]) return null;
  ghLocks[key] = true;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      ghLocks[key] = false;
    });
}

/* ===== mail.js ===== */
/**
 * 邮件验证码客户端（对接 Vercel /api/mail 或本地 qqmail-server）：
 *   send  / sendCode / verify
 * 接口域名来自 cfg.mail.base（管理者设置 - 邮件验证码服务 配置），
 * 留空则返回「邮件服务未配置」错误。验证码随 sendCode 响应返回，
 * 前端本地保存用于比对（兼容 Serverless 无状态特性）。
 */


function mailBase() {
  try {
    const cfg = getConfig();
    if (cfg && cfg.mail && cfg.mail.base) return String(cfg.mail.base).trim();
  } catch (e) {}
  return '';
}

function mailEnabled() {
  try {
    const cfg = getConfig();
    return !!(cfg && cfg.mail && cfg.mail.enabled && cfg.mail.base);
  } catch (e) {
    return false;
  }
}

function validateEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('请输入正确的邮箱地址');
  if (e.length > 120) throw new Error('邮箱地址过长');
  return e;
}

function mailPost(data) {
  const base = mailBase();
  if (!base) return Promise.resolve({ ok: false, msg: '邮件服务未配置（管理者设置 - 邮件验证码服务）' });
  return fetch(base + '/api/mail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
    .then((res) => (res.ok ? res.json() : { ok: false, msg: '邮件服务 HTTP ' + res.status }))
    .catch((e) => ({ ok: false, msg: '邮件服务连接失败：' + (e && e.message ? e.message : '网络错误') + '（目标 ' + base + '/api/mail）' }));
}

let mailLastCode = null;
let mailLastEmail = '';

/* 发送验证码：成功则保存最近一次验证码供本地比对 */
async function mailSendCode(email) {
  const r = await mailPost({ action: 'sendCode', to: email, digits: 6 });
  if (r.ok && r.code != null) {
    mailLastCode = String(r.code);
    mailLastEmail = email;
  }
  return r;
}

/* 本地校验：验证码需与最近一次发送且邮箱一致的比对成功 */
function mailVerifyCode(email, code) {
  return !!(mailLastCode && mailLastEmail === email && String(code) === mailLastCode);
}

function mailClearCode() {
  mailLastCode = null;
  mailLastEmail = '';
}

/* ===== music-panel.js ===== */
/**
 * 音乐播放器：左侧玻璃拟态悬浮卡片。
 *  - 数据源：管理者「音乐播放配置」（getConfig().music），参数值 {{id}} 替换为当前歌曲 ID
 *  - 响应解析：type=song 拿详情（name/singer/picimg）；若详情无音频直链，自动补一次 type=url 请求
 *  - 播放列表：每行一个歌曲 ID；随机模式按 60%-70% 概率取列表内 ID，其余取随机 ID
 *  - 交互：右上角收起按钮（向左水平插入、露出约 10%）、展开状态可拖拽、进度条点击跳转
 *  - 层级最高（z-index 9999），拖拽与下拉刷新期间禁止选中文字
 */




const PANEL_ID = 'mpPanel';
const RANDOM_PICK_LIST = 0.65; // 随机模式取列表内歌曲的概率
const FOLD_PEEK = 24; // 收起时露在屏幕外的左缘宽度（px）

let mp = null;

/* force=true 时强制重建卡片（管理者「刷新卡片」按钮 / 播放卡死后用于恢复） */
function initMusicPanel(force) {
  const existing = document.getElementById(PANEL_ID);
  const m = musicConfig();
  if (!m) {
    /* 配置被停用：移除已渲染的卡片 */
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    if (!force) return;
    existing.remove();
  }
  buildPanel();
}

/* 读取音乐配置：未启用或未配置 API 时不初始化 */
function musicConfig() {
  const cfg = getConfig();
  if (!cfg || !cfg.music) return null;
  const m = cfg.music;
  if (m.enabled === false || !m.url) return null;
  return m;
}

/* ---------- 请求与解析 ---------- */
function buildParams(m, id, overrideType) {
  const params = {};
  (m.params || []).forEach((p) => {
    if (!p || !p.key) return;
    params[p.key] = String(p.value == null ? '' : p.value)
      .replace(/\{\{id\}\}/g, String(id))
      .replace(/\{\{input\}\}/g, String(id));
  });
  if (overrideType) params.type = overrideType;
  return params;
}

async function apiRequest(m, id, overrideType) {
  const params = buildParams(m, id, overrideType);
  const url = String(m.url || '').trim();
  const method = (m.method || 'GET').toUpperCase();
  if (method === 'POST') {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.json();
  }
  const qs = new URLSearchParams(params).toString();
  return fetch(url + (qs ? '?' + qs : '')).then((r) => r.json());
}

/* 按点分路径提取响应内容；未配置 path 时优先取根 data 字段 */
function extractData(json, path) {
  let d = json;
  if (path) {
    for (const seg of String(path).split('.')) {
      if (d == null) return null;
      d = d[seg];
    }
  } else if (json && json.data != null) {
    d = json.data;
  }
  return d;
}

/* 音频直链容错：url 可能是字符串或数组 */
function pickUrl(v) {
  if (Array.isArray(v)) {
    for (const it of v) {
      const u = it && (typeof it === 'object' ? it.url || it.src : it);
      if (typeof u === 'string' && u) return u;
    }
    return null;
  }
  if (typeof v === 'string' && v) return v;
  if (v && typeof v === 'object') return v.url || v.src || v.path || null;
  return null;
}

/* 获取歌曲：先拿详情，无音频直链时自动补 type=url 请求 */
async function fetchSong(id) {
  const m = musicConfig();
  if (!m) throw new Error('音乐未启用');
  let d = extractData(await apiRequest(m, id), m.path);
  if (!d || typeof d !== 'object') d = {};
  let audioUrl = pickUrl(d.url);
  if (!audioUrl) {
    const d2 = extractData(await apiRequest(m, id, 'url'), m.path);
    if (d2 && typeof d2 === 'object') audioUrl = pickUrl(d2.url) || pickUrl(d2);
  }
  return {
    id: d.id || id,
    name: d.name || d.title || '未知歌曲',
    /* BugPk 接口扁平返回：name/ar_name/al_name/pic/url */
    singer: d.singer || d.ar_name || d.artist || d.author || d.singerName || '',
    album: d.al_name || d.album || '',
    picimg: d.picimg || d.picUrl || d.cover || d.pic || d.coverUrl || '',
    url: audioUrl,
  };
}

function randomId() {
  return String(Math.floor(1e8 + Math.random() * 9e8));
}

/* ---------- 播放列表策略 ---------- */
function currentList() {
  const m = musicConfig();
  return (m && Array.isArray(m.playlist)) ? m.playlist.filter(Boolean) : [];
}

/* 下一首选择：返回 { id, fromList } */
function pickNext() {
  const list = currentList();
  const m = musicConfig();
  if (!list.length) return { id: randomId(), fromList: false };
  if (!m || m.random === false) {
    const next = (mp.idx + 1) % list.length;
    return { id: list[next], fromList: true, next: next };
  }
  if (Math.random() < RANDOM_PICK_LIST) {
    let next = Math.floor(Math.random() * list.length);
    if (list.length > 1 && next === mp.idx) next = (next + 1) % list.length;
    return { id: list[next], fromList: true, next: next };
  }
  return { id: randomId(), fromList: false };
}

function pickPrev() {
  const list = currentList();
  if (!list.length) return { id: randomId(), fromList: false };
  const prev = (mp.idx - 1 + list.length) % list.length;
  return { id: list[prev], fromList: true, next: prev };
}

/* ---------- UI ---------- */
function buildPanel() {
  const card = document.createElement('div');
  card.id = PANEL_ID;
  card.className = 'music-card folded';
  card.innerHTML = `
    <div class="music-card-inner">
      <button class="music-fold" type="button" title="收起播放器">»</button>
      <div class="music-main">
        <img class="music-cover" id="mpCover" alt="封面" />
        <div class="music-info">
          <div class="music-name-wrap"><span class="music-name" id="mpName">未播放</span></div>
          <span class="music-singer" id="mpSinger">点击播放</span>
        </div>
      </div>
      <div class="music-progress">
        <span class="mp-time" id="mpCur">0:00</span>
        <div class="mp-bar" id="mpBar"><div class="mp-bar-fill" id="mpBarFill"></div></div>
        <span class="mp-time" id="mpDur">0:00</span>
      </div>
      <div class="music-controls">
        <button class="mp-btn" id="mpPrev" type="button" title="上一首">⏮</button>
        <button class="mp-btn mp-toggle" id="mpToggle" type="button" title="播放/暂停">▶</button>
        <button class="mp-btn" id="mpNext" type="button" title="下一首">⏭</button>
      </div>
    </div>
    <audio id="mpAudio"></audio>
  `;
  document.body.appendChild(card);

  const audio = document.getElementById('mpAudio');
  const toggleBtn = document.getElementById('mpToggle');
  const cover = document.getElementById('mpCover');
  const nameEl = document.getElementById('mpName');
  const singerEl = document.getElementById('mpSinger');
  const bar = document.getElementById('mpBar');
  const barFill = document.getElementById('mpBarFill');
  const curEl = document.getElementById('mpCur');
  const durEl = document.getElementById('mpDur');

  mp = { idx: 0, playing: false, cur: null, card, audio, busy: false, lastX: null };

  /* 初始垂直居中（用 top 定位，避免与折叠位移互相干扰） */
  const initTop = Math.max(8, Math.min(window.innerHeight - card.offsetHeight - 8, (window.innerHeight - card.offsetHeight) / 2));
  card.style.top = initTop + 'px';
  card.style.transform = 'translateY(0)';

  /* 收起：left 直接移出屏幕外，仅露 FOLD_PEEK 宽（不依赖 transform，拖到任意位置都能收起） */
  const foldCard = () => {
    const w = card.offsetWidth || 320;
    card.style.left = -(w - FOLD_PEEK) + 'px';
    card.classList.add('folded');
  };
  /* 弹出：回到拖拽前（或初始）位置 */
  const expandCard = () => {
    if (mp.lastX == null) mp.lastX = 12;
    card.style.left = mp.lastX + 'px';
    card.classList.remove('folded');
  };

  cover.addEventListener('error', () => {
    cover.classList.add('mp-cover-fallback');
  });

  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    const p = audio.currentTime / audio.duration;
    barFill.style.width = (p * 100).toFixed(2) + '%';
    curEl.textContent = mpFmtTime(audio.currentTime);
    durEl.textContent = mpFmtTime(audio.duration);
  });
  audio.addEventListener('loadedmetadata', () => {
    durEl.textContent = mpFmtTime(audio.duration || 0);
  });
  audio.addEventListener('play', () => {
    mp.playing = true;
    toggleBtn.textContent = '❚❚';
    card.classList.add('mp-playing');
  });
  audio.addEventListener('pause', () => {
    mp.playing = false;
    toggleBtn.textContent = '▶';
    card.classList.remove('mp-playing');
  });
  audio.addEventListener('ended', () => {
    playTarget(pickNext());
  });

  /* 进度条点击跳转 */
  bar.addEventListener('click', (e) => {
    if (!audio.duration) return;
    const r = bar.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    audio.currentTime = p * audio.duration;
  });

  /* 播放控制 */
  toggleBtn.addEventListener('click', () => {
    if (mp.busy) return;
    if (!mp.cur) {
      playTarget({ id: firstId(), fromList: true, next: 0 });
      return;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  document.getElementById('mpPrev').addEventListener('click', () => playTarget(pickPrev()));
  document.getElementById('mpNext').addEventListener('click', () => playTarget(pickNext()));

  /* 收起 / 弹出：折叠用 left 移出屏幕，弹出回到原位置 */
  card.querySelector('.music-fold').addEventListener('click', () => {
    if (card.classList.contains('folded')) expandCard();
    else foldCard();
  });

  /* 展开状态可拖拽（折叠时点击露出的左缘也可弹出并拖动） */
  setupDrag(card);
  /* 初始为收起状态：移出屏幕外只露左缘 */
  foldCard();

  /* 封面/歌名滚动检测：内容超出宽度时开启横向滚动 */
  const checkMarquee = () => {
    const wrap = nameEl.parentElement;
    if (nameEl.scrollWidth > wrap.clientWidth + 2) {
      nameEl.classList.add('scrolling');
      nameEl.style.setProperty('--dist', -(nameEl.scrollWidth - wrap.clientWidth) + 'px');
    } else {
      nameEl.classList.remove('scrolling');
    }
  };
  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(checkMarquee) : null;
  if (ro) ro.observe(nameEl);
  window.addEventListener('resize', checkMarquee);
  mp.checkMarquee = checkMarquee;
}

function firstId() {
  const list = currentList();
  return list.length ? list[0] : randomId();
}

function setupDrag(card) {
  let dragging = false;
  let sx = 0, sy = 0, ox = 0, oy = 0;

  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.target.closest('.mp-bar')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragging = true;
    /* 折叠时点击左缘：先弹出到原位置再开始拖 */
    if (card.classList.contains('folded')) {
      if (mp.lastX == null) mp.lastX = 12;
      card.style.left = mp.lastX + 'px';
      card.classList.remove('folded');
    }
    sx = e.clientX;
    sy = e.clientY;
    ox = card.offsetLeft;
    oy = card.offsetTop;
    /* 拖拽过程禁用 transition，避免位置滞后 */
    card.style.transition = 'none';
    card.setPointerCapture(e.pointerId);
    document.body.classList.add('music-dragging');
    e.preventDefault();
  });

  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const nx = Math.max(8, Math.min(window.innerWidth - card.offsetWidth - 8, ox + (e.clientX - sx)));
    const ny = Math.max(8, Math.min(window.innerHeight - card.offsetHeight - 8, oy + (e.clientY - sy)));
    card.style.left = nx + 'px';
    card.style.top = ny + 'px';
    mp.lastX = nx;
  });

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = '';
    document.body.classList.remove('music-dragging');
  };
  card.addEventListener('pointerup', stop);
  card.addEventListener('pointercancel', stop);
}

/* 播放一首歌：加载 → 设置 UI → 播放 */
async function playTarget(target) {
  if (!mp) return;
  const id = target.id;
  if (mp.busy) return;
  mp.busy = true;
  const toggleBtn = document.getElementById('mpToggle');
  toggleBtn.textContent = '…';
  try {
    const song = await fetchSong(id);
    if (!song.url) throw new Error('no-url');
    mp.cur = song;
    mp.playing = false;
    if (target.fromList && target.next != null) mp.idx = target.next;
    const nameEl = document.getElementById('mpName');
    document.getElementById('mpSinger').textContent = song.singer || '未知歌手';
    nameEl.textContent = song.name;
    const cover = document.getElementById('mpCover');
    if (song.picimg) {
      cover.src = song.picimg;
      cover.classList.remove('mp-cover-fallback');
    } else {
      cover.removeAttribute('src');
      cover.classList.add('mp-cover-fallback');
    }
    if (mp.checkMarquee) mp.checkMarquee();
    mp.audio.src = song.url;
    mp.audio.play().catch(() => {});
  } catch (e) {
    toast('获取音乐失败，可能被风控');
  } finally {
    mp.busy = false;
    if (!mp.cur) toggleBtn.textContent = '▶';
  }
}

function mpFmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/* ===== pages.js ===== */












const PAGE_EL = {
  profile: 'page-profile',
  admin: 'page-admin',
  profileSettings: 'page-profile-settings',
  devices: 'page-devices',
  projects: 'page-projects',
  myworks: 'page-myworks',
  placeholder: 'page-placeholder',
  filestatus: 'page-filestatus',
  gallery: 'page-gallery',
};

/* 仓库数据读取缓存机制：切页后延迟 REPO_DELAY ms，仍停留该页才真正读取，
   期间用户频繁切页只会重置计时器（节流），避免短时间多次请求导致 API 被封 */
const REPO_DELAY = 2500;
const delayedTimers = {};

function isViewActive(pageId) {
  const el = document.getElementById(PAGE_EL[pageId]);
  return !!(el && el.classList.contains('active'));
}

function delayRepoLoad(pageId, fn) {
  clearTimeout(delayedTimers[pageId]);
  delayedTimers[pageId] = setTimeout(() => {
    if (!isViewActive(pageId)) return;
    const run = withGhLock('page-load:' + pageId, fn);
    if (!run) return;
    run.catch(() => {});
  }, REPO_DELAY);
}

/* 统一的页面数据加载入口：所有仓库数据加载共用同一把锁（page-load:<pageId>），
   加载中再次点击刷新按钮不会重置进度，只弹底部提示 */
function loadPageData(pageId) {
  if (pageId === 'projects') return openProjectsPage();
  if (pageId === 'myworks') return openMyWorksPage();
  if (pageId === 'filestatus') return openFileStatusPage();
  if (pageId === 'gallery') return openGalleryPage();
  if (pageId === 'profile') return refreshStats(getCurrentUser());
  if (placeholderPages[pageId]) {
    renderPlaceholder(pageId);
    return refreshAll(true);
  }
  return Promise.resolve();
}

/* 刷新用户数据与统计（占位页刷新按钮 / 侧边栏切换占位页时） */
async function refreshAll(showToast) {
  const user = await refreshUser();
  if (user) {
    updateNavUser(user);
    renderUserUI(user);
    refreshStats(user);
    if (showToast) toast('数据已刷新');
  } else {
    refreshStats(null);
    if (showToast) toast('尚未登录，仅刷新了统计');
  }
}

function onPageRefresh(pageId, btn) {
  const run = withGhLock('page-load:' + pageId, () => loadPageData(pageId));
  if (!run) {
    bottomTip();
    return;
  }
  const restore = busyButton(btn, '刷新中…');
  run.catch(() => {}).finally(restore);
}

function initPages() {
  renderFuncGrid();

  /* 资料设置入口 */
  document.getElementById('profileEditBtn').addEventListener('click', () => {
    switchPage('profileSettings');
  });

  /* 私有内容页刷新按钮（main 事件委托，覆盖项目/公开作品/占位页） */
  const main = document.getElementById('main');
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-refresh-btn[data-page-refresh]');
    if (!btn) return;
    onPageRefresh(btn.dataset.pageRefresh, btn);
  });
}

/* 页面切换：需要读取仓库数据的页面先显示骨架，再延迟加载（缓存机制 + 节流） */
function switchPage(pageId) {
  setSidebarActive(pageId);

  if (pageId === 'profile') {
    showView(PAGE_EL.profile);
    delayRepoLoad('profile', () => refreshStats(getCurrentUser()));
  } else if (pageId === 'admin') {
    showView(PAGE_EL.admin);
  } else if (pageId === 'profileSettings') {
    showView(PAGE_EL.profileSettings);
    showProfileSettings();
  } else if (pageId === 'devices') {
    showView(PAGE_EL.devices);
  } else if (pageId === 'projects') {
    showView(PAGE_EL.projects);
    if (getCurrentUser()) {
      showSkeleton(document.getElementById('projDeck'), 4, 'sk-card');
      delayRepoLoad('projects', openProjectsPage);
    } else {
      openProjectsPage();
    }
  } else if (pageId === 'myworks') {
    showView(PAGE_EL.myworks);
    if (getCurrentUser()) {
      showSkeleton(document.getElementById('myworksList'), 3, 'sk-row');
      delayRepoLoad('myworks', openMyWorksPage);
    } else {
      openMyWorksPage();
    }
  } else if (pageId === 'filestatus') {
    showView(PAGE_EL.filestatus);
    const box = document.getElementById('filestatusList');
    if (getCurrentUser()) {
      showSkeleton(box, 5, 'sk-row');
      delayRepoLoad('filestatus', openFileStatusPage);
    } else if (box) {
      box.innerHTML = '<div class="adm-empty">请先登录后查看文件处理状态</div>';
    }
  } else if (pageId === 'gallery') {
    showView(PAGE_EL.gallery);
    showSkeleton(document.getElementById('galDeck'), 4, 'sk-card');
    delayRepoLoad('gallery', openGalleryPage);
  } else if (placeholderPages[pageId]) {
    renderPlaceholder(pageId);
    showView(PAGE_EL.placeholder);
    /* 切页缓存机制：延迟后仍停留本页才静默刷新用户数据 */
    delayRepoLoad(pageId, () => refreshAll(false));
  } else {
    showView(PAGE_EL.profile);
  }
}

function showView(id) {
  document.querySelectorAll('.page-view').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) {
    target.classList.add('active');
    playCardEntrance(target);
  }
}

/* 页面切换时卡片从上到下依次翻开 */
function playCardEntrance(page) {
  const cards = [...page.querySelectorAll(
    '.overview-card, .func-card, .stat-block, .ps-head, .ps-card, .admin-head, .admin-tab, .admin-card, .placeholder-page, .devices-head, .device-card, .proj-head, .proj-card, .myworks-head, .myworks-item, .gal-toolbar, .gal-deck-shell'
  )];
  if (!cards.length) return;
  cards.forEach((el) => el.classList.remove('flip-in'));
  void page.offsetWidth;
  cards.forEach((el, i) => {
    el.style.animationDelay = i * 55 + 'ms';
    el.classList.add('flip-in');
    el.addEventListener('animationend', function handler() {
      el.classList.remove('flip-in');
      el.style.animationDelay = '';
      el.removeEventListener('animationend', handler);
    });
  });
}

/* 根据用户数据渲染个人信息页（昵称 / ID / 头像） */
function renderUserUI(user) {
  const name = (user && user.name) || '未登录';
  const idText = user ? 'ID：' + user.id : 'ID：未登录';

  document.getElementById('overviewName').textContent = name;
  document.getElementById('overviewId').textContent = idText;
  renderAvatar('overviewAvatar', 'overviewAvatarImg', user, name);
}

/* ① 顶部个人总览统计块：数据未加载完成前显示 "-"，加载后填充真实值 */
async function refreshStats(user) {
  const container = document.getElementById('overviewStats');
  if (!container) return;
  container.innerHTML = STAT_BLOCKS.map(
    (s) => `<div class="stat-block"><strong>-</strong><span>${s.label}</span></div>`
  ).join('');
  const stats = await getStats(user);
  container.innerHTML = STAT_BLOCKS.map(
    (s) => `<div class="stat-block"><strong>${stats[s.key] ?? 0}</strong><span>${s.label}</span></div>`
  ).join('');
}

/* ② 2x2 功能网格卡片 */
function renderFuncGrid() {
  const container = document.getElementById('funcGrid');
  container.innerHTML = funcItems
    .map(
      (item) => `
      <article class="func-card glass-card hoverable" data-page="${item.page}">
        <span class="func-card-arrow">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </span>
        <span class="func-card-icon">${item.icon}</span>
        <div class="func-card-info">
          <strong>${item.title}</strong>
          <span>${item.desc}</span>
        </div>
      </article>`
    )
    .join('');
  container.addEventListener('click', (e) => {
    const card = e.target.closest('.func-card[data-page]');
    if (!card) return;
    const item = funcItems.find((it) => it.page === card.dataset.page);
    switchPage(card.dataset.page);
    if (item) toast(`进入：${item.title}`);
  });
}

/* ③ 通用占位页渲染（知识库/上传/错题库/公开作品广场），含刷新按钮 */
function renderPlaceholder(pageId) {
  const page = placeholderPages[pageId];
  if (!page) return;
  const body = document.getElementById('placeholderBody');
  body.innerHTML = `
    <div class="placeholder-icon">${page.icon}</div>
    <h3>${page.title}</h3>
    <p>${page.desc}</p>
    <button class="page-refresh-btn" data-page-refresh="${pageId}">刷新</button>
  `;
}

/* ===== profile-settings.js ===== */
/**
 * 个人资料页（页签「个人资料」）：
 * 昵称 / 密码 / 头像 / 白名单 / 设备记录 / 黑名单 / 退出 / 切换登录 / 注销账户
 */








/* 登录态变化后的全局刷新回调（由 app.js 注入，避免循环依赖） */
let onUserChanged = null; // (user) => void
let onNavigate = null; // (pageId) => void

function setProfileHooks(changed, navigate) {
  onUserChanged = changed;
  onNavigate = navigate;
}

function initProfileSettings() {
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

async function showProfileSettings() {
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

function openAvatarModal() {
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

function openListModal(kind) {
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

/* ===== projects.js ===== */
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







/* ---------- 我的项目 ---------- */
let projList = [];          // 项目数组（含 folder 字段）
let shareBusy = false;      // 单个分享/取消进行中：禁用其余分享按钮
let batchBusy = false;      // 批量操作进行中：禁用批量栏按钮
let myWorks = [];           // 我的公开作品（索引条目，含 folder/path/name）

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const OPEN_TICKET_TTL = 15 * 60 * 1000; // 一次性打开令牌有效期

/* 异步获取当前访问者 IP（绘制器侧校验令牌时比对）。失败 / 超时（8 秒）回退空串，不阻塞签发。
 * getClientIP 为 app.js 合并后的全局顶层函数；未加载时按无 IP 处理。 */
function getClientIpSafely() {
  try {
    if (typeof getClientIP === 'function') {
      return Promise.race([
        Promise.resolve().then(() => getClientIP()),
        new Promise((r) => setTimeout(() => r(''), 8000)),
      ]).catch(() => '');
    }
  } catch (e) {}
  return Promise.resolve('');
}

/* 打开函数绘制器的跳转组装：点鸭 logs 表启用时签发一次性令牌，URL 带 ?t=<token>&id=<项目文件夹>
 * （不嵌套 u/p）。detail 记录签发时 IP，绘制器校验时比对，防止令牌被转移到其他设备 / 网络使用。
 * 未启用点鸭 logs 时无法签发令牌，拒绝生成链接并提示（禁止把用户数据 u/p 暴露到链接里）。
 * 返回 Promise<{url}>，失败时 reject(Error)。 */
function issueOpenToken(uid, folder) {
  if (!(window.DbsApi && dbEnabled(DB_TABLES.LOGS))) {
    return Promise.reject(new Error('未启用点鸭数据表，无法生成打开链接，请先在管理者设置中启用点鸭'));
  }
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const exp = Date.now() + OPEN_TICKET_TTL;
  // 并行获取当前 IP + 清理旧令牌（该用户全部 open_ticket，含已消费），保证同时只存在一个有效令牌。
  const ipPromise = getClientIpSafely();
  return dbRemove("type='open_ticket' AND user_id='" + String(uid || '').replace(/'/g, "''") + "'", DB_TABLES.LOGS)
    .catch(() => {})
    .then(() => ipPromise)
    .then((ip) =>
      dbInsert(
        {
          type: 'open_ticket',
          user_id: String(uid || ''),
          name: token,
          status: 'active',
          detail: JSON.stringify({ folder: String(folder || ''), exp, ip: String(ip || '') }),
        },
        DB_TABLES.LOGS
      )
    )
    .then(() => ({ url: 'plotter/index.html?t=' + encodeURIComponent(token) + '&id=' + encodeURIComponent(String(folder || '')) }));
}

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
  issueOpenToken(user.id, folder).then((r) => {
    window.open(r.url, '_blank', 'noopener');
    toast('已打开项目：' + p.name);
  }).catch((e) => {
    toast((e && e.message) || '无法生成打开链接');
  });
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
async function openProjectsPage() {
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

function initProjects() {
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
async function openMyWorksPage() {
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
    issueOpenToken(uid, proj).then((r) => {
      window.open(r.url, '_blank', 'noopener');
    }).catch((e) => {
      toast((e && e.message) || '无法生成打开链接');
    });
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

/* ===== pull-refresh.js ===== */
/**
 * 主内容区下拉刷新：在滚动顶部时向下拖拽 → 重新拉取用户数据并刷新 UI。
 * 桌面鼠标拖拽与触屏均可触发。
 */





const THRESHOLD = 64;

function initPullRefresh() {
  const main = document.getElementById('main');
  if (!main) return;

  const ind = document.createElement('div');
  ind.className = 'pull-refresh';
  ind.innerHTML = '<span class="pull-spinner"></span><span class="pull-text">下拉刷新</span>';
  main.appendChild(ind);

  let startY = null;
  let dist = 0;
  let refreshing = false;

  const setState = (y) => {
    dist = y;
    const clamped = Math.min(y, 90);
    ind.style.transform = `translateY(${clamped - 24}px)`;
    ind.classList.toggle('visible', y > 4);
    ind.classList.toggle('beyond', y >= THRESHOLD);
    ind.querySelector('.pull-text').textContent = y >= THRESHOLD ? '释放刷新' : '下拉刷新';
  };

  const reset = () => {
    startY = null;
    dist = 0;
    ind.style.transform = '';
    ind.classList.remove('visible', 'beyond');
    ind.querySelector('.pull-text').textContent = '下拉刷新';
    document.body.classList.remove('pull-dragging');
  };

  main.addEventListener('pointerdown', (e) => {
    if (refreshing || main.scrollTop > 0) return;
    if (e.pointerType !== 'mouse' && e.button) return;
    startY = e.clientY;
    /* 拖拽期间禁止选中文字 */
    document.body.classList.add('pull-dragging');
  });

  main.addEventListener('pointermove', (e) => {
    if (startY == null || refreshing) return;
    const delta = e.clientY - startY;
    if (delta <= 0) {
      reset();
      return;
    }
    if (main.scrollTop > 0) {
      reset();
      return;
    }
    e.preventDefault();
    setState(delta * 0.5);
  });

  main.addEventListener('pointerup', async () => {
    if (startY == null) return;
    const go = dist >= THRESHOLD;
    reset();
    if (!go || refreshing) return;
    refreshing = true;
    ind.classList.add('refreshing', 'visible');
    ind.style.transform = 'translateY(0)';
    ind.querySelector('.pull-text').textContent = '刷新中...';
    try {
      const user = await refreshUser();
      if (user) {
        updateNavUser(user);
        renderUserUI(user);
        refreshStats(user);
        toast('数据已刷新');
      } else {
        refreshStats(null);
        toast('尚未登录，仅刷新了统计');
      }
    } catch (e) {
      toast(e.message || '刷新失败');
    } finally {
      refreshing = false;
      ind.classList.remove('refreshing');
      reset();
    }
  });

  main.addEventListener('pointercancel', reset);
}

/* ===== share.js ===== */
/**
 * 公开作品分享索引（整改）：
 * 不再把作品文件复制到公开作品目录，改为在 <shareRoot>/<userId>/share/works.json
 * 存作品的仓库内相对路径 + 分类等元信息，实时同步原项目，节省仓库空间。
 *  - works.json 为聚合索引：{ [作品folder]: { path, name, desc, category, tags, updatedAt } }
 *  - path 为仓库内相对路径，如 users/<uid>/projects/<folder>
 *  - 分享/取消同时双写项目 info.json 的 shared 字段
 *  - 批量操作：顺序队列 + 每操作间隔 SHARE_INTERVAL + 先查 /rate_limit 额度
 */


const SHARE_INTERVAL = 600; // 批量操作每个写请求的间隔（ms）
const SHARE_DIR = 'share'; // 用户公开作品索引目录（share 目录内为 JSON 索引，非作品本体）
const SHARE_FILE = 'works.json';

function shareIndexPath(cfg, uid) {
  return buildPath(cfg.shareRoot, String(uid), SHARE_DIR, SHARE_FILE);
}

/* 读取用户分享索引（容错：不存在 / 解析失败 → 空对象） */
async function readShareIndex(cfg, uid) {
  try {
    const raw = await ghRead(cfg, shareIndexPath(cfg, uid));
    if (!raw) return {};
    const d = JSON.parse(raw);
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (e) {
    return {};
  }
}

async function writeShareIndex(cfg, uid, works) {
  await ghWrite(cfg, shareIndexPath(cfg, uid), JSON.stringify(works, null, 2), 'Update share index ' + uid);
}

/* 由项目 meta 构造分享索引条目（path 指向原项目文件夹） */
function entryFromMeta(cfg, uid, folder, meta) {
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
async function shareWork(cfg, uid, folder, meta, infoPath) {
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
async function unshareWork(cfg, uid, folder, infoPath) {
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
async function listMyWorks(cfg, uid) {
  const index = await readShareIndex(cfg, uid);
  return Object.keys(index).map((folder) => ({ folder, ...index[folder] }));
}

/* ===== sidebar.js ===== */


function initSidebar() {
  const nav = document.getElementById('sidebarNav');
  nav.addEventListener('click', (e) => {
    const item = e.target.closest('.side-item[data-page]');
    if (!item) return;
    switchPage(item.dataset.page);
  });
}

/* 侧边栏高亮切换 */
function setSidebarActive(pageId) {
  document.querySelectorAll('.side-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.page === pageId);
  });
}

/* 管理员专属分组：仅管理员账号可见 */
function setSidebarAdminVisibility(visible) {
  const group = document.getElementById('adminGroupTitle');
  const btn = document.getElementById('adminSideBtn');
  if (group) group.classList.toggle('hidden', !visible);
  if (btn) btn.classList.toggle('hidden', !visible);
  if (!visible && document.getElementById('page-admin').classList.contains('active')) {
    switchPage('profile');
  }
}

/* ===== topnav.js ===== */








function initTopNav() {
  renderNewMenu();

  /* 加号新建 */
  const newBtn = document.getElementById('newBtn');
  const newDropdown = document.getElementById('newDropdown');
  newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown(newDropdown);
  });
  newDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('button[data-page]');
    if (!item) return;
    closeDropdown(newDropdown);
    switchPage(item.dataset.page);
    toast(`已开始：${item.textContent.trim()}`);
  });

  /* 用户菜单 */
  const userMenu = document.getElementById('userMenu');
  const userDropdown = document.getElementById('userDropdown');
  userMenu.addEventListener('click', (e) => {
    if (e.target.closest('.dropdown')) return;
    e.stopPropagation();
    userMenu.classList.toggle('open');
    toggleDropdown(userDropdown);
  });
  userDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('button[data-action]');
    if (!item) return;
    closeDropdown(userDropdown);
    userMenu.classList.remove('open');
    handleUserAction(item.dataset.action);
  });

  /* 返回 / 品牌 / 绘图主页标签：跳转到函数绘制器空白新项目（?new=1 不经令牌校验）。
   * 打开用户已保存项目一律从「我的页面」走一次性令牌，顶部按钮不携带用户数据。 */
  const _plotterUrl = 'plotter/index.html?new=1';
  bindJump('backBtn', _plotterUrl);
  bindJump('brandBtn', _plotterUrl);
  bindJump('quickBackBtn', _plotterUrl);
  document.querySelectorAll('.nav-tab[data-nav="plotter"]').forEach((btn) =>
    btn.addEventListener('click', () => { location.href = _plotterUrl; })
  );
  document.getElementById('manualBtn').addEventListener('click', () =>
    toast('使用手册：左侧导航切换页面，右侧 AI 球形助手可拖动、双击展开')
  );

  /* 点击外部关闭下拉 */
  document.addEventListener('click', () => {
    closeDropdown(newDropdown);
    closeDropdown(userDropdown);
    userMenu.classList.remove('open');
  });
}

/* 登录态变化时更新顶部昵称/头像与下拉菜单 */
function updateNavUser(user) {
  const name = (user && user.name) || '未登录';
  document.getElementById('navUserName').textContent = name;
  renderAvatar('navAvatar', 'navAvatarImg', user, name);

  const dropdown = document.getElementById('userDropdown');
  let loginItem = dropdown.querySelector('[data-action="login"]');
  if (user) {
    if (loginItem) loginItem.remove();
  } else {
    if (!loginItem) {
      const btn = document.createElement('button');
      btn.dataset.action = 'login';
      btn.innerHTML = loginSvg() + '登录 / 注册';
      dropdown.prepend(btn);
    }
  }
}

function loginSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><polyline points="10 17 15 12 10 7"></polyline><line x1="15" y1="12" x2="3" y2="12"></line></svg>';
}

function handleUserAction(action) {
  switch (action) {
    case 'login':
      openAuthModal();
      break;
    case 'profile':
      handleProfile();
      break;
    case 'admin':
      handleAdminEntry();
      break;
    case 'logout':
      clearSession();
      updateNavUser(null);
      renderUserUI(null);
      refreshStats(null);
      setSidebarAdminVisibility(true);
      switchPage('profile');
      toast('已退出登录');
      break;
    default:
      break;
  }
}

function handleProfile() {
  const user = getCurrentUser();
  if (!user) {
    toast('请先登录');
    openAuthModal();
    return;
  }
  /* 打开个人资料界面（昵称/密码/头像/白名单等设置） */
  switchPage('profileSettings');
}

async function handleAdminEntry() {
  /* 管理者后台设置对所有用户开放 */
  switchPage('admin');
}

function toggleDropdown(el) {
  if (!el) return;
  const open = el.classList.contains('open');
  closeDropdown(el);
  if (!open) el.classList.add('open');
}

function closeDropdown(el) {
  if (!el) return;
  el.classList.remove('open');
}

function bindJump(id, url) {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener('click', () => { location.href = url; });
}

function renderNewMenu() {
  const container = document.getElementById('newDropdown');
  const list = newMenuItems
    .map((item) => {
      const icon = item.label.includes('绘图') ? icons.file : item.label.includes('知识') ? icons.book : icons.upload;
      return `<button data-page="${item.page}">${icon}${item.label}</button>`;
    })
    .join('');
  container.innerHTML = list;
}

/* ===== user.js ===== */
/**
 * 用户数据层：基于 GitHub 仓库的 users 目录
 *  - users/_index.txt         用户索引（快速登录定位）
 *  - users/<userId>/info.json 用户数据（含 stats / whitelist / blacklist / devices）
 *  - users/<userId>/private/  头像隐私目录
 *  - users/<userId>/projects/ 云端项目
 */





const SESSION_KEY = 'fnplt_mine_session';
const PLOTTER_SESSION_LS = 'fnplt_session_ls'; // 函数绘制器「记住我」会话
const PLOTTER_SESSION_SS = 'fnplt_session_ss'; // 函数绘制器「临时」会话
const SESSION_TTL = 2 * 24 * 3600 * 1000; // 2 天
const MAX_DEVICES = 30;

let lastIp = '';

/* ---------- 索引文件 ---------- */
/* 行格式：userId|name|folder|ip|registeredAt */
function parseIndex(text) {
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

function indexLine(rec) {
  return [rec.id, rec.name, rec.folder, rec.ip || '', rec.registeredAt || 0].join('|');
}

async function readIndex(cfg) {
  const text = await ghRead(cfg, buildPath(cfg.usersRoot, '_index.txt'));
  return parseIndex(text);
}

async function writeIndex(cfg, map) {
  const lines = Object.keys(map).map((k) => indexLine(map[k]));
  await ghWrite(cfg, buildPath(cfg.usersRoot, '_index.txt'), lines.join('\n'), 'Update user index');
}

/* ---------- 用户数据 ---------- */
function userFolder(cfg, userId) {
  return buildPath(cfg.usersRoot, String(userId));
}

function infoPath(cfg, userId) {
  return buildPath(cfg.usersRoot, String(userId), 'info.json');
}

async function readUser(cfg, userId) {
  const raw = await ghRead(cfg, infoPath(cfg, userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function writeUser(cfg, user) {
  await ghWrite(cfg, infoPath(cfg, user.id), JSON.stringify(user, null, 2), 'Update user ' + user.id);
  await dbUserSync(user);
}

/* 邮箱反查用户：读优先点鸭 users 表（email 字段），失败/空回退遍历 GitHub users 目录下各 info.json */
async function findUserByEmail(email) {
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
async function getClientIP() {
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
function setSession(userId, remember, userSnapshot) {
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

function getSession() {
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

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(PLOTTER_SESSION_LS);
    sessionStorage.removeItem(PLOTTER_SESSION_SS);
  } catch (e) {}
}

function isLoggedIn() {
  return !!getSession();
}

function getCurrentUser() {
  const s = getSession();
  return s ? s.user || null : null;
}

/* 登录后从仓库同步最新 info.json */
async function refreshUser() {
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

function validateName(name) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) throw new Error('昵称不能为空');
  return n;
}

function validatePassword(pw) {
  const p = String(pw || '');
  if (p.length < 6) throw new Error('密码至少 6 位');
  return p;
}

async function register(name, password, remember, email, code) {
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

async function login(userIdOrEmail, password, remember) {
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
async function appendUploadLog(cfg, userId, entry) {
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

async function changeName(newName) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  const n = validateName(newName);
  return updateUser(s.userId, { name: n });
}

async function changePassword(oldPw, newPw) {
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

async function setWhitelist(list) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  const arr = (list || []).map((x) => String(x).trim()).filter(Boolean);
  return updateUser(s.userId, { whitelist: arr });
}

async function setBlacklist(list) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  const arr = (list || []).map((x) => String(x).trim()).filter(Boolean);
  return updateUser(s.userId, { blacklist: arr });
}

/* 绑定 / 换绑邮箱：校验验证码由 UI 层完成，此处做唯一性与写入（允许当前用户重复绑定=换绑） */
async function bindEmail(email) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  const e = validateEmail(email);
  if (!mailEnabled()) throw new Error('邮件验证码服务未配置，无法绑定邮箱');
  const dup = await findUserByEmail(e);
  if (dup && dup.userId !== s.userId) throw new Error('该邮箱已被其他账号绑定，请更换邮箱');
  return updateUser(s.userId, { email: e, emailBoundAt: Date.now() });
}

/* 上传头像：写入 <usersRoot>/<userId>/private/avatar.ext（借鉴 auth.js uploadAvatar） */
async function uploadAvatar(file) {
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
async function setAvatarPath(path) {
  const s = getSession();
  if (!s || !s.userId) throw new Error('未登录');
  return updateUser(s.userId, { avatar: String(path || ''), avatarUpdated: Date.now() });
}

/* 注销账户：真实删除仓库数据（info.json + private/ + projects/ + 公开作品 + 索引记录） */
async function deleteAccount() {
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
async function getStats(user) {
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

function isAdminUser(user) {
  return !!(user && (user.role === 'admin' || user.role === '管理员'));
}

/* ===== utils.js ===== */
function toast(message) {
  const wrap = document.getElementById('toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 320);
  }, 2200);
}

/* 底部浮层提示（区别于顶部 toast，用于加载中反复点击等场景） */
const BOTTOM_TIP = 'ฅ´•̀ω•́`ฅ~不要再点啦~ฅ´•̀ω•́`ฅ';
function bottomTip(message) {
  const wrap = document.getElementById('bottomTipWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'bottom-tip';
  el.textContent = message || BOTTOM_TIP;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 320);
  }, 1800);
}

/* 按钮忙态：禁用并显示加载文案，返回恢复函数（防频繁触发 + 加载提示） */
function busyButton(btn, busyText) {
  if (!btn) return () => {};
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText || '处理中…';
  return () => {
    btn.disabled = false;
    btn.textContent = orig;
  };
}

/* 统一的数据加载失败提示（数据加载类失败统一使用此文案） */
const ERR_MSG = '服务器超时啦～ฅ(´・̥ω・̥`)ฅ';

/* 骨架屏：向容器写入 count 个骨架块。cls 为块的尺寸类（如 sk-card / sk-row） */
function showSkeleton(container, count, cls) {
  if (!container) return;
  const blocks = new Array(Math.max(1, count || 3))
    .fill(0)
    .map(() => `<div class="skeleton ${cls || 'sk-card'}"></div>`)
    .join('');
  container.innerHTML = `<div class="skeleton-wrap">${blocks}</div>`;
}

/* 骨架屏加载工具：loading 期间显示骨架，完成后写入真实内容，返回 success */
async function withSkeleton(container, count, cls, task) {
  showSkeleton(container, count, cls);
  try {
    const html = await task();
    if (container) container.innerHTML = html;
    return true;
  } catch (e) {
    if (container) container.innerHTML = '';
    throw e;
  }
}

/* ===== bootstrap.js (引导) ===== */
initTopNav();
initSidebar();
initPages();
initAdmin();
initAiPanel();
initAuthUI();
initProfileSettings();
initPullRefresh();
initDevices();
initProjects();
initGallery();
initMusicPanel();

/* 个人资料页变更后统一刷新所有用户相关 UI */
setProfileHooks(
  (user) => {
    updateNavUser(user);
    renderUserUI(user);
    refreshStats(user);
    setSidebarAdminVisibility(true);
  },
  (pageId) => switchPage(pageId)
);

/* 登录成功后统一刷新所有用户相关 UI */
setAuthSuccessHandler(async (user) => {
  updateNavUser(user);
  renderUserUI(user);
  refreshStats(user);
  setSidebarAdminVisibility(true);
  switchPage('profile');
  toast('欢迎回来，' + (user.name || '') + '');
});

/* 初始化：恢复会话并按用户数据更新 UI */
async function bootstrap() {
  let user = getCurrentUser();

  if (user && hasConfig()) {
    /* 异步从仓库同步最新 info.json */
    const fresh = await refreshUser().catch(() => null);
    if (fresh) user = fresh;
  }

  updateNavUser(user);
  renderUserUI(user);
  refreshStats(user);
  /* 管理者后台设置对所有用户开放 */
  setSidebarAdminVisibility(true);

  if (!user && !hasConfig()) {
    /* 未配置仓库：引导配置 */
    setTimeout(() => toast('尚未配置 GitHub 仓库，可在 管理者设置 中对接'), 800);
  } else if (!user) {
    /* 已配置仓库但未登录：提示登录 */
    setTimeout(() => {
      toast('已检测到 GitHub 仓库，点击右上角「登录 / 注册」进入');
    }, 800);
  }
}

/* 顶部“我的”始终为个人信息页，登录后若停留在占位页则回到个人信息 */
bootstrap();

