/* 点鸭令牌校验模块（plotter 外部项目打开验证）
 *
 * 门户「我的项目 / 公开作品」打开项目时，若点鸭 logs 记录表已启用，会签发一次性令牌：
 *   type='open_ticket'、user_id=<uid>、name=<token>、status='active'、
 *   detail=JSON { folder, exp, ip }，并把 URL 组装为 plotter/index.html?t=<token>&id=<folder>
 *   —— URL 不再嵌套 u/p，防止用户篡改参数越权读取他人项目。
 *
 * 本模块在绘制器页面向点鸭校验令牌：验证记录存在、status=active、未过期、detail.folder 与
 * 链接 id 参数一致、签发时绑定的 IP 与当前请求 IP 一致后，返回 { u, p, exp }，
 * 把 status 标记为 consumed 并立即删除该令牌记录（一次性消费）。
 * 删除失败不影响放行（status 已置 consumed，重复校验会被拒绝）。
 *
 * IP 绑定规则：detail 无 ip 时首次校验拿到当前 IP 则写入绑定；拿不到当前 IP 且已绑定 → 拒绝。
 *
 * 刷新页面重开同一链接时令牌已被消费 → 校验失败 → 锁屏，需从门户重新打开，防止复制链接越权。
 */
(function (global) {
  'use strict';

  var CFG_KEY = 'fnplt_gh_config_v2';
  var TOKEN_TYPE = 'open_ticket';
  var VERIFY_TIMEOUT = 10000;

  function withTimeout(promise, ms) {
    // 防止 DbsApi 依赖（jquery/pgdbs/配置类）加载卡死导致页面"无反应"：
    // 超时后按 { timeout:true } 处理，让页面明确提示而不是无限等待。
    return Promise.race([
      promise,
      new Promise(function (resolve) {
        setTimeout(function () { resolve({ timeout: true }); }, ms);
      })
    ]);
  }

  function readCfg() {
    try {
      return JSON.parse(localStorage.getItem(CFG_KEY) || 'null')
        || JSON.parse(localStorage.getItem('fnplt_gh_config') || 'null');
    } catch (e) { return null; }
  }

  function normalizeDbCfg(cfg) {
    var d = (cfg && cfg.db) || {};
    if (typeof d.enabled === 'boolean') {
      var legacy = { enabled: d.enabled, configUrl: d.configUrl || '' };
      delete d.enabled;
      delete d.configUrl;
      if (!d.logs) d.logs = legacy;
    }
    if (!d.logs) d.logs = { enabled: false, configUrl: '' };
    return d.logs;
  }

  function escVal(v) {
    return String(v == null ? '' : v).replace(/'/g, "''");
  }

  function getLogsDb() {
    var logs = normalizeDbCfg(readCfg());
    if (!logs.enabled || !global.DbsApi) return Promise.reject(new Error('点鸭数据表未启用'));
    // 兼容 dbs-all.js 的 logs 配置：dbs-all.js 会把 logs 配置类写入
    // window.module.exports，但本页面实际生效的 DbsApi（dbs-users.js）只从
    // window.__dbsConfigs[table] 读取。若缺 logs 配置，init({table:'logs'})
    // 会回退到单键 users 配置去查 open_ticket，导致令牌永远校验失败。
    var pool = global.__dbsConfigs;
    var mod = global.module && global.module.exports;
    if (pool && mod && Object.keys(mod).length && Object.keys(pool).indexOf('logs') === -1) {
      pool['logs'] = { exports: mod };
    }
    if (logs.configUrl) return global.DbsApi.init({ configUrl: logs.configUrl });
    return global.DbsApi.init({ table: 'logs' });
  }

  function rowFilter(token) {
    return "type='" + escVal(TOKEN_TYPE) + "' AND name='" + escVal(token) + "'";
  }

  /* 解析当前请求方 IP。getIp 由调用方传入（绘制器复用 UserAuth.getClientIP）；
   * 未传或获取失败返回空字符串。 */
  function resolveIp(getIp) {
    if (typeof getIp !== 'function') return Promise.resolve('');
    return Promise.resolve().then(getIp).then(function (ip) {
      return String(ip == null ? '' : ip).trim();
    }).catch(function () { return ''; });
  }

  /* 校验并一次性消费令牌。返回 Promise<{u,p,exp}|null|{timeout:true}>；
   * 无效 / 已消费 / 项目不符 / IP 不符 / 校验失败返回 null，校验流程超时返回 {timeout:true}。
   * 全部逻辑包在 Promise.resolve().then() 内执行，杜绝 DbsApi 依赖同步 throw 冒泡到调用方。 */
  function verify(token, projectId, getIp) {
    if (!token || !projectId) return Promise.resolve(null);
    return withTimeout(
      Promise.resolve().then(function () {
        return verifyInner(token, String(projectId || ''), getIp);
      }),
      VERIFY_TIMEOUT
    );
  }

  function verifyInner(token, projectId, getIp) {
    var db;
    return Promise.resolve()
      .then(function () { return getLogsDb(); })
      .then(function (d) {
        db = d;
        return db.query({ fields: '', sort: '', filter: rowFilter(token), page: 1, limit: 10 });
      })
      .then(function (json) {
        if (!json || json.code !== 200) return null;
        var row = (json.fields || [])[0];
        if (!row || row.status !== 'active') return null;
        var detail = {};
        try { detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : (row.detail || {}); } catch (e) {}
        var exp = Number(detail.exp) || 0;
        if (!exp || Date.now() > exp) return null;
        if (String(detail.folder || '') !== String(projectId || '')) return null;
        var u = String(row.user_id || '');
        var p = String(detail.folder || '');
        if (!u || !p) return null;
        return resolveIp(getIp).then(function (ip) {
          var boundIp = String(detail.ip || '').trim();
          var updates = { status: 'consumed' };
          if (boundIp) {
            // 已绑定 IP：必须与当前 IP 一致；获取不到当前 IP 或 IP 不同一律拒绝
            if (!ip || ip !== boundIp) return null;
          } else if (ip) {
            // 未绑定：首次校验拿到 IP 则随消费一并写入绑定
            updates.detail = JSON.stringify({ folder: String(projectId || ''), exp: exp, ip: ip });
          }
          return db.update(rowFilter(token), updates).then(function (res) {
            if (!res || res.code !== 200) return null;
            consumeCleanup(db, token);
            return { u: u, p: p, exp: exp };
          });
        });
      })
      .catch(function () { return null; });
  }

  function consumeCleanup(db, token) {
    // 一次性消费后立即清理该令牌记录，避免数据库残留过期令牌。
    // 删除失败不影响放行（status 已置 consumed，重复校验会被拒绝）。
    try { db.remove(rowFilter(token)).catch(function () {}); } catch (e) {}
  }

  global.PlotterTicket = {
    verify: verify,
    normalizeDbCfg: normalizeDbCfg,
    TOKEN_TYPE: TOKEN_TYPE,
  };
})(window);
