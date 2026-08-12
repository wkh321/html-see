/**
 * ============================================================
 * api/mail.js — QQ 邮箱 SMTP 发送 Serverless 函数（Vercel）
 * ============================================================
 * 自包含单文件，处理三种 action：
 *   POST { action:'send',     to, title?, content }
 *   POST { action:'sendCode', to, title?, digits?, expire? }
 *   POST { action:'verify',   to, code }
 * 返回 { ok:boolean, msg?, code? }
 *
 * 环境变量（Vercel 项目设置 -> Environment Variables）：
 *   QQ_MAIL_USER = 你的QQ邮箱
 *   QQ_MAIL_PASS = SMTP 授权码（QQ邮箱设置里开启 SMTP 后生成）
 * ============================================================
 */
const nodemailer = require('nodemailer');

const USER = process.env.QQ_MAIL_USER;
const PASS = process.env.QQ_MAIL_PASS;

// 验证码内存存储：单实例下可用；冷启动/多实例时会丢失，
// 因此 sendCode 同时返回 code，前端可自行保存用于本地校验。
const codes = new Map();

function transport() {
  if (!USER || !PASS) throw new Error('未配置 QQ_MAIL_USER / QQ_MAIL_PASS 环境变量');
  return nodemailer.createTransport({
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    auth: { user: USER, pass: PASS }
  });
}

function genCode(digits) {
  digits = Number(digits) || 6;
  let max = 10, min = 1;
  for (let i = 0; i < digits - 1; i++) { min *= 10; max *= 10; }
  return String(Math.floor(Math.random() * ((max - 1) - min + 1)) + min);
}

async function sendMail(to, subject, html) {
  const info = await transport().sendMail({
    from: `"QQ邮箱发送" <${USER}>`,
    to,
    subject,
    html
  });
  return { ok: true, messageId: info.messageId };
}

function sendCodeHtml(code, expireMin) {
  return (
    '<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;border:1px solid #e5e5e5;border-radius:8px">' +
    '<h3 style="margin-top:0">验证码</h3>' +
    '<p style="font-size:32px;font-weight:bold;letter-spacing:4px;color:#07c160">' + code + '</p>' +
    '<p style="color:#888">' + expireMin + ' 分钟内有效，请勿泄露。</p></div>'
  );
}

module.exports = async function handler(req, res) {
  // 允许 GitHub Pages 等任意来源跨域调用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, msg: '仅支持 POST' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const action = body.action;

  try {
    if (action === 'send') {
      if (!body.to || !body.content) return res.json({ ok: false, msg: '缺少 to 或 content' });
      return res.json(await sendMail(body.to, body.title || '无标题', body.content));
    }

    if (action === 'sendCode') {
      if (!body.to) return res.json({ ok: false, msg: '缺少 to' });
      const code = genCode(body.digits);
      const expireMin = body.expire || 5;
      const r = await sendMail(body.to, body.title || '你的验证码', sendCodeHtml(code, expireMin));
      if (r.ok) {
        codes.set(body.to, { code, expireAt: Date.now() + expireMin * 60 * 1000 });
        r.code = code;
      }
      return res.json(r);
    }

    if (action === 'verify') {
      if (!body.to || body.code == null) return res.json({ ok: false, msg: '缺少 to 或 code' });
      const rec = codes.get(body.to);
      if (!rec) return res.json({ ok: false, msg: '该邮箱未发送过验证码' });
      if (Date.now() > rec.expireAt) {
        codes.delete(body.to);
        return res.json({ ok: false, msg: '验证码已过期' });
      }
      if (String(body.code) === rec.code) {
        codes.delete(body.to);
        return res.json({ ok: true });
      }
      return res.json({ ok: false, msg: '验证码错误' });
    }

    return res.json({ ok: false, msg: '未知 action，应为 send / sendCode / verify' });
  } catch (e) {
    return res.json({ ok: false, msg: e.message });
  }
};
