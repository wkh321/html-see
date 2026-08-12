# 任务需求：QQ 邮箱邮件发送服务部署与网页接入

> 本文档由项目负责人生成，交给负责管理项目的 AI 执行。请按以下步骤逐步完成并自测。

## 一、任务目标

把「QQ 邮箱 SMTP 邮件发送」做成一个 **免费、无限期、不休眠** 的服务，供 GitHub Pages 等**纯静态网页**调用，实现：

1. 发送普通邮件
2. 发送验证码邮件
3. 校验验证码

## 二、背景与约束（必读）

- 网页是纯静态托管（GitHub Pages），**不能运行 Node 后端**。
- 浏览器**无法直接连接 QQ 邮箱 SMTP**（授权码不能暴露在网页代码中）。
- 因此需要一个 **Vercel Serverless 函数** 作为发信中间人：网页 → Vercel 函数 → QQ SMTP → 收件人。
- 发送方邮箱固定为项目所有者的 QQ 邮箱，凭据（授权码）只存在 Vercel 环境变量中。

## 三、文件清单与用途

以下文件已准备好，位于 `qqmail-vercel/` 目录：

| 文件 | 用途 | 放哪里 |
| --- | --- | --- |
| `qqmail-vercel/api/mail.js` | Serverless 函数（自包含：发信+验证码+跨域），处理 send / sendCode / verify 三个 action | 推送到 GitHub，导入 Vercel 部署 |
| `qqmail-vercel/package.json` | 声明 nodemailer 依赖 | 同上 |
| `qqmail-vercel/vercel.json` | 函数最长执行 60s | 同上 |
| `qqmail-vercel/README.md` | 部署说明 | 参考 |
| `qqmail-vercel/public/qqmail-client.js` | 前端单文件封装（调用函数，含本地验证码校验） | **复制 1 个文件**到静态网页项目 |
| `qqmail-vercel/public/index.html` | 演示页（可选） | 可选 |

## 四、需要项目负责人提供的两项信息

1. **Vercel 账号**（用 GitHub 登录，免费）
2. **QQ 邮箱 SMTP 授权码**：
   - 打开 QQ 邮箱网页版 → 设置 → 账号 → 开启「SMTP服务」→ 按提示手机短信验证 → 生成 16 位授权码

> 安全提醒：授权码只填到 Vercel 环境变量，不要写进代码、不要提交到 GitHub 仓库。

## 五、执行步骤

### 第 1 步：创建 GitHub 仓库并推送（网页操作 + 命令行）
1. 打开 https://github.com 并登录（没有则先注册，免费）。
2. 点右上角「+」→「New repository」：
   - Repository name：随意，如 `my-web`（不要勾选初始化 README）
   - 可见性：Public 或 Private 均可
   - 点「Create repository」
3. 把整个项目（含 `qqmail-vercel/` 目录）推送到该仓库。若仓库还没任何提交：
```bash
git init
git add -A
git commit -m "init project"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```
> 注意：项目里的 `qqmail-server/.env` 已被 `.gitignore` 忽略，不会上传，授权码不会泄露。

### 第 2 步：部署到 Vercel（网页操作，约 5 分钟）
1. 打开 https://vercel.com ，点「Sign Up」，用 GitHub 账号登录（免费，无需信用卡）。
2. 进入控制台后点「Add New → Project」（或「Overview」页的「Add New」按钮）。
3. 在弹出的仓库列表里找到第 1 步的仓库，点「Import」。
4. 在配置页：
   - 找到「Root Directory」，点击右侧「Edit」，选择子目录 **`qqmail-vercel`**（这样只部署邮件函数，不部署整个网站）
   - 展开「Environment Variables」区域，添加两个变量：
     - `QQ_MAIL_USER` = 项目所有者的 QQ 邮箱（如 `3650403590@qq.com`）
     - `QQ_MAIL_PASS` = SMTP 授权码（QQ邮箱 → 设置 → 账号 → 开启 SMTP 服务后生成）
   - 其他保持默认
5. 点「Deploy」，等待约 1 分钟。
6. 部署完成后页面会显示域名，形如 `https://<随机名>.vercel.app`，**记录下来**，这是网页要调用的地址。

### 第 3 步：验证函数可用（用 curl）
```bash
# 普通邮件（收件人换成测试邮箱）
curl -X POST https://<项目名>.vercel.app/api/mail \
  -H "Content-Type: application/json" \
  -d '{"action":"send","to":"测试邮箱@xx.com","title":"测试","content":"<p>你好</p>"}'
# 期望返回：{"ok":true,"messageId":"..."}

# 验证码邮件
curl -X POST https://<项目名>.vercel.app/api/mail \
  -H "Content-Type: application/json" \
  -d '{"action":"sendCode","to":"测试邮箱@xx.com","digits":6}'
# 期望返回：{"ok":true,"code":"6位数字","messageId":"..."}
```

### 第 4 步：网页接入（复制 1 个文件）
1. 把 `qqmail-vercel/public/qqmail-client.js` 复制到静态网页项目。
2. 在网页中引入并配置：
```html
<script src="qqmail-client.js"></script>
<script>
  MailClient.base = 'https://<项目名>.vercel.app';  // 实际 Vercel 域名

  // 发普通邮件
  await MailClient.send({ to: '收件人@xx.com', title: '标题', content: '<p>正文</p>' });

  // 发验证码（验证码随响应返回，前端保存后本地校验）
  const r = await MailClient.sendCode({ to: '收件人@xx.com', digits: 6 });
  if (r.ok) {
    console.log('验证码：', r.code);
    MailClient.verifyCode(r.code);  // true / false
  }
</script>
```
3. 若网页与函数部署在同一个 Vercel 项目，`MailClient.base` 可留空（同域）。
4. 若接入 GitHub Pages：把网页推送到 GitHub 仓库的 `gh-pages` 分支或启用 Pages 功能，域名形如 `https://<用户名>.github.io/<仓库名>/`。

## 六、接口规范（供前端调用参考）

统一 POST 到 `https://<项目名>.vercel.app/api/mail`，请求体带 `action`：

| action | 请求体字段 | 返回 |
| --- | --- | --- |
| `send` | `to, title?, content` | `{ ok, messageId? }` |
| `sendCode` | `to, title?, digits?, expire?` | `{ ok, code?, msg? }` |
| `verify` | `to, code` | `{ ok, msg? }` |

- 验证码默认 6 位、5 分钟有效。
- 函数已设置 CORS 跨域头（`Access-Control-Allow-Origin: *`），静态网页可直接调用。

## 七、注意事项

1. QQ 免费邮箱有**日发信量上限**（约 500 封/天，新号更少），短时间高频发送会触发风控临时拦截，请控制发送节奏。
2. Serverless 函数为无状态，多实例/冷启动时服务端验证码可能丢失，因此前端使用 `sendCode` 返回的 `code` 进行本地校验（`qqmail-client.js` 已内置）。
3. 授权码属于敏感信息：**只填 Vercel 环境变量**，不要提交进仓库。

## 八、验收标准

- [ ] `curl` 测试 send / sendCode 均返回 `ok:true`，收件人实际收到邮件
- [ ] 验证码邮件内容显示正确位数验证码
- [ ] GitHub Pages 网页从浏览器调用成功（无跨域报错）
- [ ] 前端 `MailClient.verifyCode` 校验正确/错误码结果正确
