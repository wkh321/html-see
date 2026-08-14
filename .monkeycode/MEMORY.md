# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-08-08
- Context: Discovered by Agent while fixing the clamp redeclaration build failure and re-running smoke tests
- Category: Build Methods | Testing Methods | Troubleshooting & Debugging
- Instructions:
  - 本项目是非构建工具单页应用：源码为 `js/*.js`（ES Module，含 `bootstrap.js` 引导）与 `css/*.css`，通过 `/tmp/opencode/build.mjs` 合并生成 `js/app.js` 与 `css/style.css`（`index.html` 只引用这两个产物）。
  - 构建命令：`node /tmp/opencode/build.mjs <输出目录>`（合并 JS 去除 import/export，import 状态机整块删除、export 仅剥离关键字保留声明；文件按字母序 + bootstrap.js 置尾，文件间加 `/* ===== name.js ===== */` 标记；CSS 顺序为显式依赖顺序：variables/base/components/topnav/sidebar/profile/profile-settings/devices/auth/ai-panel/admin/projects/gallery/music-player）。验证产物正确性用「输出到临时目录再与工作区 diff」方式，勿手改 js/app.js。
  - 冒烟测试（jsdom 29 已全局安装，路径 `/usr/local/lib/node_modules/jsdom`，Node v22）：历史的全量 `smoke.mjs` 与 `build.sh` 已丢失，按上述两条重建；下文旧条目中关于 smoke.mjs 的 fetch mock 技巧（URL 编码中文路径、rate_limit mock、delayPath 捕捉瞬时状态、DbsApi 按 table 独立实例、mail 验证码分支）仍适用于新测试的 mock 实现。
    - 门户侧：`node /tmp/opencode/portal-smoke.mjs`（index.html + js/app.js 用 vm.runInContext 执行，验证 boot、plotterOpenUrl/onOpenProject/onOpenWork 跳转参数；需要 localStorage 预置 `fnplt_gh_config_v2` 与 `fnplt_mine_session`）。
    - 绘制器侧：`node /tmp/opencode/plotter-ext-test.mjs`（jsdom 不加载外部 `<script>`，必须 runScripts:'outside-only' 再按序 vm.runInContext dbs-all/dbs-users/auth/script/mdeditor；断言用 vm.runInContext 读顶层 let/const；覆盖 9 个场景：ID 直开、旧链接升级、new=1、残缺链接锁屏、云端打开同步地址栏、保存新项目、新建清空上下文、cloud-modal UI+30s 超时、外部保存写回原文件夹）。
  - 历史坑：模块文件顶层出现同名声明会在合并时冲突。已处理三处——`devices.js` 的 `clamp` 改为 `dvcClamp`（遵循 dvc 前缀约定），`projects.js` 的 `esc` 改为 `projEsc`，`music-panel.js` 的 `fmtTime` 改为 `mpFmtTime`（与 devices.js 冲突）。新增模块时避免与既有模块使用相同顶层 `const/function` 名。
  - 构建产物 `js/app.js` 由脚本生成，勿手改；源码改动后必须重跑 build.mjs 并复跑 portal-smoke.mjs 与 plotter-ext-test.mjs。
  - 预览环境只暴露一个端口，静态站点用 `python3 -m http.server 8000` 后台启动后走 `request_preview`。

