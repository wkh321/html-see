/* ============================================================
 * 数学 Markdown 编辑器（题目 / 解析 通用）
 * - 左渲染区 contenteditable + 右源码区 双向同步
 * - 扩展语法：**加粗** *斜体* __下划线__ ==高亮== {#hex|彩色} $公式$ $$块级公式$$
 * - 图片：![描述](相对路径) / ![描述](func:表达式) / [sketch:JSON] / 网络图片
 * - 图片统一存入 GitHub 仓库 user_images/{用户ID}/，源码内写相对路径 /resource/repo/{用户ID}/user_images/
 * - 语法校验（未闭合/公式/图片丢失/sketch 格式）→ 报错锁定保存
 * - 多级关闭保存校验
 */
(function () {
  'use strict';
  if (window.MDEDIT) return;

  const LS_QUESTION = 'fe_question_md';
  const LS_ANALYSIS = 'fe_analysis_text';
  const LS_IMG = 'fe_md_images';
  const LS_SPLIT = 'fe_md_split';
  const VIRTUAL_THRESHOLD = 160;

  let target = 'question';
  let originalMd = '';
  let sourceMd = '';
  let editorOpen = false;
  let sourceOpen = false;
  let sourceInited = false;
  let linkCardMode = false;
  let errors = [];
  let imgIndex = {};
  let virtualOn = false;
  let blocks = [];
  let syncTimer = null;
  let validateTimer = null;
  let virtualTimer = null;
  let virtualStart = 0;
  let dragResize = null;
  let pendingImageWrap = null;
  let pendingUploadFile = null;
  let settings = { imgRoot: 'user_images', maxSizeMB: 5, whitelist: ['jpg', 'png', 'webp', 'svg'], uploadEnabled: true, remoteEnabled: true };

  const el = {};

  function $(id) { return document.getElementById(id); }
  function b64e(s) { try { return btoa(unescape(encodeURIComponent(String(s)))); } catch (e) { return btoa(String(s)); } }
  function b64d(s) { if (s == null) return ''; try { return decodeURIComponent(escape(atob(s))); } catch (e) { try { return atob(s); } catch (e2) { return ''; } } }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function genUuid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { }
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function toast(msg) { try { if (window.UserAuth && UserAuth.showToast) UserAuth.showToast(msg); else if (window.alert) alert(msg); } catch (e) { } }

  /* ---------------- 配置与图片索引 ---------------- */
  function loadSettings() {
    try {
      const cfg = (window.UserAuth && UserAuth.getConfig) ? UserAuth.getConfig() : null;
      if (cfg && cfg.imgRoot != null) {
        settings.imgRoot = cfg.imgRoot || 'user_images';
        settings.maxSizeMB = Number(cfg.imgMaxSize) || 5;
        settings.whitelist = String(cfg.imgWhitelist || 'jpg,png,webp,svg').split(',').map(function (s) { return s.trim().toLowerCase().replace(/^\./, ''); }).filter(Boolean);
        settings.uploadEnabled = cfg.imgUploadEnabled !== false;
        settings.remoteEnabled = cfg.imgRemoteEnabled !== false;
        return;
      }
    } catch (e) { }
    try {
      const s = JSON.parse(localStorage.getItem(LS_IMG + '_cfg') || '{}');
      settings.imgRoot = s.imgRoot || 'user_images';
      settings.maxSizeMB = Number(s.maxSizeMB) || 5;
      settings.whitelist = s.whitelist || ['jpg', 'png', 'webp', 'svg'];
      settings.uploadEnabled = s.uploadEnabled !== false;
      settings.remoteEnabled = s.remoteEnabled !== false;
    } catch (e) { }
  }
  function loadImgIndex() { try { imgIndex = JSON.parse(localStorage.getItem(LS_IMG) || '{}') || {}; } catch (e) { imgIndex = {}; } }
  function saveImgIndex() { try { localStorage.setItem(LS_IMG, JSON.stringify(imgIndex)); } catch (e) { } }

  function mdMediaUrl(rel) {
    if (/^https?:\/\//i.test(rel)) return rel;
    const m = String(rel).match(/^\/resource\/repo\/([^/]+)\/user_images\/(.+)$/);
    if (m) {
      try {
        const cfg = (window.UserAuth && UserAuth.getConfig) ? UserAuth.getConfig() : null;
        const root = (cfg && cfg.imgRoot) || settings.imgRoot || 'user_images';
        const repoPath = root.replace(/\/+$/, '') + '/' + m[1] + '/user_images/' + m[2];
        if (cfg && cfg.owner && cfg.repo && cfg.branch && UserAuth.rawUrl) return UserAuth.rawUrl(cfg, repoPath);
      } catch (e) { }
    }
    return rel;
  }
  function relToRepoPath(rel) {
    const m = String(rel).match(/^\/resource\/repo\/([^/]+)\/user_images\/(.+)$/);
    if (!m) return null;
    return (settings.imgRoot || 'user_images').replace(/\/+$/, '') + '/' + m[1] + '/user_images/' + m[2];
  }

  /* ============================================================
   * Markdown → HTML 块
   * ============================================================ */
  function preprocess(md) {
    const tokens = { mathB: [], mathI: [], underline: [], highlight: [], color: [], sketch: [], func: [], image: [] };
    let s = String(md || '');
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, function (m, tex) { tokens.mathB.push(tex); return '<!--MDTmathB-' + (tokens.mathB.length - 1) + '-->'; });
    s = s.replace(/!\[([^\]]*)\]\(func:([^)]*)\)/g, function (m, alt, expr) { tokens.func.push({ alt: alt, expr: expr.trim() }); return '<!--MDTfunc-' + (tokens.func.length - 1) + '-->'; });
    s = s.split('\n').map(function (line) {
      const mm = line.match(/^\[sketch:([\s\S]*)\]$/);
      if (mm) { tokens.sketch.push(mm[1]); return '<!--MDTsketch-' + (tokens.sketch.length - 1) + '-->'; }
      return line;
    }).join('\n');
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+=\s*(\d+)(?:x(\d+))?)?\)/g, function (m, alt, src, w, h) {
      tokens.image.push({ alt: alt, src: src, w: w || '', h: h || '' });
      return '⟦MDTimage-' + (tokens.image.length - 1) + '⟧';
    });
    s = s.replace(/(^|[^\\])\$([^$\n]+?)\$/g, function (m, pre, tex) { tokens.mathI.push(tex); return pre + '⟦MDTmathI-' + (tokens.mathI.length - 1) + '⟧'; });
    s = s.replace(/__([^]+?)__/g, function (m, t) { tokens.underline.push(t); return '⟦MDTunderline-' + (tokens.underline.length - 1) + '⟧'; });
    s = s.replace(/==([^]+?)==/g, function (m, t) { tokens.highlight.push(t); return '⟦MDThighlight-' + (tokens.highlight.length - 1) + '⟧'; });
    s = s.replace(/\{#([0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)\|([^}]*)\}/g, function (m, hex, txt) { tokens.color.push({ hex: hex.toLowerCase(), txt: txt }); return '⟦MDTcolor-' + (tokens.color.length - 1) + '⟧'; });
    let html = '';
    try {
      html = (window.marked && marked.parse) ? (marked.parse(s) || '') : '<p>' + escapeHtml(s).replace(/\n/g, '<br>') + '</p>';
    } catch (e) { html = '<p>' + escapeHtml(s) + '</p>'; }
    return { html: html, tokens: tokens };
  }

  function inlineToHtml(t) {
    let s = escapeHtml(t);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/(^|[^\\])\$([^$\n]+?)\$/g, function (m, pre, tex) { return pre + '<span class="md-math-inline" data-tex="' + b64e(tex) + '" contenteditable="false"></span>'; });
    s = s.replace(/==([^]+?)==/g, '<mark class="md-hl">$1</mark>');
    s = s.replace(/__([^]+?)__/g, '<u>$1</u>');
    s = s.replace(/\*\*([^]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, function (m, pre, t) { return pre + '<em>' + t + '</em>'; });
    s = s.replace(/\{#([0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)\|([^}]*)\}/g, function (m, hex, txt) { return '<span class="md-color" data-color="#' + hex.toLowerCase() + '">' + txt + '</span>'; });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, function (m, txt, url, title) { return '<a href="' + escapeHtml(url) + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + txt + '</a>'; });
    return s;
  }

  function buildTokenMarkup(kind, idx, mode) {
    const tk = preTokens[kind] && preTokens[kind][idx];
    if (tk === undefined) return '';
    if (kind === 'mathB') return '<div class="md-math-block" data-tex="' + b64e(tk) + '" contenteditable="false"><span class="katex-holder"></span></div>';
    if (kind === 'mathI') return '<span class="md-math-inline" data-tex="' + b64e(tk) + '" contenteditable="false"></span>';
    if (kind === 'underline') return '<u>' + inlineToHtml(tk) + '</u>';
    if (kind === 'highlight') return '<mark class="md-hl">' + inlineToHtml(tk) + '</mark>';
    if (kind === 'color') return '<span class="md-color" data-color="#' + tk.hex + '">' + inlineToHtml(tk.txt) + '</span>';
    if (kind === 'sketch') return '<div class="md-sketch" data-json="' + b64e(tk) + '" contenteditable="false"><div class="md-sketch-hint">画笔标记</div></div>';
    if (kind === 'func') {
      const btn = mode === 'edit' ? '<button class="md-func-btn">绘制到画布</button>' : '';
      return '<div class="md-func" data-expr="' + b64e(tk.expr) + '" contenteditable="false"><span class="md-func-expr"></span>' + btn + '</div>';
    }
    if (kind === 'image') {
      const missing = (tk.src.indexOf('/resource/repo/') === 0 && !imgIndex[tk.src]) ? ' md-img-missing' : '';
      const dims = tk.w ? (' data-w="' + tk.w + '"' + (tk.h ? ' data-h="' + tk.h + '"' : '')) : '';
      const cap = tk.alt ? '<span class="md-img-alt">' + escapeHtml(tk.alt) + '</span>' : '';
      const style = tk.w ? (' style="width:' + tk.w + 'px"') : '';
      return '<span class="md-img' + missing + '" data-src="' + escapeHtml(tk.src) + '"' + dims + ' contenteditable="false">' +
        '<img src="' + escapeHtml(mdMediaUrl(tk.src)) + '" alt="' + escapeHtml(tk.alt || '') + '"' + style + ' loading="lazy">' +
        cap + '<span class="md-img-del" title="删除图片">×</span><span class="md-img-resize-handle" title="拖拽缩放"></span></span>';
    }
    return '';
  }

  let preTokens = {};

  function unwrapBlockParagraphs(root) {
    Array.from(root.querySelectorAll('p')).forEach(function (p) {
      const kids = Array.from(p.childNodes).filter(function (n) { return !(n.nodeType === 3 && !n.textContent.trim()); });
      if (kids.length === 1 && kids[0].nodeType === 1 && kids[0].tagName === 'DIV') {
        p.parentNode.replaceChild(kids[0], p);
      }
    });
  }

  function splitParagraphAroundImages(p) {
    const frag = document.createDocumentFragment();
    let buf = [];
    const flush = function () {
      const t = buf.filter(function (n) { return !(n.nodeType === 3 && !n.textContent.trim()); });
      if (t.length) { const np = document.createElement('p'); t.forEach(function (x) { np.appendChild(x); }); frag.appendChild(np); }
      buf = [];
    };
    Array.from(p.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && n.classList && n.classList.contains('md-img')) {
        flush();
        const row = document.createElement('div'); row.className = 'md-img-row'; row.appendChild(n);
        frag.appendChild(row);
      } else { buf.push(n); }
    });
    flush();
    p.parentNode.replaceChild(frag, p);
  }

  function processImages(root) {
    Array.from(root.querySelectorAll('p')).forEach(function (p) {
      if (p.querySelector('.md-img')) splitParagraphAroundImages(p);
    });
    const merged = [];
    let pending = [];
    const flush = function () {
      if (pending.length) {
        const row = document.createElement('div'); row.className = 'md-img-row';
        pending.forEach(function (x) { row.appendChild(x); });
        merged.push(row); pending = [];
      }
    };
    Array.from(root.children).forEach(function (c) {
      if (c.classList && c.classList.contains('md-img-row')) {
        pending = pending.concat(Array.from(c.children));
      } else { flush(); merged.push(c); }
    });
    flush();
    root.innerHTML = '';
    merged.forEach(function (c) { root.appendChild(c); });
  }

  function processLinkCards(root) {
    if (!linkCardMode) return;
    Array.from(root.querySelectorAll('p')).forEach(function (p) {
      const a = p.querySelector('a[href^="http"]');
      if (!a) return;
      const kids = Array.from(p.childNodes).filter(function (n) { return !(n.nodeType === 3 && !n.textContent.trim()); });
      if (kids.length !== 1 || kids[0] !== a) return;
      const card = document.createElement('div');
      card.className = 'md-link-card';
      card.setAttribute('contenteditable', 'false');
      card.dataset.url = a.getAttribute('href') || '';
      card.dataset.text = a.textContent || '';
      card.dataset.title = a.getAttribute('title') || '';
      let host = '';
      try { host = new URL(card.dataset.url).host; } catch (e) { }
      card.innerHTML = '<div class="lc-title"><img class="lc-favicon" src="https://www.google.com/s2/favicons?domain=' + escapeHtml(host) + '&sz=32" onerror="this.style.display=&quot;none&quot;" alt=""><span class="lc-text"></span></div>' +
        '<div class="lc-desc"></div><span class="lc-url"></span><span class="lc-open">打开链接</span>';
      card.querySelector('.lc-text').textContent = card.dataset.text || card.dataset.url;
      card.querySelector('.lc-desc').textContent = card.dataset.title || '';
      card.querySelector('.lc-url').textContent = card.dataset.url;
      card.querySelector('.lc-open').addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); window.open(card.dataset.url, '_blank'); });
      card.addEventListener('click', function (e) { if (e.target.classList.contains('lc-open')) return; window.open(card.dataset.url, '_blank'); });
      p.parentNode.replaceChild(card, p);
    });
  }

  function normalizeDom(root, mode) {
    unwrapBlockParagraphs(root);
    processImages(root);
    processLinkCards(root);
    if (mode === 'read') Array.from(root.querySelectorAll('.md-func-btn')).forEach(function (b) { b.remove(); });
  }

  function mdToBlocks(md, mode) {
    const pre = preprocess(md);
    preTokens = pre.tokens;
    let html = pre.html;
    html = html.replace(/(?:⟦MDT|<!--MDT)(\w+)-(\d+)(?:⟧|-->)/g, function (m, k, i) { return buildTokenMarkup(k, parseInt(i, 10), mode); });
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    normalizeDom(tmp, mode);
    return Array.from(tmp.children).map(function (c) { return c.outerHTML; });
  }

  function mdToHtmlReadOnly(md) { return mdToBlocks(md, 'read').join('\n'); }

  /* ---------------- 渲染（含虚拟滚动） ---------------- */
  function renderPane() {
    sourceMd = (sourceOpen && sourceInited) ? el.sourceArea.value : sourceMd;
    blocks = mdToBlocks(sourceMd, 'edit');
    if (blocks.length > VIRTUAL_THRESHOLD) { virtualOn = true; renderVirtual(); }
    else { virtualOn = false; el.renderInner.innerHTML = blocks.join(''); }
    postRender();
    checkRenderScrollEnd();
  }

  function estimateBlockHeight() { return 32; }

  function renderVirtual() {
    const pane = el.renderInner;
    const vh = el.renderPane.clientHeight || 600;
    const st = pane.scrollTop;
    const avg = estimateBlockHeight();
    const start = Math.max(0, Math.floor(st / avg) - 10);
    const end = Math.min(blocks.length, Math.ceil((st + vh) / avg) + 10);
    pane.innerHTML =
      '<div class="md-virtual-spacer" style="height:' + Math.round(start * avg) + 'px"></div>' +
      blocks.slice(start, end).join('') +
      '<div class="md-virtual-spacer" style="height:' + Math.round((blocks.length - end) * avg) + 'px"></div>';
    virtualStart = start;
    postRender();
  }

  function disableVirtual() {
    if (!virtualOn) return;
    virtualOn = false;
    el.renderInner.innerHTML = blocks.join('');
    postRender();
  }

  function scheduleVirtual() {
    clearTimeout(virtualTimer);
    virtualTimer = setTimeout(renderVirtual, 60);
  }

  function postRender() {
    const root = el.renderInner;
    root.querySelectorAll('.md-math-block').forEach(function (b) {
      const holder = b.querySelector('.katex-holder');
      const tex = b64d(b.getAttribute('data-tex') || '');
      if (!holder) return;
      try {
        if (window.katex && katex.render) katex.render(tex, holder, { throwOnError: false, displayMode: true });
        else holder.textContent = tex;
        holder.classList.remove('katex-error');
      } catch (e) { holder.textContent = '公式解析失败'; holder.classList.add('katex-error'); }
    });
    root.querySelectorAll('.md-math-inline').forEach(function (b) {
      const tex = b64d(b.getAttribute('data-tex') || '');
      try {
        if (window.katex && katex.render) katex.render(tex, b, { throwOnError: false, displayMode: false });
        else b.textContent = '$' + tex + '$';
        b.classList.remove('katex-error');
      } catch (e) { b.textContent = tex; b.classList.add('katex-error'); }
    });
    root.querySelectorAll('.md-sketch').forEach(renderSketch);
    root.querySelectorAll('.md-func').forEach(function (f) {
      const ex = f.querySelector('.md-func-expr');
      if (ex) ex.textContent = b64d(f.getAttribute('data-expr') || '');
    });
  }

  function renderSketch(block) {
    const old = block.querySelector('canvas');
    if (old) old.remove();
    let data = null;
    try { data = JSON.parse(b64d(block.getAttribute('data-json') || '')); } catch (e) { }
    if (!data) {
      const h = block.querySelector('.md-sketch-hint');
      if (h) h.textContent = '画笔标记（数据无效）';
      return;
    }
    const shapes = Array.isArray(data) ? data : (data.shapes || []);
    const canvas = document.createElement('canvas');
    canvas.width = 260; canvas.height = 140;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#92400e'; ctx.fillStyle = '#92400e'; ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    shapes.forEach(function (sh) {
      const pts = sh.points || sh.path || (Array.isArray(sh) ? sh : []);
      if (pts.length >= 2) {
        ctx.beginPath();
        pts.forEach(function (p, i) {
          const x = 12 + p[0] * 12, y = 124 - p[1] * 12;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      } else if (pts.length === 1) {
        ctx.beginPath(); ctx.arc(12 + pts[0][0] * 12, 124 - pts[0][1] * 12, 3, 0, 7); ctx.fill();
      }
    });
    block.appendChild(canvas);
  }

  function checkRenderScrollEnd() {
    const inner = el.renderInner;
    if (inner.scrollTop + inner.clientHeight >= inner.scrollHeight - 30) el.renderEnd.classList.add('show');
    else el.renderEnd.classList.remove('show');
  }

  /* ============================================================
   * 渲染区 DOM → Markdown
   * ============================================================ */
  function domToMd() {
    const root = el.renderInner;
    const lines = [];
    Array.from(root.childNodes).forEach(function (n) {
      if (n.nodeType === 3) {
        const t = n.textContent || '';
        if (t.trim()) lines.push(t.replace(/\n+$/g, ''));
        return;
      }
      if (n.nodeType !== 1) return;
      if (n.classList && n.classList.contains('md-virtual-spacer')) return;
      const line = blockToMd(n);
      lines.push(line);
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function inlineMd(node) {
    const out = [];
    (function walk(n) {
      if (!n) return;
      if (n.nodeType === 3) { out.push(n.textContent.replace(/\u00a0/g, ' ')); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'BR') { out.push('\n'); return; }
      if (tag === 'UL' || tag === 'OL') return;
      if (tag === 'STRONG' || tag === 'B') { out.push('**'); Array.from(n.childNodes).forEach(walk); out.push('**'); return; }
      if (tag === 'EM' || tag === 'I') { out.push('*'); Array.from(n.childNodes).forEach(walk); out.push('*'); return; }
      if (tag === 'U') { out.push('__'); Array.from(n.childNodes).forEach(walk); out.push('__'); return; }
      if (tag === 'CODE') { out.push('`' + n.textContent + '`'); return; }
      if (tag === 'A') {
        const url = n.getAttribute('href') || '';
        const title = n.getAttribute('title') || '';
        out.push('[' + (n.textContent || '') + '](' + url + (title ? ' "' + title + '"' : '') + ')');
        return;
      }
      if (tag === 'MARK') { out.push('=='); Array.from(n.childNodes).forEach(walk); out.push('=='); return; }
      if (tag === 'SPAN') {
        const cls = String(n.className || '');
        if (cls.indexOf('md-hl') >= 0) { out.push('=='); Array.from(n.childNodes).forEach(walk); out.push('=='); return; }
        if (cls.indexOf('md-color') >= 0) { out.push('{#' + String(n.getAttribute('data-color') || '#000').replace('#', '') + '|'); Array.from(n.childNodes).forEach(walk); out.push('}'); return; }
        if (cls.indexOf('md-math-inline') >= 0) { out.push('$' + b64d(n.getAttribute('data-tex') || '') + '$'); return; }
        Array.from(n.childNodes).forEach(walk); return;
      }
      if (tag === 'IMG') { out.push('![' + (n.getAttribute('alt') || '') + '](' + (n.getAttribute('src') || '') + ')'); return; }
      Array.from(n.childNodes).forEach(walk);
    })(node);
    return out.join('');
  }

  function imgSpanToMd(w) {
    const src = w.getAttribute('data-src') || '';
    const cap = w.querySelector('.md-img-alt');
    const alt = cap ? cap.textContent : '';
    const dims = w.getAttribute('data-w') ? (' =' + w.getAttribute('data-w') + (w.getAttribute('data-h') ? 'x' + w.getAttribute('data-h') : '')) : '';
    return '![' + alt + '](' + src + dims + ')';
  }

  function listToMd(elL) {
    const out = [];
    (function walk(li, prefix) {
      const subs = Array.from(li.children).filter(function (c) { return c.tagName === 'UL' || c.tagName === 'OL'; });
      const contentP = document.createElement('div');
      Array.from(li.childNodes).forEach(function (n) {
        if (n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL')) return;
        contentP.appendChild(n);
      });
      const content = inlineMd(contentP);
      out.push(prefix + content);
      subs.forEach(function (s) {
        const marker = s.tagName === 'OL' ? '1. ' : '- ';
        Array.from(s.children).forEach(function (item) { walk(item, ' '.repeat(prefix.length) + marker); });
      });
    });
    const marker = elL.tagName === 'OL' ? '1. ' : '- ';
    Array.from(elL.children).forEach(function (li) { walk(li, marker); });
    return out.join('\n');
  }

  function tableToMd(t) {
    const rows = Array.from(t.querySelectorAll('tr')).map(function (tr) {
      return Array.from(tr.children).map(function (td) { return (td.textContent || '').trim().replace(/\n/g, ' '); }).join(' | ');
    });
    if (!rows.length) return '';
    const isHeader = t.querySelector('th');
    if (isHeader) {
      const headCells = rows[0].split(' | ').length;
      return rows[0] + '\n' + '| ' + Array.from({ length: headCells }, function () { return '---'; }).join(' | ') + ' |' + '\n' + rows.slice(1).join('\n');
    }
    return rows.join('\n');
  }

  function blockToMd(elB) {
    if (!elB || elB.nodeType !== 1) return inlineMd(elB);
    const tag = elB.tagName;
    const cls = String(elB.className || '');
    if (cls.indexOf('md-math-block') >= 0) return '$$\n' + b64d(elB.getAttribute('data-tex') || '') + '\n$$';
    if (cls.indexOf('md-sketch') >= 0) return '[sketch:' + b64d(elB.getAttribute('data-json') || '') + ']';
    if (cls.indexOf('md-func') >= 0) return '![函数曲线](func:' + b64d(elB.getAttribute('data-expr') || '') + ')';
    if (cls.indexOf('md-img-row') >= 0) {
      return Array.from(elB.children).filter(function (c) { return c.classList && c.classList.contains('md-img'); }).map(imgSpanToMd).join('\n');
    }
    if (cls.indexOf('md-img') >= 0) return imgSpanToMd(elB);
    if (cls.indexOf('md-link-card') >= 0) {
      const url = elB.getAttribute('data-url') || '';
      const text = elB.getAttribute('data-text') || '';
      const title = elB.getAttribute('data-title') || '';
      return '[' + text + '](' + url + (title ? ' "' + title + '"' : '') + ')';
    }
    if (tag === 'P') return inlineMd(elB);
    if (/^H[1-6]$/.test(tag)) return '#'.repeat(parseInt(tag.charAt(1), 10)) + ' ' + inlineMd(elB);
    if (tag === 'UL' || tag === 'OL') return listToMd(elB);
    if (tag === 'BLOCKQUOTE') {
      const inner = Array.from(elB.children).map(function (c) { return blockToMd(c); }).join('\n');
      return inner.split('\n').map(function (l) { return '> ' + (l || ''); }).join('\n');
    }
    if (tag === 'PRE') {
      const code = elB.querySelector('code') ? elB.querySelector('code').textContent : elB.textContent;
      return '```\n' + code.replace(/\n$/, '') + '\n```';
    }
    if (tag === 'TABLE') return tableToMd(elB);
    if (tag === 'HR') return '---';
    const t = inlineMd(elB);
    return t.trim() ? t : '';
  }

  /* ============================================================
   * 双向同步
   * ============================================================ */
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(doSync, 300);
  }
  function doSync() {
    if (!editorOpen) return;
    if (virtualOn) disableVirtual();
    const md = domToMd();
    if (md !== sourceMd) {
      sourceMd = md;
      if (sourceInited && sourceOpen) el.sourceArea.value = md;
      validateSource(md);
      updateValidationUI();
    }
  }

  function getSelectionText() {
    try {
      const sel = window.getSelection();
      const inner = el.renderInner;
      if (sel && sel.rangeCount && inner.contains(sel.anchorNode) && inner.contains(sel.focusNode)) return sel.toString();
    } catch (e) { }
    return '';
  }

  function insertMdIntoPane(text, reRender) {
    const inner = el.renderInner;
    inner.focus();
    let range = null;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && inner.contains(sel.anchorNode) && inner.contains(sel.focusNode)) range = sel.getRangeAt(0);
    } catch (e) { }
    const sel2 = window.getSelection();
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(inner); range.collapse(false);
      sel2.removeAllRanges(); sel2.addRange(range);
    }
    range.deleteContents();
    const tn = document.createTextNode(text);
    range.insertNode(tn);
    range.setStartAfter(tn); range.collapse(true);
    sel2.removeAllRanges(); sel2.addRange(range);
    doSync();
    if (reRender) renderPane();
  }

  function wrapSelection(before, after, placeholder) {
    const inner = el.renderInner;
    inner.focus();
    let range = null;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && inner.contains(sel.anchorNode) && inner.contains(sel.focusNode)) range = sel.getRangeAt(0);
    } catch (e) { }
    const sel = window.getSelection();
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(inner); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
    }
    if (range.toString() === '') {
      const ph = document.createTextNode(placeholder);
      range.deleteContents();
      range.insertNode(ph);
      range.setStart(ph, 0); range.setEnd(ph, ph.length);
    }
    const text = range.toString();
    const node = document.createTextNode(before + text + after);
    range.deleteContents();
    range.insertNode(node);
    const nr = document.createRange();
    nr.setStart(node, before.length);
    nr.setEnd(node, before.length + text.length);
    sel.removeAllRanges(); sel.addRange(nr);
    doSync();
  }

  function toggleWrap(before, after, placeholder) {
    const text = getSelectionText();
    if (text.length > 0 && text.indexOf(before) === 0 && text.lastIndexOf(after) === text.length - after.length && text.length > before.length + after.length) {
      insertMdIntoPane(text.slice(before.length, text.length - after.length), false);
      return;
    }
    wrapSelection(before, after, text || placeholder);
  }

  /* ============================================================
   * 语法校验
   * ============================================================ */
  function lineOf(md, index) {
    let n = 1;
    for (let i = 0; i < index; i++) if (md.charCodeAt(i) === 10) n++;
    return n;
  }

  function validateSource(md) {
    const lines = String(md || '').split('\n');
    const errLines = new Map();
    const flag = function (ln, msg) {
      if (ln < 1 || ln > lines.length) return;
      if (!errLines.has(ln)) errLines.set(ln, []);
      errLines.get(ln).push(msg);
    };
    let inCode = false;
    const mathChecks = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = i + 1;
      const line = lines[i];
      const fm = line.match(/^```/);
      if (fm) { inCode = !inCode; continue; }
      if (inCode) continue;
      const noDollar = line.replace(/\$\$/g, '');
      const dollarCount = (noDollar.match(/\$/g) || []).length;
      if (dollarCount % 2 !== 0) flag(ln, '未闭合的 $ 行内公式');
      let m;
      const re = /\$([^$\n]+?)\$/g;
      while ((m = re.exec(line))) mathChecks.push({ ln: ln, tex: m[1], block: false });
      const bOpen = (line.match(/\*\*/g) || []).length;
      if (bOpen % 2 !== 0) flag(ln, '未闭合的 ** 加粗标记');
      const uOpen = (line.match(/__/g) || []).length;
      if (uOpen % 2 !== 0) flag(ln, '未闭合的 __ 下划线标记');
      const hOpen = (line.match(/==/g) || []).length;
      if (hOpen % 2 !== 0) flag(ln, '未闭合的 == 高亮标记');
      if (/\{#/.test(line) && !/\}/.test(line)) flag(ln, '未闭合的 {#...} 彩色文字标记');
      const colRe = /\{#([0-9a-zA-Z#]*)(?:\|([^}]*))?\}/g;
      while ((m = colRe.exec(line))) {
        const hex = String(m[1] || '').replace('#', '');
        if (hex && !/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex)) flag(ln, '彩色文字色值非法：' + hex);
      }
      const oB = (line.match(/\[/g) || []).length;
      const cB = (line.match(/\]/g) || []).length;
      if (oB !== cB) flag(ln, '方括号 [ ] 未配对');
      const fRe = /!\[[^\]]*\]\(func:([^)]*)\)/g;
      while ((m = fRe.exec(line))) {
        const expr = m[1].trim();
        try {
          if (window.math && math.compile) math.compile((window.preprocessExpr || function (x) { return x; })(expr));
          else if (typeof expr !== 'string' || !expr) throw new Error('empty');
        } catch (e) { flag(ln, '函数表达式非法：' + expr); }
      }
      const sRe = /\[sketch:([\s\S]*)\]/g;
      while ((m = sRe.exec(line))) {
        const raw = m[1];
        let json = raw;
        if (json.charAt(json.length - 1) === ']') json = json.slice(0, -1);
        try { const obj = JSON.parse(json); if (!Array.isArray(obj) && !obj.shapes) throw new Error('shape'); }
        catch (e) { flag(ln, '画笔标记 JSON 格式错误'); }
      }
      const imgRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+=\d+(?:x\d+)?)?\)/g;
      while ((m = imgRe.exec(line))) {
        const src = m[1];
        if (src.indexOf('/resource/repo/') === 0) {
          if (!imgIndex[src]) flag(ln, '图片资源丢失：' + src);
        } else if (src.indexOf('func:') === 0) {
          continue;
        } else if (/^https?:\/\//i.test(src)) {
          if (!settings.remoteEnabled) flag(ln, '外部网络图片加载已关闭，无法使用该链接');
        } else if (/^data:/i.test(src)) {
          flag(ln, '不支持内嵌 data: 图片，请上传或使用网络地址');
        } else {
          flag(ln, '非法图片地址：' + src);
        }
      }
    }
    const dm = (md.match(/\$\$/g) || []).length;
    if (dm % 2 !== 0) flag(lines.length, '未闭合的 $$ 块级公式');
    const bRe = /\$\$([\s\S]+?)\$\$/g;
    let m;
    while ((m = bRe.exec(md))) mathChecks.push({ ln: lineOf(md, m.index), tex: m[1], block: true });
    mathChecks.forEach(function (c) {
      try {
        if (window.katex && katex.renderToString) katex.renderToString(c.tex, { throwOnError: true, displayMode: c.block });
      } catch (e) { flag(c.ln, 'LaTeX 公式语法错误'); }
    });
    errors = [];
    Array.from(errLines.keys()).sort(function (a, b) { return a - b; }).forEach(function (ln) {
      errors.push({ line: ln, msg: errLines.get(ln).join('；') });
    });
    return errors;
  }

  function updateValidationUI() {
    const bar = el.errorBar;
    if (errors.length) {
      bar.style.display = 'block';
      bar.innerHTML = errors.map(function (e) {
        return '<div class="err-item"><span class="err-line">第 ' + e.line + ' 行</span><span>' + escapeHtml(e.msg) + '</span></div>';
      }).join('');
      el.saveBtn.disabled = true;
      el.saveBtn.title = '存在语法错误，请修复后再保存';
      el.status.textContent = '检测到 ' + errors.length + ' 处语法错误，请修复';
      el.status.style.color = '#dc2626';
    } else {
      bar.style.display = 'none';
      bar.innerHTML = '';
      el.saveBtn.disabled = false;
      el.saveBtn.title = '保存并关闭';
      el.status.textContent = sourceMd === originalMd ? '内容未修改' : '内容已修改，可保存';
      el.status.style.color = '';
    }
    updateLineNumbers();
  }

  function updateLineNumbers() {
    if (!sourceInited || !sourceOpen) return;
    const n = sourceMd.split('\n').length;
    const errSet = new Set(errors.map(function (e) { return e.line; }));
    let h = '';
    for (let i = 1; i <= n; i++) h += '<div class="ln' + (errSet.has(i) ? ' err' : '') + '">' + i + '</div>';
    el.lineNo.innerHTML = h;
  }

  function scheduleValidate() {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(function () {
      const md = (sourceInited && sourceOpen) ? el.sourceArea.value : sourceMd;
      validateSource(md);
      updateValidationUI();
    }, 300);
  }

  /* ============================================================
   * 图片上传 / 删除 / 孤立清理
   * ============================================================ */
  function compressImage(file) {
    return new Promise(function (resolve) {
      if (/\.svg$/i.test(file.name)) {
        const rd = new FileReader();
        rd.onload = function () {
          const text = String(rd.result || '');
          if (/<script/i.test(text)) { toast('SVG 包含脚本，已拦截'); resolve(null); return; }
          resolve({ b64: btoa(unescape(encodeURIComponent(text))), ext: 'svg' });
        };
        rd.onerror = function () { resolve(null); };
        rd.readAsText(file);
        return;
      }
      const rd = new FileReader();
      rd.onload = function () {
        const img = new Image();
        img.onload = function () {
          let w = img.width || 800, h = img.height || 600;
          const max = 1600;
          if (Math.max(w, h) > max) { const r = max / Math.max(w, h); w = Math.round(w * r); h = Math.round(h * r); }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const isPng = /\.png$/i.test(file.name);
          const ext = isPng ? 'png' : 'jpg';
          const dataUrl = isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
          resolve({ b64: String(dataUrl).split(',')[1] || '', ext: ext });
        };
        img.onerror = function () { resolve(null); };
        img.src = rd.result;
      };
      rd.onerror = function () { resolve(null); };
      rd.readAsDataURL(file);
    });
  }

  async function uploadLocalImage(file) {
    if (!settings.uploadEnabled) { toast('管理员已关闭图片上传功能'); return null; }
    if (!window.UserAuth || !UserAuth.isLoggedIn || !UserAuth.isLoggedIn()) { toast('请先登录后再上传图片'); if (UserAuth.requireLogin) UserAuth.requireLogin(); return null; }
    const cfg = (UserAuth.getConfig) ? UserAuth.getConfig() : null;
    if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) { toast('请先在设置中配置 GitHub 仓库'); return null; }
    if (!UserAuth.ghWrite) { toast('图片存储接口不可用'); return null; }
    const rawExt = (String(file.name).split('.').pop() || '').toLowerCase();
    if (settings.whitelist.indexOf(rawExt) < 0 && !['jpg', 'jpeg'].includes(rawExt)) { toast('不支持的图片格式：' + (rawExt || '未知') + '（允许：' + settings.whitelist.join('/') + '）'); return null; }
    if (file.size > settings.maxSizeMB * 1024 * 1024) { toast('图片过大（上限 ' + settings.maxSizeMB + 'MB）'); return null; }
    const compressed = await compressImage(file);
    if (!compressed) return null;
    const user = UserAuth.getCurrentUser ? UserAuth.getCurrentUser() : null;
    const uid = (user && user.id) || 'anonymous';
    const uuid = genUuid();
    const name = uuid + '.' + compressed.ext;
    const repoPath = (settings.imgRoot || 'user_images').replace(/\/+$/, '') + '/' + uid + '/user_images/' + name;
    const relPath = '/resource/repo/' + uid + '/user_images/' + name;
    try {
      await UserAuth.ghWrite(cfg, repoPath, compressed.b64, 'Upload image ' + name, true);
    } catch (e) {
      toast('上传失败：' + (e.message || e));
      return null;
    }
    imgIndex[relPath] = { name: file.name, size: file.size, ext: compressed.ext, uploadedAt: Date.now() };
    saveImgIndex();
    return relPath;
  }

  async function uploadAndInsert(file) {
    toast('正在上传图片...');
    const rel = await uploadLocalImage(file);
    if (rel) {
      const alt = String(file.name).replace(/\.[^.]+$/, '');
      insertMdIntoPane('![' + alt + '](' + rel + ')', true);
      toast('图片已上传并插入');
    }
  }

  async function deleteImageAt(rel, removeFile) {
    if (removeFile) {
      const cfg = (UserAuth.getConfig) ? UserAuth.getConfig() : null;
      const rp = relToRepoPath(rel);
      if (cfg && rp && UserAuth.ghDelete) {
        try { await UserAuth.ghDelete(cfg, rp, 'Delete image ' + rel.split('/').pop()); }
        catch (e) { toast('删除服务器文件失败：' + (e.message || e)); }
      }
      delete imgIndex[rel];
      saveImgIndex();
    }
    const wrap = pendingImageWrap;
    pendingImageWrap = null;
    if (wrap && wrap.parentNode) {
      wrap.remove();
      doSync();
      renderPane();
      toast(removeFile ? '已删除图片与服务器文件' : '已移除文档引用');
    }
  }

  function findOrphans() {
    const used = new Set();
    [LS_QUESTION, LS_ANALYSIS].forEach(function (k) {
      try {
        const md = localStorage.getItem(k) || '';
        const re = /\/resource\/repo\/[^\s\)\]\}]+/g;
        let m;
        while ((m = re.exec(md))) used.add(m[0]);
      } catch (e) { }
    });
    return Object.keys(imgIndex).filter(function (p) { return !used.has(p); });
  }

  function openOrphanManager() {
    if (!window.UserAuth || !UserAuth.isLoggedIn || !UserAuth.isLoggedIn()) { toast('请先登录'); return; }
    loadImgIndex();
    const orphans = findOrphans();
    const list = el.orphanList;
    if (!orphans.length) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8;font-size:13px;">没有发现孤立图片</div>';
    } else {
      list.innerHTML = orphans.map(function (p) {
        return '<label class="md-orphan-item"><input type="checkbox" class="orphan-cb" value="' + escapeHtml(p) + '" checked>' +
          '<img src="' + escapeHtml(mdMediaUrl(p)) + '" onerror="this.style.visibility=&quot;hidden&quot;" alt="">' +
          '<span>' + escapeHtml(p.split('/').pop()) + '</span></label>';
      }).join('');
    }
    el.orphanOverlay.classList.add('visible');
  }

  async function deleteSelectedOrphans() {
    const cbs = Array.from(el.orphanList.querySelectorAll('.orphan-cb:checked'));
    if (!cbs.length) { toast('未选择任何图片'); return; }
    const cfg = (UserAuth.getConfig) ? UserAuth.getConfig() : null;
    let ok = 0, fail = 0;
    for (const cb of cbs) {
      const rel = cb.value;
      try {
        const rp = relToRepoPath(rel);
        if (rp && cfg && UserAuth.ghDelete) await UserAuth.ghDelete(cfg, rp, 'Delete orphan image ' + rel.split('/').pop());
        delete imgIndex[rel]; ok++;
      } catch (e) { fail++; }
    }
    saveImgIndex();
    toast('已删除 ' + ok + ' 张' + (fail ? '，失败 ' + fail + ' 张' : ''));
    openOrphanManager();
  }

  /* ============================================================
   * 弹窗管理：打开 / 关闭 / 多级保存校验
   * ============================================================ */
  function currentMd() {
    if (sourceInited && sourceOpen) return el.sourceArea.value;
    if (virtualOn) disableVirtual();
    return domToMd();
  }

  function open(region) {
    target = region === 'analysis' ? 'analysis' : 'question';
    editorOpen = true;
    loadSettings();
    let saved = '';
    try {
      saved = localStorage.getItem(target === 'question' ? LS_QUESTION : LS_ANALYSIS) || '';
    } catch (e) { }
    if (!saved && target === 'analysis') {
      const ta = $('analysisTextarea');
      if (ta) saved = ta.value || '';
    }
    if (!saved && target === 'question') saved = legacyQuestionToMd();
    originalMd = saved;
    sourceMd = saved;
    sourceOpen = false;
    if (sourceInited) { el.sourceArea.value = saved; }
    el.body.classList.remove('show-source');
    el.viewSourceBtn.classList.remove('active');
    el.viewSourceBtn.textContent = '查看源码';
    el.title.textContent = target === 'question' ? '编辑题目' : '编辑解析';
    virtualOn = false;
    renderPane();
    validateSource(sourceMd);
    updateValidationUI();
    el.mdEditorOverlay.classList.remove('closing');
    el.mdEditorOverlay.classList.add('visible');
    document.body.classList.add('md-editor-open');
    applySplitPref();
    setTimeout(function () { el.renderInner.focus(); }, 60);
  }

  function legacyQuestionToMd() {
    try {
      const body = $('questionRegionBody');
      if (!body) return '';
      const img = body.querySelector('.question-body-image');
      if (img) return '![题目图片](' + (img.getAttribute('src') || '') + ')';
      const txt = body.querySelector('.question-body-text');
      if (txt && !body.querySelector('.question-body-title')) return txt.textContent;
      const url = body.querySelector('.question-body-text');
      if (url && body.querySelector('.question-body-title')) return '[' + (url.textContent || '') + '](' + (url.textContent || '') + ')';
    } catch (e) { }
    return '';
  }

  function closeEditor() {
    editorOpen = false;
    el.mdEditorOverlay.classList.add('closing');
    setTimeout(function () {
      el.mdEditorOverlay.classList.remove('visible', 'closing');
      document.body.classList.remove('md-editor-open');
    }, 320);
  }

  function requestClose() {
    if (!editorOpen) return;
    const cur = currentMd();
    if (cur === originalMd) { closeEditor(); return; }
    el.confirm1.classList.add('visible');
  }

  function saveAndClose() {
    if (errors.length) { toast('存在语法错误，请修复后再保存'); return; }
    const md = currentMd();
    const region = target;
    if (region === 'question') {
      try { localStorage.setItem(LS_QUESTION, md); } catch (e) { }
      renderQuestionMarkdown(md);
    } else {
      try { localStorage.setItem(LS_ANALYSIS, md); } catch (e) { }
      const ta = $('analysisTextarea');
      if (ta) ta.value = md;
      renderAnalysisMarkdown(md);
    }
    originalMd = md;
    sourceMd = md;
    const orphans = findOrphans().length;
    closeEditor();
    toast('已保存' + (orphans ? '（发现 ' + orphans + ' 张孤立图片，可在设置中清理）' : ''));
  }

  /* ---------------- 板块渲染 ---------------- */
  function renderKatexIn(container) {
    if (!container) return;
    container.querySelectorAll('.md-math-block').forEach(function (b) {
      const holder = b.querySelector('.katex-holder');
      const tex = b64d(b.getAttribute('data-tex') || '');
      if (!holder) return;
      try { if (window.katex) katex.render(tex, holder, { throwOnError: false, displayMode: true }); else holder.textContent = tex; }
      catch (e) { holder.textContent = tex; }
    });
    container.querySelectorAll('.md-math-inline').forEach(function (b) {
      const tex = b64d(b.getAttribute('data-tex') || '');
      try { if (window.katex) katex.render(tex, b, { throwOnError: false, displayMode: false }); else b.textContent = '$' + tex + '$'; }
      catch (e) { b.textContent = tex; }
    });
    container.querySelectorAll('.md-sketch').forEach(renderSketch);
  }

  function renderQuestionMarkdown(md) {
    const body = $('questionRegionBody');
    if (!body) return;
    body.innerHTML = '';
    const ph = $('questionPlaceholder');
    if (ph) ph.remove();
    if (!md || !String(md).trim()) {
      if (window.noteQuestionContent) window.noteQuestionContent(null);
      body.appendChild(makeQuestionPlaceholder());
      return;
    }
    const d = document.createElement('div');
    d.className = 'question-body-md';
    d.innerHTML = mdToHtmlReadOnly(md);
    renderKatexIn(d);
    body.appendChild(d);
    const clear = document.createElement('button');
    clear.className = 'question-clear-btn';
    clear.textContent = '清除题目';
    clear.addEventListener('click', function () {
      try { localStorage.removeItem(LS_QUESTION); } catch (e) { }
      if (window.noteQuestionContent) window.noteQuestionContent(null);
      body.innerHTML = '';
      body.appendChild(makeQuestionPlaceholder());
    });
    body.appendChild(clear);
    if (window.noteQuestionContent) window.noteQuestionContent({ type: 'md', text: md });
  }

  function renderAnalysisMarkdown(md) {
    const pv = $('analysisPreview');
    const ta = $('analysisTextarea');
    if (!pv) return;
    pv.style.display = 'block';
    if (ta) ta.style.display = 'none';
    if (!md || !String(md).trim()) { pv.innerHTML = '<div style="color:#94a3b8;font-size:13px;">暂无解析内容</div>'; return; }
    pv.innerHTML = mdToHtmlReadOnly(md);
    renderKatexIn(pv);
  }

  /* ---------------- 工具栏命令 ---------------- */
  function toolbarCommand(cmd) {
    switch (cmd) {
      case 'bold': toggleWrap('**', '**', '加粗文本'); break;
      case 'italic': toggleWrap('*', '*', '斜体文本'); break;
      case 'underline': toggleWrap('__', '__', '下划线文本'); break;
      case 'highlight': toggleWrap('==', '==', '高亮文本'); break;
      case 'color': openColorDialog(); break;
      case 'link': openLinkDialog(); break;
      case 'image': openImageDialog(null); break;
      case 'formula': openFormulaDialog(); break;
      case 'func': openFuncDialog(); break;
      case 'sketch': openSketchDialog(); break;
      default: break;
    }
  }

  function openColorDialog() {
    const hex = window.prompt('输入文字颜色（十六进制色值，如 ff0000）：', 'ef4444');
    if (hex === null) return;
    const h = String(hex).trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(h)) { toast('颜色格式非法'); return; }
    const sel = getSelectionText();
    insertMdIntoPane('{#' + h.toLowerCase() + '|' + (sel || '彩色文本') + '}', true);
  }

  function openLinkDialog() {
    el.linkText.value = getSelectionText() || '';
    el.linkUrl.value = 'https://';
    el.linkTitle.value = '';
    el.linkOverlay.classList.add('visible');
  }

  function confirmLink() {
    const text = el.linkText.value.trim();
    const url = el.linkUrl.value.trim();
    const title = el.linkTitle.value.trim();
    if (!text) { toast('请输入链接显示文字'); return; }
    if (!/^https?:\/\//i.test(url)) { toast('链接地址必须以 http:// 或 https:// 开头'); return; }
    insertMdIntoPane('[' + text + '](' + url + (title ? ' "' + title + '"' : '') + ')', true);
    el.linkOverlay.classList.remove('visible');
  }

  function openFormulaDialog() {
    el.formulaInput.value = '';
    el.formulaPreview.textContent = '预览将显示在此处';
    el.formulaMode = 'inline';
    el.fmlInline.classList.add('active');
    el.fmlBlock.classList.remove('active');
    el.formulaOverlay.classList.add('visible');
  }

  function setFormulaMode(mode) {
    el.formulaMode = mode;
    el.fmlInline.classList.toggle('active', mode === 'inline');
    el.fmlBlock.classList.toggle('active', mode === 'block');
    previewFormula();
  }

  function previewFormula() {
    const tex = el.formulaInput.value;
    const mode = el.formulaMode;
    if (!tex.trim()) { el.formulaPreview.textContent = '预览将显示在此处'; return; }
    try {
      if (window.katex) katex.renderToString(tex, { throwOnError: true, displayMode: mode === 'block' });
      if (window.katex) katex.render(tex, el.formulaPreview, { throwOnError: false, displayMode: mode === 'block' });
      el.formulaPreview.classList.remove('katex-error');
    } catch (e) {
      el.formulaPreview.textContent = 'LaTeX 语法错误';
      el.formulaPreview.classList.add('katex-error');
    }
  }

  function confirmFormula() {
    const tex = el.formulaInput.value;
    if (!tex.trim()) { toast('请输入公式内容'); return; }
    const text = el.formulaMode === 'block' ? '$$\n' + tex.trim() + '\n$$' : '$' + tex.trim() + '$';
    insertMdIntoPane(text, true);
    el.formulaOverlay.classList.remove('visible');
  }

  function openFuncDialog() {
    el.funcExpr.value = '';
    el.funcOverlay.classList.add('visible');
  }

  function confirmFunc() {
    const expr = el.funcExpr.value.trim();
    if (!expr) { toast('请输入函数表达式'); return; }
    try { if (window.math && math.compile) math.compile((window.preprocessExpr || function (x) { return x; })(expr)); }
    catch (e) { toast('函数表达式非法：' + expr); return; }
    insertMdIntoPane('![函数曲线](func:' + expr + ')', true);
    el.funcOverlay.classList.remove('visible');
  }

  function openSketchDialog() {
    el.sketchInput.value = '';
    el.sketchOverlay.classList.add('visible');
  }

  function confirmSketch() {
    const raw = el.sketchInput.value.trim();
    if (!raw) { toast('请输入坐标数据 JSON'); return; }
    try {
      const obj = JSON.parse(raw);
      if (!Array.isArray(obj) && !obj.shapes) throw new Error('format');
    } catch (e) { toast('JSON 格式错误'); return; }
    insertMdIntoPane('[sketch:' + raw + ']', true);
    el.sketchOverlay.classList.remove('visible');
  }

  function openImageDialog(replaceWrap) {
    pendingImageWrap = replaceWrap || null;
    el.imgAlt.value = '';
    el.imgAltUrl.value = '';
    el.imgUrl.value = '';
    el.imgLocalInfo.style.display = 'none';
    el.imgTabLocal.classList.add('active');
    el.imgTabUrl.classList.remove('active');
    el.imgLocalPanel.style.display = '';
    el.imgUrlPanel.style.display = 'none';
    if (replaceWrap) {
      const src = replaceWrap.getAttribute('data-src') || '';
      if (/^https?:\/\//i.test(src)) { el.imgUrl.value = src; setImgTab('url'); }
    }
    el.imageOverlay.classList.add('visible');
  }

  function setImgTab(tab) {
    const local = tab === 'local';
    el.imgTabLocal.classList.toggle('active', local);
    el.imgTabUrl.classList.toggle('active', !local);
    el.imgLocalPanel.style.display = local ? '' : 'none';
    el.imgUrlPanel.style.display = local ? 'none' : '';
  }

  async function confirmImage() {
    const local = el.imgLocalPanel.style.display !== 'none';
    if (local) {
      if (!pendingUploadFile) { toast('请先选择图片文件'); return; }
      el.imgConfirm.disabled = true;
      el.imgConfirm.textContent = '上传中...';
      const rel = await uploadLocalImage(pendingUploadFile);
      el.imgConfirm.disabled = false;
      el.imgConfirm.textContent = pendingImageWrap ? '替换' : '插入';
      if (!rel) return;
      const alt = el.imgAlt.value.trim() || '图片';
      if (pendingImageWrap) {
        const wrap = pendingImageWrap;
        pendingImageWrap = null;
        const img = wrap.querySelector('img');
        if (img) { img.src = mdMediaUrl(rel); img.onerror = null; }
        wrap.setAttribute('data-src', rel);
        wrap.classList.remove('md-img-missing');
        const cap = wrap.querySelector('.md-img-alt');
        if (cap) cap.textContent = alt;
        doSync();
        renderPane();
      } else {
        insertMdIntoPane('![' + alt + '](' + rel + ')', true);
      }
      el.imageOverlay.classList.remove('visible');
      pendingUploadFile = null;
    } else {
      const url = el.imgUrl.value.trim();
      const alt = el.imgAltUrl.value.trim() || '图片';
      if (!/^https?:\/\//i.test(url)) { toast('网络图片必须以 http(s) 开头'); return; }
      if (!settings.remoteEnabled) { toast('外部网络图片加载已关闭'); return; }
      if (pendingImageWrap) {
        const wrap = pendingImageWrap;
        pendingImageWrap = null;
        const img = wrap.querySelector('img');
        if (img) img.src = url;
        wrap.setAttribute('data-src', url);
        wrap.classList.remove('md-img-missing');
        const cap = wrap.querySelector('.md-img-alt');
        if (cap) cap.textContent = alt;
        doSync();
        renderPane();
        el.imageOverlay.classList.remove('visible');
        return;
      }
      insertMdIntoPane('![' + alt + '](' + url + ')', true);
      el.imageOverlay.classList.remove('visible');
    }
  }

  /* ---------------- 初始化与事件 ---------------- */
  function cacheDom() {
    const ids = ['mdEditorOverlay', 'mdEditor', 'mdEditorTitle', 'mdEditorClose', 'mdEditorBody', 'mdRenderPane', 'mdRenderInner', 'mdSplitter',
      'mdSourcePane', 'mdLineNo', 'mdSourceArea', 'mdErrorBar', 'mdEditorStatus', 'mdSaveBtn', 'mdViewSourceBtn', 'mdLinkCardToggle',
      'mdConfirm1Overlay', 'mdConfirm1Save', 'mdConfirm1Cancel', 'mdConfirm2Overlay', 'mdConfirm2Back', 'mdConfirm2Quit',
      'mdImageOverlay', 'mdImgTabLocal', 'mdImgTabUrl', 'mdImgLocalPanel', 'mdImgUrlPanel', 'mdImgPickBtn', 'mdImgFile',
      'mdImgLocalInfo', 'mdImgAlt', 'mdImgUrl', 'mdImgAltUrl', 'mdImgConfirm', 'mdImgCancel',
      'mdLinkOverlay', 'mdLinkText', 'mdLinkUrl', 'mdLinkTitle', 'mdLinkConfirm', 'mdLinkCancel',
      'mdFormulaOverlay', 'mdFormulaInput', 'mdFormulaPreview', 'mdFmlInline', 'mdFmlBlock', 'mdFmlConfirm', 'mdFmlCancel',
      'mdFuncOverlay', 'mdFuncExpr', 'mdFuncConfirm', 'mdFuncCancel',
      'mdSketchOverlay', 'mdSketchInput', 'mdSketchConfirm', 'mdSketchCancel',
      'mdDelImgOverlay', 'mdDelImgMsg', 'mdDelImgRef', 'mdDelImgBoth', 'mdDelImgCancel',
      'mdOrphanOverlay', 'mdOrphanList', 'mdOrphanDel', 'mdOrphanClose'];
    ids.forEach(function (id) { el[toCamel(id)] = $(id); });
    el.renderEnd = el.mdRenderPane.querySelector('.md-scroll-end');
    el.sourceEnd = el.mdSourcePane.querySelector('.md-scroll-end');
    el.body = el.mdEditorBody;
    el.title = el.mdEditorTitle;
    el.saveBtn = el.mdSaveBtn;
    el.status = el.mdEditorStatus;
    el.errorBar = el.mdErrorBar;
    el.renderPane = el.mdRenderPane;
    el.renderInner = el.mdRenderInner;
    el.splitter = el.mdSplitter;
    el.lineNo = el.mdLineNo;
    el.sourcePane = el.mdSourcePane;
    el.sourceArea = el.mdSourceArea;
    el.viewSourceBtn = el.mdViewSourceBtn;
    el.linkCardToggle = el.mdLinkCardToggle;
    el.confirm1 = el.mdConfirm1Overlay;
    el.confirm1Save = el.mdConfirm1Save;
    el.confirm1Cancel = el.mdConfirm1Cancel;
    el.confirm2 = el.mdConfirm2Overlay;
    el.confirm2Back = el.mdConfirm2Back;
    el.confirm2Quit = el.mdConfirm2Quit;
    el.imageOverlay = el.mdImageOverlay;
    el.imgTabLocal = el.mdImgTabLocal;
    el.imgTabUrl = el.mdImgTabUrl;
    el.imgLocalPanel = el.mdImgLocalPanel;
    el.imgUrlPanel = el.mdImgUrlPanel;
    el.imgPickBtn = el.mdImgPickBtn;
    el.imgFile = el.mdImgFile;
    el.imgLocalInfo = el.mdImgLocalInfo;
    el.imgAlt = el.mdImgAlt;
    el.imgUrl = el.mdImgUrl;
    el.imgAltUrl = el.mdImgAltUrl;
    el.imgConfirm = el.mdImgConfirm;
    el.imgCancel = el.mdImgCancel;
    el.linkText = el.mdLinkText;
    el.linkUrl = el.mdLinkUrl;
    el.linkTitle = el.mdLinkTitle;
    el.linkConfirm = el.mdLinkConfirm;
    el.linkCancel = el.mdLinkCancel;
    el.linkOverlay = el.mdLinkOverlay;
    el.formulaInput = el.mdFormulaInput;
    el.formulaPreview = el.mdFormulaPreview;
    el.formulaOverlay = el.mdFormulaOverlay;
    el.fmlInline = el.mdFmlInline;
    el.fmlBlock = el.mdFmlBlock;
    el.fmlConfirm = el.mdFmlConfirm;
    el.fmlCancel = el.mdFmlCancel;
    el.funcExpr = el.mdFuncExpr;
    el.funcOverlay = el.mdFuncOverlay;
    el.funcConfirm = el.mdFuncConfirm;
    el.funcCancel = el.mdFuncCancel;
    el.sketchInput = el.mdSketchInput;
    el.sketchOverlay = el.mdSketchOverlay;
    el.sketchConfirm = el.mdSketchConfirm;
    el.sketchCancel = el.mdSketchCancel;
    el.delImgMsg = el.mdDelImgMsg;
    el.delImgRef = el.mdDelImgRef;
    el.delImgBoth = el.mdDelImgBoth;
    el.delImgCancel = el.mdDelImgCancel;
    el.orphanOverlay = el.mdOrphanOverlay;
    el.orphanList = el.mdOrphanList;
    el.orphanDel = el.mdOrphanDel;
    el.orphanClose = el.mdOrphanClose;
  }
  function toCamel(id) { return id.replace(/_([a-z])/g, function (m, c) { return c.toUpperCase(); }); }

  function bindEvents() {
    el.mdEditorClose.addEventListener('click', requestClose);
    el.mdSaveBtn.addEventListener('click', saveAndClose);
    el.mdViewSourceBtn.addEventListener('click', function (e) { e.preventDefault(); toggleSource(); });
    el.mdLinkCardToggle.addEventListener('click', function (e) {
      e.preventDefault();
      linkCardMode = !linkCardMode;
      this.classList.toggle('active', linkCardMode);
      this.textContent = linkCardMode ? '卡片·开' : '卡片';
      renderPane();
    });
    el.mdToolbar = $('mdEditorTitle').parentNode.querySelector('.md-editor-tools');
    if (el.mdToolbar) {
      el.mdToolbar.addEventListener('mousedown', function (e) { if (e.target.closest('.md-tool')) e.preventDefault(); });
      el.mdToolbar.addEventListener('click', function (e) {
        const b = e.target.closest('.md-tool');
        if (b && b.dataset.cmd) { toolbarCommand(b.dataset.cmd); }
      });
    }
    // 渲染区输入 → 源码（防抖）
    el.mdRenderInner.addEventListener('input', scheduleSync);
    el.mdRenderInner.addEventListener('keydown', function (e) { if (e.key === 'Tab') { e.preventDefault(); insertMdIntoPane('    ', false); } });
    el.mdRenderInner.addEventListener('scroll', function () { checkRenderScrollEnd(); if (virtualOn) scheduleVirtual(); });
    el.mdRenderInner.addEventListener('focus', function () { if (virtualOn) disableVirtual(); });
    el.mdRenderInner.addEventListener('blur', function () { if (blocks.length > VIRTUAL_THRESHOLD) { virtualOn = true; renderVirtual(); } });
    // 双击图片 → 替换；点击删除按钮
    el.mdRenderInner.addEventListener('dblclick', function (e) {
      const wrap = e.target.closest('.md-img');
      if (wrap) { e.preventDefault(); openImageDialog(wrap); }
    });
    el.mdRenderInner.addEventListener('click', function (e) {
      const del = e.target.closest('.md-img-del');
      if (del) {
        e.preventDefault(); e.stopPropagation();
        const wrap = del.closest('.md-img');
        const rel = wrap.getAttribute('data-src') || '';
        const isLocal = rel.indexOf('/resource/repo/') === 0;
        el.delImgMsg.textContent = '确定删除这张图片吗？' + (isLocal ? '（本地图片可同时删除服务器文件）' : '（网络图片仅移除引用）');
        pendingImageWrap = wrap;
        el.mdDelImgOverlay.classList.add('visible');
      }
    });
    // 拖拽缩放
    el.mdRenderInner.addEventListener('mousedown', function (e) {
      const h = e.target.closest('.md-img-resize-handle');
      if (!h) return;
      e.preventDefault();
      const wrap = h.closest('.md-img');
      const img = wrap.querySelector('img');
      const startX = e.clientX;
      const startW = img.offsetWidth;
      const move = function (ev) {
        const w = Math.max(40, startW + (ev.clientX - startX));
        img.style.width = w + 'px';
        wrap.setAttribute('data-w', String(Math.round(w)));
      };
      const up = function () {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        doSync();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    // 拖拽 / 粘贴图片上传
    el.mdRenderInner.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    el.mdRenderInner.addEventListener('drop', function (e) {
      e.preventDefault();
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        const f = Array.prototype.find.call(files, function (x) { return x.type && x.type.indexOf('image/') === 0; });
        if (f) { uploadAndInsert(f); return; }
      }
      // 拖入 markdown 文本
      const dt = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (dt) insertMdIntoPane(dt, false);
    });
    el.mdRenderInner.addEventListener('paste', function (e) {
      const items = e.clipboardData && e.clipboardData.items;
      if (items) {
        for (const it of items) {
          if (it.type && it.type.indexOf('image/') === 0) {
            e.preventDefault();
            const f = it.getAsFile();
            if (f) { uploadAndInsert(f); return; }
          }
        }
      }
    });
    // 函数曲线：绘制到画布
    el.mdRenderInner.addEventListener('click', function (e) {
      const btn = e.target.closest('.md-func-btn');
      if (btn) {
        e.preventDefault(); e.stopPropagation();
        const f = btn.closest('.md-func');
        const expr = b64d(f.getAttribute('data-expr') || '');
        plotToCanvas(expr);
      }
    });
    // 分栏拖拽
    el.mdSplitter.addEventListener('mousedown', function (e) {
      e.preventDefault();
      const rect = el.mdEditorBody.getBoundingClientRect();
      const startX = e.clientX;
      const startW = el.mdRenderPane.getBoundingClientRect().width;
      el.mdEditorBody.classList.add('dragging-splitter');
      const move = function (ev) {
        const renderW = Math.max(120, Math.min(rect.width - 120, startW + (ev.clientX - startX)));
        const pct = Math.min(85, Math.max(15, (renderW / rect.width) * 100));
        el.mdRenderPane.style.flex = '1 1 ' + pct + '%';
        el.mdSourcePane.style.flex = '1 1 ' + (100 - pct) + '%';
        try { localStorage.setItem(LS_SPLIT, String(Math.round(pct))); } catch (e2) { }
      };
      const up = function () {
        el.mdEditorBody.classList.remove('dragging-splitter');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    // 源码区事件（懒初始化）
    // 一级 / 二级确认
    el.mdConfirm1Save.addEventListener('click', function () { el.mdConfirm1Overlay.classList.remove('visible'); saveAndClose(); });
    el.mdConfirm1Cancel.addEventListener('click', function () {
      el.mdConfirm1Overlay.classList.remove('visible');
      el.mdConfirm2Overlay.classList.add('visible');
    });
    el.mdConfirm2Back.addEventListener('click', function () { el.mdConfirm2Overlay.classList.remove('visible'); });
    el.mdConfirm2Quit.addEventListener('click', function () {
      el.mdConfirm2Overlay.classList.remove('visible');
      closeEditor();
    });
    // 图片弹窗
    el.mdImgPickBtn.addEventListener('click', function () { el.mdImgFile.click(); });
    el.mdImgFile.addEventListener('change', function () {
      const f = this.files && this.files[0];
      if (!f) return;
      pendingUploadFile = f;
      el.imgLocalInfo.style.display = 'block';
      el.imgLocalInfo.textContent = '已选择：' + f.name + '（' + Math.round(f.size / 1024) + ' KB）';
    });
    el.mdImgTabLocal.addEventListener('click', function () { setImgTab('local'); });
    el.mdImgTabUrl.addEventListener('click', function () { setImgTab('url'); });
    el.mdImgConfirm.addEventListener('click', confirmImage);
    el.mdImgCancel.addEventListener('click', function () { el.mdImageOverlay.classList.remove('visible'); pendingImageWrap = null; });
    // 链接弹窗
    el.mdLinkConfirm.addEventListener('click', confirmLink);
    el.mdLinkCancel.addEventListener('click', function () { el.mdLinkOverlay.classList.remove('visible'); });
    el.mdLinkUrl.addEventListener('keydown', function (e) { if (e.key === 'Enter') confirmLink(); });
    // 公式弹窗
    el.mdFmlInline.addEventListener('click', function () { setFormulaMode('inline'); });
    el.mdFmlBlock.addEventListener('click', function () { setFormulaMode('block'); });
    el.mdFormulaInput.addEventListener('input', previewFormula);
    el.mdFmlConfirm.addEventListener('click', confirmFormula);
    el.mdFmlCancel.addEventListener('click', function () { el.mdFormulaOverlay.classList.remove('visible'); });
    // 函数弹窗
    el.mdFuncConfirm.addEventListener('click', confirmFunc);
    el.mdFuncCancel.addEventListener('click', function () { el.mdFuncOverlay.classList.remove('visible'); });
    el.mdFuncExpr.addEventListener('keydown', function (e) { if (e.key === 'Enter') confirmFunc(); });
    // sketch 弹窗
    el.mdSketchConfirm.addEventListener('click', confirmSketch);
    el.mdSketchCancel.addEventListener('click', function () { el.mdSketchOverlay.classList.remove('visible'); });
    // 删除图片弹窗
    el.mdDelImgRef.addEventListener('click', function () { el.mdDelImgOverlay.classList.remove('visible'); deleteImageAt(pendingImageWrap ? (pendingImageWrap.getAttribute('data-src') || '') : '', false); });
    el.mdDelImgBoth.addEventListener('click', function () { el.mdDelImgOverlay.classList.remove('visible'); deleteImageAt(pendingImageWrap ? (pendingImageWrap.getAttribute('data-src') || '') : '', true); });
    el.mdDelImgCancel.addEventListener('click', function () { el.mdDelImgOverlay.classList.remove('visible'); pendingImageWrap = null; });
    // 孤立图片弹窗
    el.mdOrphanDel.addEventListener('click', deleteSelectedOrphans);
    el.mdOrphanClose.addEventListener('click', function () { el.mdOrphanOverlay.classList.remove('visible'); });
    // Esc 关闭
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && el.mdEditorOverlay.classList.contains('visible')) {
        const anyMini = ['mdImageOverlay', 'mdLinkOverlay', 'mdFormulaOverlay', 'mdFuncOverlay', 'mdSketchOverlay', 'mdDelImgOverlay', 'mdOrphanOverlay'].some(function (id) { return el[toCamel(id)] && el[toCamel(id)].classList.contains('visible'); });
        if (anyMini) {
          ['mdImageOverlay', 'mdLinkOverlay', 'mdFormulaOverlay', 'mdFuncOverlay', 'mdSketchOverlay', 'mdDelImgOverlay', 'mdOrphanOverlay'].forEach(function (id) { const o = el[toCamel(id)]; if (o) o.classList.remove('visible'); });
          return;
        }
        e.preventDefault();
        requestClose();
      }
    });
  }

  function toggleSource() {
    sourceOpen = !sourceOpen;
    el.mdEditorBody.classList.toggle('show-source', sourceOpen);
    el.mdViewSourceBtn.classList.toggle('active', sourceOpen);
    el.mdViewSourceBtn.textContent = sourceOpen ? '隐藏源码' : '查看源码';
    if (sourceOpen) {
      if (!sourceInited) {
        sourceInited = true;
        const ta = document.createElement('textarea');
        ta.id = 'mdSourceArea';
        ta.spellcheck = false;
        ta.placeholder = 'Markdown 源码（失焦后自动解析渲染左侧）';
        const wrap = el.mdSourcePane.querySelector('.md-source-wrap');
        wrap.appendChild(ta);
        el.sourceArea = ta;
        ta.addEventListener('input', function () {
          sourceMd = ta.value;
          scheduleValidate();
          if (sourceOpen) checkSourceScrollEnd();
        });
        ta.addEventListener('scroll', function () {
          el.mdLineNo.scrollTop = ta.scrollTop;
          checkSourceScrollEnd();
        });
        ta.addEventListener('blur', function () {
          sourceMd = ta.value;
          renderPane();
        });
        ta.value = sourceMd;
      }
      el.sourceArea.value = sourceMd;
      updateLineNumbers();
      setTimeout(function () { el.sourceArea.scrollTop = 0; }, 0);
    } else {
      if (sourceInited) { sourceMd = el.sourceArea.value; }
    }
  }

  function checkSourceScrollEnd() {
    if (!sourceInited || !el.sourceArea) return;
    const ta = el.sourceArea;
    if (ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 30) el.sourceEnd.classList.add('show');
    else el.sourceEnd.classList.remove('show');
  }

  function applySplitPref() {
    try {
      const pct = parseInt(localStorage.getItem(LS_SPLIT), 10);
      if (pct >= 15 && pct <= 85) {
        el.mdRenderPane.style.flex = '1 1 ' + pct + '%';
        el.mdSourcePane.style.flex = '1 1 ' + (100 - pct) + '%';
      }
    } catch (e) { }
  }

  /* ---------------- 函数曲线联动画布 ---------------- */
  function plotToCanvas(expr) {
    if (!window.addFuncItem) { toast('画布功能不可用'); return; }
    addFuncItem();
    setTimeout(function () {
      const card = document.querySelector('.item-card.selected [data-expr]');
      if (!card) { toast('无法定位画布函数项'); return; }
      card.value = expr;
      card.dispatchEvent(new Event('input', { bubbles: true }));
      card.dispatchEvent(new Event('blur', { bubbles: true }));
      toast('已加入画布：' + expr);
    }, 60);
  }

  function init() {
    cacheDom();
    bindEvents();
    loadImgIndex();
    loadSettings();
    const ta = $('analysisTextarea');
    if (ta) renderAnalysisMarkdown(ta.value);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.MDEDIT = {
    open: open,
    close: closeEditor,
    saveAndClose: saveAndClose,
    toggleSource: toggleSource,
    renderQuestionMarkdown: renderQuestionMarkdown,
    renderAnalysisMarkdown: renderAnalysisMarkdown,
    openOrphanManager: openOrphanManager,
    validate: function (md) { return validateSource(md); },
    toHtml: function (md) { return mdToHtmlReadOnly(md); }
  };
})();
