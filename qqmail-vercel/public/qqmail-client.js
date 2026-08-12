/**
 * ============================================================
 * qqmail-client.js — QQ 邮箱发送 前端函数封装（浏览器）
 * ============================================================
 * 调用 Vercel 部署的 /api/mail 接口（send / sendCode / verify）。
 * 无任何外部依赖，只依赖原生 fetch。已处理跨域（后端返回 CORS 头）。
 *
 * 用法：
 *   <script src="qqmail-client.js"></script>
 *   <script>
 *     // 改成你自己的 Vercel 域名（部署后获得，如 https://xxx.vercel.app）
 *     MailClient.base = 'https://xxx.vercel.app';
 *
 *     await MailClient.send({ to: 'xx@163.com', title: '标题', content: '<p>正文</p>' });
 *
 *     const r = await MailClient.sendCode({ to: 'xx@163.com', digits: 6 });
 *     if (r.ok) {
 *       r.code;                       // 本次验证码（前端保存，用于本地校验）
 *       MailClient.verifyCode(r.code); // true / false
 *     }
 *   </script>
 *
 * 验证码说明：sendCode 会把验证码随响应返回。为兼容 Serverless 无状态
 * 特性，前端默认使用本地校验（保存最近一次验证码对比）。
 * ============================================================
 */
(function (global) {
  'use strict';

  function post(data) {
    return fetch(global.MailClient.base + '/api/mail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  var MailClient = {
    base: '',

    /** 发送普通邮件 { to, title?, content } -> { ok, msg?, messageId? } */
    send: function (opts) {
      return post({
        action: 'send',
        to: opts.to, title: opts.title, content: opts.content
      });
    },

    /** 发送验证码 { to, title?, digits?, expire? } -> { ok, msg?, code? } */
    sendCode: function (opts) {
      return post({
        action: 'sendCode',
        to: opts.to, title: opts.title, digits: opts.digits, expire: opts.expire
      }).then(function (json) {
        if (json.ok && json.code != null) global.MailClient._lastCode = String(json.code);
        return json;
      });
    },

    /** 本地校验最近一次验证码 { code } -> boolean */
    verifyCode: function (input) {
      return global.MailClient._lastCode != null && String(input) === global.MailClient._lastCode;
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MailClient;
  }
  global.MailClient = MailClient;
})(typeof window !== 'undefined' ? window : globalThis);