[Project Knowledge Summary]
- Date: 2026-08-09
- Context: Discovered by Agent while implementing the music player based on user-provided API doc
- Category: Troubleshooting & Debugging | Environment Configuration
- Instructions:
  - 音乐 API（api.bugpk.com，163_music）：GET/POST 均支持，参数 type 必填。`type=song&id=<id>` 返回歌曲详情（data 含 name/singer/picimg，无音频直链）；音频直链需 `type=url&id=<id>`（data.url 可能是字符串或数组，需容错）。`type=search&s=关键词` 可搜索。音质 level：standard/exhigh/lossless/hires/jyeffect/sky/jymaster。
  - 用户提示：若取不到音频 url 说明账号被风控，播放器失败提示文案固定为「获取音乐失败，可能被风控」。
  - 音乐播放器模块 `js/music-panel.js`：`initMusicPanel(force)` 在 bootstrap 注册（force=true 强制重建，管理者「刷新卡片」按钮调用）；无配置/未启用时不渲染；随机播放策略 RANDOM_PICK_LIST=0.65（65% 概率取列表内 ID）；播放器 z-index 10000 层级最高；拖拽与下拉刷新期间 body 加 `music-dragging`/`pull-dragging` 类禁选中文字。
  - 音乐卡片收起/弹出用 `left` 定位（fold 时 `left=-(card.offsetWidth-FOLD_PEEK)`，FOLD_PEEK=24 露左缘），拖拽记录 `mp.lastX` 供弹出还原；曾用 transform translateX 折叠导致卡片拖到屏幕中央后无法移出屏幕——横向位移不可用 transform，必须直接改 left。
  - 文件处理状态 `js/filestatus.js`：`recordFileStatus(type,name,status)` 把上传/操作记录追加到 `<usersRoot>/<userId>/file-status.log`（行格式 `ISO时间\t类型\t作品名\t状态`），`openFileStatusPage()` 渲染「文件处理状态」页（复用 admin-table 样式）。已接入 projects.js 分享（类型「项目」/「分享」）与 user.js 头像上传。合并产物中所有模块函数都是全局的，user.js 可直接调用 recordFileStatus 而无需 import（避免 filestatus↔user 循环 import）。

[Project Knowledge Summary]
- Date: 2026-08-10
- Context: Discovered by Agent while implementing the public works gallery (公开作品广场)
- Category: Troubleshooting & Debugging | Build Methods
- Instructions:
  - 公开作品广场 `js/gallery.js`（`openGalleryPage()`，bootstrap 注册 `initGallery()`）：遍历 `shareRoot/<userId>/share/works.json` 分享索引（条目含 path/name/desc/category/tags/updatedAt，path 为作品相对路径 `users/<uid>/projects/<folder>`）。默认排序=目录名顺序，最新=updatedAt 倒序；工具条分类来自 data.js 的 `GAL_CATEGORIES`（一次函数/二次函数/反比例函数/动画/旋转/全部）。第二个卡片每行 4 个（grid repeat(4,1fr)）、纵向滚动、鼠标左键拖拽（`setupGalDrag`，body.gal-dragging 禁选中）。
  - GitHub API 路径为 URL 编码：smoke.mjs 的 ghMap mock key 含中文目录时必须用 `encodeURIComponent` 编码（如 `share/u1/` + encodeURIComponent('作品A') + `/info.json`），否则 `new URL(url).pathname` 匹配不上返回 404。

[Project Knowledge Summary]
- Date: 2026-08-11
- Context: Discovered by Agent while refactoring share logic (分享逻辑整改：share 不再复制作品文件)
- Category: Troubleshooting & Debugging | Workflow & Collaboration
- Instructions:
  - 分享索引整改：`js/share.js` 管理每用户分享索引 `<shareRoot>/<userId>/share/works.json`（单个 JSON 存多作品：`{ [作品folder]: { path, name, desc, category, tags, updatedAt } }`，path 为仓库内相对路径 `users/<uid>/projects/<folder>`）。分享/取消=改索引 + 双写项目 info.json 的 shared 字段（`shareWork`/`unshareWork`/`listMyWorks`/`readShareIndex`/`writeShareIndex`/`entryFromMeta`），`SHARE_INTERVAL=600`。
  - 「我的项目」单卡分享/取消（onToggleShare）：处理中 `setShareBusy(true)` 禁用所有 `.proj-share` 按钮，完成恢复；批量分享/取消（runBatchShare）：勾选卡片 `.proj-check` 后顶部批量栏出现，先 `checkRateLimit`（github.js，查 `/rate_limit` 的 resources.core.remaining）按需量 N*3+2 判断不足即中止，再队列逐个写 info.json（每写间隔 SHARE_INTERVAL=600ms 防 GitHub API 限流），索引 works.json 一次性写回；批量处理中禁用批量栏按钮与勾选框。
  - 注销清理（user.js deleteUser）与动态统计（getStats sharedWorks 条目数）已适配新索引；旧 `shareRoot/<uid>/<作品目录>/` 复制结构仅在注销时兼容清理（跳过 'share' 目录）。
  - smoke.mjs：rate_limit 需在 fetchMock 中 mock（返回 resources.core 剩余额度）；PUT 记录到 putLog 供断言 works.json/info.json 双写与节流间隔（时间戳比较用 `Date.now()` 值，勿用数组长度）；用 `delayPath` 给指定路径请求加 2s 延迟以捕捉「单卡分享进行中禁用其他按钮」的瞬时状态（mock 响应太快会错过禁用态）。

