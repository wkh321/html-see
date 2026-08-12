# QQ 邮箱邮件发送（Vercel 版）

把 QQ 邮箱 SMTP 封装成免费、无限期、无休眠的 Serverless 函数，供 GitHub Pages 等**纯静态站点**调用。

## 目录结构

```
qqmail-vercel/
├── api/mail.js            # ★ Serverless 函数（自包含单文件，含发信+验证码逻辑）
├── public/qqmail-client.js# ★ 前端单文件封装（复制到你的网页，1 个文件）
├── public/index.html      # 演示页（可选）
├── package.json
└── vercel.json            # 函数时长上限 60s
```

## 部署步骤（一次性，约 5 分钟）

1. 把本目录（qqmail-vercel）推送到你的 GitHub 仓库
2. 打开 https://vercel.com 用 GitHub 账号登录（免费，无需信用卡）
3. 点「Add New → Project」，导入刚才的仓库
4. 部署前在项目设置里配置**环境变量**：
   - `QQ_MAIL_USER` = 你的QQ邮箱（如 3650403590@qq.com）
   - `QQ_MAIL_PASS` = SMTP 授权码（QQ邮箱设置 → 账号 → 开启 SMTP 服务后生成）
5. 点 Deploy，完成后获得域名 `https://你的项目名.vercel.app`

授权码只存在 Vercel 环境变量里，不会出现在网页代码中。

## 前端接入（复制 1 个文件）

把你的网页里加：

```html
<script src="qqmail-client.js"></script>
<script>
  MailClient.base = 'https://你的项目名.vercel.app';  // 你的 Vercel 域名

  // 发普通邮件
  await MailClient.send({ to: 'xx@163.com', title: '标题', content: '<p>正文</p>' });

  // 发验证码（验证码随响应返回，前端保存后本地校验）
  const r = await MailClient.sendCode({ to: 'xx@163.com', digits: 6 });
  if (r.ok) {
    console.log('验证码', r.code);
    MailClient.verifyCode(r.code);   // true / false
  }
</script>
```

若你的网页与函数部署在同一个 Vercel 项目，`MailClient.base` 可留空（同域）。

## 接口说明

| action | 参数 | 返回 |
| --- | --- | --- |
| `send` | `to, title?, content` | `{ ok, messageId? }` |
| `sendCode` | `to, title?, digits?, expire?` | `{ ok, code?, msg? }` |
| `verify` | `to, code` | `{ ok, msg? }` |

说明：
- 验证码默认 6 位、5 分钟有效；Serverless 无状态，建议前端用 sendCode 返回的 code 本地校验（qqmail-client.js 已内置）
- QQ 免费邮箱有日发信量上限（约 500 封/天），短时间高频发送可能触发风控，请控制节奏
- 也可用 curl 直接测试：`curl -X POST https://你的域名/api/mail -H "Content-Type: application/json" -d '{"action":"send","to":"xx@163.com","content":"hi"}'`
