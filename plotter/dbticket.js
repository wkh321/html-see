/* 点鸭令牌校验模块（plotter 外部项目打开验证）
 *
 * 门户「我的项目 / 公开作品」打开项目时，若点鸭 logs 记录表已启用，会签发一次性令牌：
 *   type='open_ticket'、user_id=<uid>、name=<token>、status='active'、
 *   detail=JSON { folder, exp }，并把 URL 组装为 plotter/index.html?t=<token>
 *   —— URL 不再嵌套 u/p，防止用户篡改参数越权读取他人项目。
 *
 * 本模块在绘制器页面向点鸭校验令牌：验证记录存在、status=active、未过期后，
 * 返回 { u, p, exp } 并把 status 标记为 consumed（一次性消费）。
 *
 * 刷新页面不再走本模块：script.js 会把消费结果缓存到 sessionStorage
 * （刷新保留、关闭页面 / 新开标签页即消失）。关闭后重新打开同一链接时，
 * 令牌已被消费 → 校验失败 → 需从门户重新打开，防止复制链接越权。
 */
(function (global) {
  'use strict';

  var CFG_KEY = 'fnplt_gh_config_v2';
  var TOKEN_TYPE = 'open_ticket';

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
    if (logs.configUrl) return global.DbsApi.init({ configUrl: logs.configUrl });
    return global.DbsApi.init({ table: 'logs' });
  }

  function rowFilter(token) {
    return "type='" + escVal(TOKEN_TYPE) + "' AND name='" + escVal(token) + "'";
  }

  /* 校验并一次性消费令牌。返回 Promise<{u,p,exp}|null>；无效 / 已消费 / 校验失败均返回 null。 */
  function verify(token) {
    if (!token) return Promise.resolve(null);
    return getLogsDb()
      .then(function (db) {
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
        var u = String(row.user_id || '');
        var p = String(detail.folder || '');
        if (!u || !p) return null;
        return db.update(rowFilter(token), { status: 'consumed' }).then(function (res) {
          if (!res || res.code !== 200) return null;
          return { u: u, p: p, exp: exp };
        });
      })
      .catch(function () { return null; });
  }

  global.PlotterTicket = {
    verify: verify,
    normalizeDbCfg: normalizeDbCfg,
    TOKEN_TYPE: TOKEN_TYPE,
  };
})(window);