[Project Knowledge Summary]
- Date: 2026-08-11
- Context: Discovered by Agent while integrating 点鸭数据表 as a log/record table coexisting with GitHub storage
- Category: Build Methods | Operations & Deployment | Troubleshooting & Debugging
- Instructions:
  - 点鸭数据表接入：`js/dbs-all.js`（用户提供的 194KB 封装，暴露 `window.DbsApi`）以独立 `<script>` 在 index.html 引入，构建脚本 build.mjs 合并 JS 时排除 `dbs-all.js`（`f !== 'dbs-all.js'`）；配置存 localStorage cfg.db = { enabled, configUrl }（configUrl 留空则用 dbs-all.js 内置配置，填了则 `DbsApi.init({ configUrl })` 动态加载配置类）。
  - 数据表接入层 `js/dbstable.js`（会被合并进 app.js）：`dbEnabled()`（需 cfg.db.enabled 且 window.DbsApi 存在）、`getDb()`（懒加载缓存 Promise）、`dbTest`/`dbGetFields`/`dbQuery`/`dbInsert`/`dbUpdate`/`dbRemove`，业务封装 `dbAppendLog(type,userId,name,status,detail)` 与 `dbQueryLogs(type,userId,limit)`（filter 用 SQL 风格 `type='file_status' AND user_id='u1'`，单引号内引号需转义，sort='createdAt DESC'）。
  - 记录表字段（用户需在点鸭后台添加，id 已有）：type / user_id / name / status / detail（detail 存 JSON 文本，如作品类型）；createdAt/updatedAt 系统自动。
  - 数据同步策略：记录表与 GitHub 共存双写、读取优先数据表。`recordFileStatus`（filestatus.js）与 `appendUploadLog`（user.js）在写 GitHub 前先 `dbAppendLog`（失败静默，GitHub 为权威存储）；`getFileStatusList` 优先 `dbQueryLogs`，有数据即返回，失败/空回退 GitHub。
  - 管理者设置新增「点鸭数据表」tab（data.js adminTabs + icons.database）：配置面板（启用开关/admDbConfigUrl/保存/连接测试/查看字段 admDbFields）+ 后台操作区（查询 admDbQFilter+admDbQLimit / 插入 admDbIType 等 / 更新 admDbUFilter+JSON / 删除 admDbDFilter 带 confirm），结果渲染到 admDbResult。
  - 冒烟测试：boot() 支持 `dbsMock` 参数挂 `window.DbsApi`（mock 需实现 init/info/getFields/query/insert/update/remove，filter 用正则 `([A-Za-z0-9_]+)\s*=\s*'([^']*)'` 匹配）；数据表启用时验证配置保存/连接测试/后台操作/双写/读优先。文件处理状态页仍有 REPO_DELAY=2500ms 切页延迟，断言需 sleep 2600（即使走数据表读）。

