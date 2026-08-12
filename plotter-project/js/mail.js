/**
 * 邮件验证码客户端（对接 Vercel /api/mail 或本地 qqmail-server）：
 *   send  / sendCode / verify
 * 接口域名来自 cfg.mail.base（管理者设置 - 邮件验证码服务 配置），
 * 留空则返回「邮件服务未配置」错误。验证码随 sendCode 响应返回，
 * 前端本地保存用于比对（兼容 Serverless 无状态特性）。
 */
import { getConfig } from './github.js';

export function mailBase() {
  try {
    const cfg = getConfig();
    if (cfg && cfg.mail && cfg.mail.base) return String(cfg.mail.base).trim();
  } catch (e) {}
  return '';
}

export function mailEnabled() {
  try {
    const cfg = getConfig();
    return !!(cfg && cfg.mail && cfg.mail.enabled && cfg.mail.base);
  } catch (e) {
    return false;
  }
}

export function validateEmail(email) {
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
    .catch(() => ({ ok: false, msg: '邮件服务连接失败，请检查域名配置或网络' }));
}

let mailLastCode = null;
let mailLastEmail = '';

/* 发送验证码：成功则保存最近一次验证码供本地比对 */
export async function mailSendCode(email) {
  const r = await mailPost({ action: 'sendCode', to: email, digits: 6 });
  if (r.ok && r.code != null) {
    mailLastCode = String(r.code);
    mailLastEmail = email;
  }
  return r;
}

/* 本地校验：验证码需与最近一次发送且邮箱一致的比对成功 */
export function mailVerifyCode(email, code) {
  return !!(mailLastCode && mailLastEmail === email && String(code) === mailLastCode);
}

export function mailClearCode() {
  mailLastCode = null;
  mailLastEmail = '';
}