[Project Knowledge Summary]
- Date: 2026-08-11
- Context: Discovered by Agent while integrating 点鸭用户表 as a second table (双表共存：记录表 logs + 用户表 users)
- Category: Build Methods | Operations & Deployment | Troubleshooting & Debugging
- Instructions:
  - 用户表接口文件 `/workspace/js/dbs-users.js`（增强版 DbsApi，数据表 users）同样以独立 `<script>` 引入，且必须放在 dbs-all.js 之后（两文件都挂 `window.DbsApi`，后加载覆盖，属预期）；build.mjs 排除列表为 `f !== 'dbs-all.js' && f !== 'dbs-users.js'`。index.html 顺序：dbs-all.js → dbs-users.js → app.js。
  - cfg.db 现为双表结构 `{ logs:{enabled,configUrl}, users:{enabled,configUrl} }`；旧 `{enabled,configUrl}` 由 `normalizeDbCfg` 自动迁移为 logs/users 双配置。configUrl 留空用内置（table 模式），填了则 `DbsApi.init({configUrl})`——双表都用 configUrl 会互相覆盖 `module.exports`，因此默认建议用内置。
  - 双表接入层：`js/dbstable.js` 定义 `DB_TABLES={LOGS:'logs',USERS:'users'}`；`ensureConfigPool()` 把 dbs-all.js 写入 `window.module.exports` 的内置配置搬进 `window.__dbsConfigs['logs']`（增强版 DbsApi `init({table})` 从该池取数）；`getDb(table)` 按表名缓存实例、无 configUrl 时 `DbsApi.init({table})`；新增 `resetDb()` 清缓存（换 configUrl 后需调用再测）。dbQuery/dbInsert/dbUpdate/dbRemove 均带 table 参数（默认 LOGS）。
  - 用户表同步 `js/dbusers.js`：`dbUserSync(user)` 按 **user_id**（GitHub 用户 ID）匹配 upsert（匹配键已从 name 改为 user_id；存量按 name 匹配写入的无 user_id 行自动回退补写并补齐 user_id），字段含 name/role/avatar/stats/whitelist/devices/ip/email（stats/whitelist/devices JSON 序列化且 devices<=30 条、email<=120、ip<=100，失败静默），`dbUserGet(userId)` 按 user_id 读，`dbUserFindByEmail(email)` 按 email 小写过滤，`dbUserEnabled()` 检查 cfg.db.users.enabled。user.js `writeUser` 末尾挂 `dbUserSync(user)`（GitHub 仍权威、数据表双写、读取优先数据表）。
  - 用户表字段（用户需在点鸭后台添加，id 已有）：name / role / avatar / stats / whitelist / devices / ip，以及 user_id（GitHub 用户 ID，同步业务键）与 email（邮箱，邮箱登录/反查用）。avatar 只能存链接或截断 base64，图片本体不能存数据表。
  - 管理者设置「点鸭数据表」tab 双表化：顶部 `#admDbSelect` 下拉切换记录表/用户表，双表各自配置块（#admDbCfgLogs/Users）、保存（#admDbSaveLogs/Users）、连接测试（#admDbTestLogs/Users）、字段（#admDbFieldsLogs/Users + Box）、后台操作区（#admDbOpTable 标签随下拉切换）；`collectAdminConfig` 输出双表 cfg.db。css/admin.css 提供 .dbs-* 样式。
  - smoke.mjs：makeDbsMock 的 `init(opts)` 必须为每个 `{table}` 返回**绑定该表的独立实例**（真实 DbsApi 每次 init 新建对象），否则多表共享单一 `_table` 状态会串数据（记录表操作写进用户表等）；assert 时直接断言 `stores.logs.rows`/`stores.users.rows` 与 `initCalls`。

[Project Knowledge Summary]
- Date: 2026-08-11
- Context: Discovered by Agent while adding email system (邮箱登录 / 注册验证码 / 个人资料绑定换绑)
- Category: Operations & Deployment | Build Methods | Troubleshooting & Debugging
- Instructions:
  - 邮箱体系：登录支持邮箱+密码（邮箱是登录别名，反查用户后走原密码链路）；注册在 mail.enabled 时强制邮箱+验证码；个人资料页可绑定/换绑邮箱（换绑=唯一性检查允许自己重复绑定）。`js/mail.js` 是邮件验证码客户端：`mailBase()/mailEnabled()` 读 cfg.mail，`validateEmail()`（正则+120 截断）、`mailPost()`（fetch MailClient.base，失败降级 {ok:false}）、`mailSendCode(email)`（成功保存最近验证码+邮箱）、`mailVerifyCode(email,code)`（需邮箱一致）、`mailClearCode()`。cfg.mail = `{ enabled, base }` 存 localStorage，管理者设置「邮件验证码服务」tab 配置（admMailSave/admMailTest）。
  - 验证码是 Serverless 无状态方案：服务端生成并随响应返回，前端本地保存最近一次验证码比对（用户资料页 sendEmailCode 不先查重防泄题，确认时 bindEmail 内做唯一性检查）。60s 倒计时用 `setCountdown(btn,seconds)` 禁用发送按钮。
  - 邮件服务部署包在 `/workspace/qqmail-vercel/`（api/mail.js + public/qqmail-client.js + package.json + vercel.json，用户上传的 qqmail-vercel 原样保留在 `/tmp/opencode/qqmail/qqmail-vercel/`）。接口 POST /api/mail：action=send（to,title?,content?）/sendCode（to,digits?,expire? 返回 code）/verify；依赖 nodemailer 与 env QQ_MAIL_USER/QQ_MAIL_PASS（QQ 邮箱 SMTP 授权码，发信实测可用）。本地联调：`cd /tmp/opencode/qqmail/qqmail-vercel && QQ_MAIL_USER=... QQ_MAIL_PASS=... node server.js`（包装 res.status/JSON，端口 3000），MailClient.base 填 http://localhost:3000。Vercel 部署：推 GitHub→新建项目 Root 选 qqmail-vercel→配环境变量 QQ_MAIL_USER/QQ_MAIL_PASS→Deploy，上线后 base 填 https://<app>.vercel.app。
  - smoke.mjs：fetchMock 加 `localhost:3000/api/mail` 分支（sendCode 生成验证码推入 mailSentCodes、verify 校验），`mailCodeOf(to)` 取最近验证码；PUT 分支前移到 entry 检查前（GitHub PUT 可新建文件，注册/绑邮箱不预置 ghMap 路径）。测试 GitHub 遍历邮箱反查时，用户目录必须同时出现在 `users/` 目录 items 与 users/_index.txt（listDirs 读目录列表、readIndex 读索引，二者缺一都查不到）。

[Project Knowledge Summary]
- Date: 2026-08-12
- Context: Discovered by Agent while integrating the user-uploaded function plotter (zip) with the portal 我的页面
- Category: Operations & Deployment | Build Methods | Troubleshooting & Debugging
- Instructions:
  - 门户与绘制器对接：用户上传的完整版函数绘制器（index.html/style.css/script.js/auth.js/mdeditor.js，GitHub 存储，配置 key `fnplt_gh_config`、session `fnplt_session_ls/ss`）部署在 `/workspace/plotter/`（与门户同源同端口共享 localStorage，build.mjs 只合并 js/ 目录，plotter/ 不受影响）。门户「我的页面/公开作品」的「打开」按钮跳转 `plotter/index.html?u=<userId>&p=<项目ID>`（projects.js onOpenProject/onOpenWork，URL 用 project.json 的 `_id` 唯一 ID 而非文件夹名，onOpenWork 先读 info.json 的 meta.id、失败回退文件夹名；兼容旧链接 p=文件夹名，绘制器打开后自动升级为 ID）。
  - plotter 外部项目模式（script.js 末尾 IIFE）：URL 带 u/p 时启动后 extOpenProject 读取 `users/<uid>/projects/<folder>/project.json`（applyProjectData）+ question.txt + analysis.txt 自动加载；外部模式下覆盖 window.menuSaveCloud → extSaveProject 写回原项目文件夹（project.json + question.txt + analysis.txt + 保留并更新 info.json 元数据），普通模式保持原云端逻辑。门户项目文件夹格式即 zip 版云端新格式（project.json + question.txt + analysis.txt），project.json 含 `_id=项目文件夹名`。
  - plotter auth.js getConfig 回退：自己的 `fnplt_gh_config` 缺失时读门户 `fnplt_gh_config_v2`（同一 GitHub 配置一次配置两页共用）；脚本内部引用外部模式时勿用顶层 let/const 重复命名（script.js 顶层声明冲突会 SyntaxError），追加模块包 IIFE。
  - 联调验证：`/tmp/opencode/plotter-ext-test.mjs`（jsdom + URL 参数 + vm.runInContext 执行真实脚本 + fetch mock，验证加载/渲染/保存写回；需 stub canvas 2D/katex/marked/math/Worker/requestAnimationFrame，且 localStorage 需预置 `fnplt_gh_config` 否则 extOpen 走「未找到仓库配置」回退）。plotter 页面函数表达式渲染在 `[data-katex]` 属性（katex 渲染），textContent 只有 `#N函数`。预览：plotter 页面在 /plotter/index.html。

[Project Knowledge Summary]
- Date: 2026-08-12
- Context: Discovered by Agent while deploying the merged project to GitHub Pages and fixing email send failures
- Category: Operations & Deployment | Troubleshooting & Debugging
- Instructions:
  - 合并项目已部署 GitHub Pages：仓库 `wkh321/html-see`（main 分支根目录），线上地址 `https://wkh321.github.io/html-see/`（根 index.html = 我的页面，/plotter/ = 函数绘制器）。可上传整理版在 `/workspace/plotter-project/`，.gitignore 忽略 *.zip/.env/node_modules/.vercel/.DS_Store；隐藏文件 .gitignore 与 .monkeycode/ 网页上传时容易漏，需手动补齐。
  - 邮件后端 qqmail-vercel 部署在 Vercel `https://qqmail-vercel.vercel.app`（api/mail.js，env QQ_MAIL_USER/QQ_MAIL_PASS）。前端 `Failed to fetch（目标 .../api/mail）` 是浏览器网络层错误，中国大陆访问 vercel.app 普遍不可达，需换国内可达的 serverless 平台或自有服务器部署 mail.js；mail.js/app.js 的 mailPost catch 已改为输出具体错误+目标地址便于诊断。
  - 门户与绘制器登录态互通：互为回退读取对方会话 key（`fnplt_session_ls/ss` ↔ `fnplt_mine_session`），clearSession 双向清理；ghRequest/ghDelete 均带 20s 超时。

[Project Knowledge Summary]
- Date: 2026-08-14
- Context: Discovered by Agent while reconciling remote (origin/main) 与本地冲突后确定绘制器打开方案演进
- Category: Operations & Deployment | Troubleshooting & Debugging | Workflow & Collaboration
- Instructions:
  - 绘制器打开方案演进（重要，避免未来混淆）：远程曾两度推进「点鸭一次性令牌」方案（368791f 早期 ?t= 校验 + 308548a 强化 ?t=&id=/IP 绑定/刷新重签，配套 `plotter/dbticket.js` 暴露 `window.PlotterTicket.verify` 三参校验+10s withTimeout+`__dbsConfigs['logs']` 回填），后被本地「直开 u/p」方案（6d95a33 → 2a8ad12）取代：URL 用 `?u=<userId>&p=<projectId>`（p 为 project.json 的 `_id` 唯一 ID，兼容旧 p=目录名并自动升级 URL），删除令牌代码（dbticket.js、issueOpenToken、OPEN_TICKET_TTL、getClientIpSafely）。本地 2a8ad12 已包含远程全部旋转功能改进（computeSampleRange 动态采样、segScreenVisible 离屏剔除、圆上点/连线点模式、toLocalMath 命中检测、公转模型），两者差异仅在打开方案本身。
  - 合并教训：当远程与本地在同一批文件上做方向对立的改动时，先做三向 diff（`git diff <远程最新> <本地> -- <file>`）确认差异性质，区分「正交功能增强」与「竞争方案」，再决定取舍，勿盲目 rebase 产生语义错误合并。令牌方案的历史测试脚本（/tmp/opencode/dbticket.test.js、ext-mode.test.js、issue-token.test.mjs）已随方案废弃失效。


