/* ============================================================
 * html-see 函数绘制器 - 增强功能模块
 * 提供：撤销重做、鼠标缩放、导出PNG、交点标注、切线法线、
 *       测量工具、主题系统、函数表格、GeoGebra面板、移动端适配
 * 加载方式：在 script.js 之后通过 <script src="enhancements.js"> 引入
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 工具函数 ----------
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => (root || document).querySelectorAll(sel);
  const el = (tag, attrs, children) => {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'style') e.style.cssText = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (children) (Array.isArray(children) ? children : [children]).forEach(c => {
      if (c == null) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // 等待核心脚本初始化完成
  function waitForCore(cb) {
    if (typeof items !== 'undefined' && typeof view !== 'undefined' && $('canvas')) {
      cb();
    } else {
      setTimeout(() => waitForCore(cb), 50);
    }
  }

  // ============================================================
  // 1. 撤销 / 重做 历史栈
  // ============================================================
  const History = {
    stack: [],
    index: -1,
    max: 80,
    locked: false,

    snapshot() {
      if (this.locked) return;
      // 截断 redo 部分
      this.stack = this.stack.slice(0, this.index + 1);
      const snap = {
        items: JSON.parse(JSON.stringify(items || [])),
        folders: JSON.parse(JSON.stringify(folders || [])),
        view: JSON.parse(JSON.stringify(view || {})),
      };
      this.stack.push(snap);
      if (this.stack.length > this.max) this.stack.shift();
      this.index = this.stack.length - 1;
      this.updateUI();
    },

    restore(snap) {
      if (!snap) return;
      this.locked = true;
      try {
        items.length = 0;
        snap.items.forEach(it => items.push(it));
        folders.length = 0;
        snap.folders.forEach(f => folders.push(f));
        Object.assign(view, snap.view);
        if (typeof updateDisplayValues === 'function') updateDisplayValues();
        if (typeof renderItemList === 'function') renderItemList();
        if (typeof fullRender === 'function') fullRender();
        else if (typeof renderFull === 'function') renderFull();
      } finally {
        this.locked = false;
      }
    },

    undo() {
      if (this.index > 0) {
        this.index--;
        this.restore(this.stack[this.index]);
        this.updateUI();
      }
    },

    redo() {
      if (this.index < this.stack.length - 1) {
        this.index++;
        this.restore(this.stack[this.index]);
        this.updateUI();
      }
    },

    updateUI() {
      const ub = $('enhUndoBtn'), rb = $('enhRedoBtn');
      if (ub) ub.style.opacity = this.index > 0 ? '1' : '0.4';
      if (rb) rb.style.opacity = this.index < this.stack.length - 1 ? '1' : '0.4';
    },

    // 包装函数：执行前自动快照
    wrap(fn) {
      return function (...args) {
        History.snapshot();
        return fn.apply(this, args);
      };
    },
  };

  // ============================================================
  // 2. 鼠标位置为锚点的滚轮缩放
  // ============================================================
  function initWheelZoom() {
    const canvas = $('canvas') || document.querySelector('canvas');
    if (!canvas) return;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (typeof view === 'undefined') return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const oldPS = view.gridPixelSize;
      const newPS = clamp(oldPS * factor, 0.1, 10);
      const ratio = newPS / oldPS;
      // 以鼠标位置为锚点：ox = mx - (mx - ox) * ratio
      view.ox = mx - (mx - view.ox) * ratio;
      view.oy = my - (my - view.oy) * ratio;
      view.gridPixelSize = newPS;
      if (typeof updateDisplayValues === 'function') updateDisplayValues();
      if (typeof fullRender === 'function') fullRender();
      else if (typeof renderFull === 'function') renderFull();
    }, { passive: false });
  }

  // ============================================================
  // 3. 导出 PNG 图片
  // ============================================================
  function exportPNG() {
    const canvas = $('canvas') || document.querySelector('canvas');
    if (!canvas) { alert('未找到画布'); return; }
    // 创建带白色背景的导出canvas
    const exp = document.createElement('canvas');
    exp.width = canvas.width;
    exp.height = canvas.height;
    const ctx = exp.getContext('2d');
    // 读取当前主题背景色
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg') || '#ffffff';
    ctx.fillStyle = bg.trim() || '#ffffff';
    ctx.fillRect(0, 0, exp.width, exp.height);
    ctx.drawImage(canvas, 0, 0);
    const link = document.createElement('a');
    link.download = '函数绘制器_' + new Date().toISOString().slice(0, 10) + '.png';
    link.href = exp.toDataURL('image/png');
    link.click();
  }

  // ============================================================
  // 4. 表达式语法错误实时提示（增强）
  // ============================================================
  function initExprValidation() {
    document.addEventListener('input', (e) => {
      if (!e.target.classList.contains('func-expr')) return;
      const id = e.target.getAttribute('data-expr');
      const item = (items || []).find(it => it.id === id);
      if (!item) return;
      const expr = e.target.value.trim();
      const errEl = document.querySelector('[data-err="' + id + '"]');
      if (!expr) {
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
        item.errorMsg = '';
        return;
      }
      const err = validateExpression(expr);
      if (err) {
        if (errEl) { errEl.style.display = 'block'; errEl.textContent = '⚠ ' + err; }
        item.errorMsg = err;
      } else {
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
        item.errorMsg = '';
      }
    });
  }

  function validateExpression(expr) {
    // 基础语法检查
    const checks = [
      { re: /\^\s*\^/, msg: '连续的 ^ 运算符' },
      { re: /[+\-*/^]\s*$/, msg: '表达式末尾有多余运算符' },
      { re: /^[+\-*/^]/, msg: '表达式开头不能是运算符（负号除外）' },
      { re: /\(\s*\)/, msg: '空括号' },
      { re: /\/\s*0(?!\d|\.)/, msg: '除以零' },
      { re: /sin\s*\(|cos\s*\(|tan\s*\(|log\s*\(|sqrt\s*\(|abs\s*\(/i, msg: null },
    ];
    // 括号匹配
    let depth = 0;
    for (const ch of expr) {
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth < 0) return '括号不匹配：多余的右括号'; }
    }
    if (depth > 0) return '括号不匹配：缺少 ' + depth + ' 个右括号';
    for (const c of checks) {
      if (c.msg && c.re.test(expr)) return c.msg;
    }
    // 检查未定义函数（简单启发式）
    const funcs = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
      'sqrt', 'abs', 'log', 'ln', 'exp', 'floor', 'ceil', 'round', 'sign', 'min', 'max', 'pow'];
    const funcMatches = expr.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g) || [];
    for (const m of funcMatches) {
      const name = m.replace(/\s*\(/, '').toLowerCase();
      if (!funcs.includes(name) && name !== 'x' && name !== 'y') {
        // 可能是参数名，不报错
      }
    }
    return null;
  }

  // ============================================================
  // 5. 交点 / 零点自动标注
  // ============================================================
  const Analyzer = {
    enabled: false,
    points: [], // {x,y,type,label}

    toggle() {
      this.enabled = !this.enabled;
      const btn = $('enhAnalyzeBtn');
      if (btn) btn.classList.toggle('active', this.enabled);
      if (this.enabled) this.compute();
      else { this.points = []; if (typeof fullRender === 'function') fullRender(); }
    },

    compute() {
      this.points = [];
      const funcs = (items || []).filter(it => it.type === 'function' && !it.hidden && it.expr && !it.errorMsg);
      if (funcs.length === 0) return;
      // 采样范围（基于当前视图）
      const ppuVal = typeof ppu === 'function' ? ppu() : (view.gridPixelSize / view.gridUnitLength);
      const xMin = (0 - view.ox) / ppuVal;
      const xMax = ($('canvas').width - view.ox) / ppuVal;
      const steps = 600;
      const dx = (xMax - xMin) / steps;

      // 对每个显式函数 y=f(x) 找零点
      funcs.forEach(f => {
        if (f.expr.includes('=') && !/^\s*y\s*=/.test(f.expr)) return; // 隐式跳过
        const fn = compileExpr(f.expr);
        if (!fn) return;
        let prevY = fn(xMin), prevX = xMin;
        for (let i = 1; i <= steps; i++) {
          const x = xMin + i * dx;
          const y = fn(x);
          if (prevY !== null && y !== null && prevY * y < 0) {
            // 二分求精
            let lo = prevX, hi = x, loY = prevY, hiY = y;
            for (let j = 0; j < 30; j++) {
              const mid = (lo + hi) / 2, midY = fn(mid);
              if (midY === null) break;
              if (loY * midY < 0) { hi = mid; hiY = midY; }
              else { lo = mid; loY = midY; }
            }
            const zx = (lo + hi) / 2;
            this.points.push({ x: zx, y: 0, type: 'zero', label: '零点 x=' + zx.toFixed(3), color: f.color });
          }
          prevX = x; prevY = y;
        }
      });

      // 找两两函数交点
      for (let i = 0; i < funcs.length; i++) {
        for (let j = i + 1; j < funcs.length; j++) {
          const f1 = compileExpr(funcs[i].expr), f2 = compileExpr(funcs[j].expr);
          if (!f1 || !f2) continue;
          let prevY1 = f1(xMin), prevY2 = f2(xMin), prevX = xMin;
          for (let k = 1; k <= steps; k++) {
            const x = xMin + k * dx;
            const y1 = f1(x), y2 = f2(x);
            if (prevY1 !== null && prevY2 !== null && y1 !== null && y2 !== null) {
              const d1 = prevY1 - prevY2, d2 = y1 - y2;
              if (d1 * d2 < 0) {
                let lo = prevX, hi = x, loD = d1, hiD = d2;
                for (let m = 0; m < 30; m++) {
                  const mid = (lo + hi) / 2, midD = f1(mid) - f2(mid);
                  if (midD === null || isNaN(midD)) break;
                  if (loD * midD < 0) { hi = mid; hiD = midD; }
                  else { lo = mid; loD = midD; }
                }
                const ix = (lo + hi) / 2, iy = f1(ix);
                this.points.push({ x: ix, y: iy, type: 'intersect', label: '交点 (' + ix.toFixed(2) + ',' + iy.toFixed(2) + ')', color: '#f59e0b' });
              }
            }
            prevX = x; prevY1 = y1; prevY2 = y2;
          }
        }
      }
      if (typeof fullRender === 'function') fullRender();
    },

    draw(ctx) {
      if (!this.enabled || this.points.length === 0) return;
      const ppuVal = typeof ppu === 'function' ? ppu() : (view.gridPixelSize / view.gridUnitLength);
      this.points.forEach(p => {
        const sx = p.x * ppuVal + view.ox;
        const sy = view.oy - p.y * ppuVal;
        ctx.save();
        ctx.fillStyle = p.color;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 标签
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.font = '11px sans-serif';
        const tw = ctx.measureText(p.label).width;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(sx + 10, sy - 18, tw + 8, 18);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 10, sy - 18, tw + 8, 18);
        ctx.fillStyle = '#333';
        ctx.fillText(p.label, sx + 14, sy - 5);
        ctx.restore();
      });
    },
  };

  // 简易表达式编译器（支持 y= 形式和基本函数）
  function compileExpr(rawExpr) {
    let expr = rawExpr.replace(/^\s*y\s*=\s*/, '').trim();
    // 替换 ^ 为 **
    expr = expr.replace(/\^/g, '**');
    // 替换常量
    expr = expr.replace(/\bpi\b/gi, 'Math.PI').replace(/\be\b/g, 'Math.E');
    // 替换函数
    const funcMap = {
      sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan',
      asin: 'Math.asin', acos: 'Math.acos', atan: 'Math.atan',
      sqrt: 'Math.sqrt', abs: 'Math.abs', log: 'Math.log10',
      ln: 'Math.log', exp: 'Math.exp', floor: 'Math.floor',
      ceil: 'Math.ceil', round: 'Math.round', sign: 'Math.sign',
      min: 'Math.min', max: 'Math.max', pow: 'Math.pow',
      sinh: 'Math.sinh', cosh: 'Math.cosh', tanh: 'Math.tanh',
    };
    for (const k in funcMap) {
      expr = expr.replace(new RegExp('\\b' + k + '\\b', 'gi'), funcMap[k]);
    }
    try {
      const fn = new Function('x', 'try { return ' + expr + '; } catch(e) { return null; }');
      // 测试
      const test = fn(1);
      if (typeof test !== 'number' && test !== null) return null;
      return fn;
    } catch (e) {
      return null;
    }
  }

  // ============================================================
  // 6. 切线 / 法线工具
  // ============================================================
  const TangentTool = {
    active: false,
    selectedFunc: null,
    tangentLine: null, // {x, slope, type:'tangent'|'normal'}

    toggle() {
      this.active = !this.active;
      const btn = $('enhTangentBtn');
      if (btn) btn.classList.toggle('active', this.active);
      if (!this.active) { this.tangentLine = null; this.selectedFunc = null; if (typeof fullRender === 'function') fullRender(); }
      else { this.showHint(); }
    },

    showHint() {
      const funcs = (items || []).filter(it => it.type === 'function' && !it.hidden && it.expr);
      if (funcs.length === 0) { alert('请先添加至少一个函数'); this.toggle(); return; }
      // 让用户选择函数
      const names = funcs.map((f, i) => (i + 1) + '. y=' + f.expr).join('\n');
      const idx = prompt('选择要绘制切线的函数（输入序号）：\n' + names, '1');
      if (idx === null) { this.toggle(); return; }
      const n = parseInt(idx) - 1;
      if (isNaN(n) || n < 0 || n >= funcs.length) { alert('无效序号'); this.toggle(); return; }
      this.selectedFunc = funcs[n];
      // 让用户输入x值
      const xv = prompt('输入切点的 x 坐标：', '1');
      if (xv === null) { this.toggle(); return; }
      const x = parseFloat(xv);
      if (isNaN(x)) { alert('无效数值'); this.toggle(); return; }
      const fn = compileExpr(this.selectedFunc.expr);
      if (!fn) { alert('函数无法解析'); this.toggle(); return; }
      const y = fn(x);
      if (y === null || isNaN(y)) { alert('该 x 处函数无定义'); this.toggle(); return; }
      // 数值求导
      const h = 0.0001;
      const slope = (fn(x + h) - fn(x - h)) / (2 * h);
      this.tangentLine = { x, y, slope, type: 'tangent', color: this.selectedFunc.color };
      if (typeof fullRender === 'function') fullRender();
    },

    draw(ctx) {
      if (!this.active || !this.tangentLine) return;
      const t = this.tangentLine;
      const ppuVal = typeof ppu === 'function' ? ppu() : (view.gridPixelSize / view.gridUnitLength);
      const canvas = $('canvas');
      // 画切线（贯穿整个画布宽度）
      const x1 = (0 - view.ox) / ppuVal;
      const x2 = (canvas.width - view.ox) / ppuVal;
      const y1 = t.y + t.slope * (x1 - t.x);
      const y2 = t.y + t.slope * (x2 - t.x);
      ctx.save();
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(x1 * ppuVal + view.ox, view.oy - y1 * ppuVal);
      ctx.lineTo(x2 * ppuVal + view.ox, view.oy - y2 * ppuVal);
      ctx.stroke();
      ctx.setLineDash([]);
      // 切点
      const sx = t.x * ppuVal + view.ox, sy = view.oy - t.y * ppuVal;
      ctx.fillStyle = t.color;
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fill();
      // 信息标签
      const info = '切线: y=' + t.slope.toFixed(3) + '(x-' + t.x.toFixed(2) + ')+' + t.y.toFixed(3) +
        '\n斜率 k=' + t.slope.toFixed(4);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 1;
      const lines = info.split('\n');
      const boxW = 220, boxH = lines.length * 16 + 10;
      ctx.fillRect(sx + 12, sy + 10, boxW, boxH);
      ctx.strokeRect(sx + 12, sy + 10, boxW, boxH);
      ctx.fillStyle = '#333';
      ctx.font = '12px sans-serif';
      lines.forEach((l, i) => ctx.fillText(l, sx + 18, sy + 26 + i * 16));
      ctx.restore();
    },
  };

  // ============================================================
  // 7. 测量工具（临时，不存入项目数据）
  // ============================================================
  const MeasureTool = {
    active: false,
    mode: 'distance', // distance | angle | area
    points: [], // 已选坐标点：{ item, x, y, sx, sy }
    overlay: null,

    getSelectablePoints() {
      return (items || []).filter(it => it.type === 'point' && !it.hidden && !it.errorMsg);
    },

    pointScreenPos(p) {
      const ppuVal = typeof ppu === 'function' ? ppu() : (view.gridPixelSize / view.gridUnitLength);
      return { sx: p.x * ppuVal + view.ox, sy: view.oy - p.y * ppuVal };
    },

    // 吸附到最近的项目坐标点；距离超过容差返回 null（不允许随便取点）
    findNearbyPoint(sx, sy) {
      const pts = this.getSelectablePoints();
      let best = null, bestD = Infinity;
      for (const p of pts) {
        const pos = this.pointScreenPos(p);
        const d = Math.hypot(pos.sx - sx, pos.sy - sy);
        if (d < bestD) { bestD = d; best = { item: p, sx: pos.sx, sy: pos.sy }; }
      }
      const hitPx = Math.max(16, ((view && view.pointSize) || 4) + 10);
      return best && bestD <= hitPx ? best : null;
    },

    toggle(mode) {
      if (this.active && this.mode === mode) {
        this.deactivate();
        return;
      }
      this.active = true;
      this.mode = mode || 'distance';
      this.points = [];
      this.ensureOverlay();
      if (this.overlay) this.overlay.style.display = 'block';
      this.updateToolbarUI();
      this.showModeHint();
      this.updateStatus();
    },

    deactivate() {
      this.active = false;
      this.points = [];
      if (this.overlay) this.overlay.style.display = 'none';
      this.updateToolbarUI();
      this.updateStatus();
      if (typeof fullRender === 'function') fullRender();
    },

    ensureOverlay() {
      if (this.overlay) return;
      const canvas = $('canvas');
      if (!canvas) return;
      const ov = document.createElement('canvas');
      ov.id = 'measureOverlay';
      ov.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:5;';
      ov.width = canvas.width;
      ov.height = canvas.height;
      canvas.parentElement.style.position = canvas.parentElement.style.position || 'relative';
      canvas.parentElement.appendChild(ov);
      this.overlay = ov;
      // 同步尺寸
      const ro = new ResizeObserver(() => {
        ov.width = canvas.width; ov.height = canvas.height;
        this.redraw();
      });
      ro.observe(canvas);
    },

    showModeHint() {
      const hints = {
        distance: '距离测量：依次点击两个已存在的坐标点，测量两点间距离',
        angle: '角度测量：依次点击三个已存在的坐标点（顶点在中间），测量夹角',
        area: '面积测量：依次点击多个已存在的坐标点围成多边形，双击结束',
      };
      showToast(hints[this.mode] || '测量工具');
      this.updateStatus(hints[this.mode]);
    },

    handleClick(e) {
      if (!this.active) return;
      const canvas = $('canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const hit = this.findNearbyPoint(sx, sy);
      if (!hit) {
        showToast('未选中坐标点：请点击画布上已存在的坐标点');
        this.updateStatus('未命中坐标点，请点击项目数据中已存在的坐标点');
        return;
      }
      if (this.points.some(p => p.item.id === hit.item.id)) {
        showToast('该点已选中：' + (hit.item.label || hit.item.id));
        return;
      }
      this.points.push({ item: hit.item, x: hit.item.x, y: hit.item.y, sx: hit.sx, sy: hit.sy });
      this.redraw();
      this.updateStatus();

      const need = this.mode === 'distance' ? 2 : this.mode === 'angle' ? 3 : Infinity;
      if (need !== Infinity && this.points.length >= need) {
        this.compute();
        // 完成一组后清空，便于连续测量下一组
        setTimeout(() => {
          this.points = [];
          this.redraw();
          this.updateStatus();
        }, 1500);
      }
    },

    handleDblClick() {
      if (this.active && this.mode === 'area' && this.points.length >= 3) {
        this.compute();
        setTimeout(() => {
          this.points = [];
          this.redraw();
          this.updateStatus();
        }, 1500);
      }
    },

    compute() {
      let record = null;
      const fmt = (v) => (Math.round(v * 10000) / 10000).toString();
      if (this.mode === 'distance' && this.points.length >= 2) {
        const [a, b] = this.points;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        record = { title: '距离 ' + (a.item.label || 'P1') + '→' + (b.item.label || 'P2'), value: fmt(dist) };
      } else if (this.mode === 'angle' && this.points.length >= 3) {
        const [a, b, c] = this.points;
        const v1 = { x: a.x - b.x, y: a.y - b.y };
        const v2 = { x: c.x - b.x, y: c.y - b.y };
        const dot = v1.x * v2.x + v1.y * v2.y;
        const m1 = Math.hypot(v1.x, v1.y), m2 = Math.hypot(v2.x, v2.y);
        const deg = (m1 === 0 || m2 === 0) ? 0 : Math.acos(clamp(dot / (m1 * m2), -1, 1)) * 180 / Math.PI;
        record = { title: '角度 ∠' + (a.item.label || 'P1') + (b.item.label || 'P2') + (c.item.label || 'P3'), value: fmt(deg) + '°' };
      } else if (this.mode === 'area' && this.points.length >= 3) {
        let area = 0;
        for (let i = 0; i < this.points.length; i++) {
          const j = (i + 1) % this.points.length;
          area += this.points[i].x * this.points[j].y;
          area -= this.points[j].x * this.points[i].y;
        }
        area = Math.abs(area) / 2;
        const names = this.points.map(p => p.item.label || 'P').join('-');
        record = { title: '面积 ' + names, value: fmt(area) };
      }
      if (record) {
        DataPanel.addRecord(record);
        showToast('已记录到「数据」栏：' + record.title + ' = ' + record.value);
      }
    },

    redraw() {
      if (!this.overlay) return;
      const ctx = this.overlay.getContext('2d');
      ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
      if (this.points.length === 0) return;

      ctx.save();
      // 画点（使用坐标点的标签）
      this.points.forEach((p, i) => {
        ctx.fillStyle = '#ef4444';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(p.item.label || ('P' + (i + 1)), p.sx + 8, p.sy - 8);
      });

      if (this.mode === 'distance' && this.points.length >= 2) {
        const [a, b] = this.points;
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
        ctx.setLineDash([]);
        const dist = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
        const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
        this.drawLabel(ctx, mx, my, '距离 = ' + dist.toFixed(4));
      }

      if (this.mode === 'angle' && this.points.length >= 3) {
        const [a, b, c] = this.points;
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.lineTo(c.sx, c.sy);
        ctx.stroke();
        const v1 = { x: a.x - b.x, y: a.y - b.y };
        const v2 = { x: c.x - b.x, y: c.y - b.y };
        const dot = v1.x * v2.x + v1.y * v2.y;
        const m1 = Math.sqrt(v1.x ** 2 + v1.y ** 2);
        const m2 = Math.sqrt(v2.x ** 2 + v2.y ** 2);
        const angleRad = (m1 === 0 || m2 === 0) ? 0 : Math.acos(clamp(dot / (m1 * m2), -1, 1));
        const angleDeg = angleRad * 180 / Math.PI;
        const r = 25;
        const a1 = Math.atan2(a.sy - b.sy, a.sx - b.sx);
        const a2 = Math.atan2(c.sy - b.sy, c.sx - b.sx);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.sx, b.sy, r, Math.min(a1, a2), Math.max(a1, a2));
        ctx.stroke();
        this.drawLabel(ctx, b.sx + 35, b.sy - 10, '角度 = ' + angleDeg.toFixed(2) + '°');
      }

      if (this.mode === 'area' && this.points.length >= 3) {
        ctx.strokeStyle = '#3b82f6';
        ctx.fillStyle = 'rgba(59,130,246,0.15)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(this.points[0].sx, this.points[0].sy);
        for (let i = 1; i < this.points.length; i++) ctx.lineTo(this.points[i].sx, this.points[i].sy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        let area = 0;
        for (let i = 0; i < this.points.length; i++) {
          const j = (i + 1) % this.points.length;
          area += this.points[i].x * this.points[j].y;
          area -= this.points[j].x * this.points[i].y;
        }
        area = Math.abs(area) / 2;
        const cx = this.points.reduce((s, p) => s + p.sx, 0) / this.points.length;
        const cy = this.points.reduce((s, p) => s + p.sy, 0) / this.points.length;
        this.drawLabel(ctx, cx, cy, '面积 = ' + area.toFixed(4));
      }
      ctx.restore();
    },

    drawLabel(ctx, x, y, text) {
      ctx.font = '13px sans-serif';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1;
      ctx.fillRect(x - tw / 2 - 6, y - 22, tw + 12, 22);
      ctx.strokeRect(x - tw / 2 - 6, y - 22, tw + 12, 22);
      ctx.fillStyle = '#1e40af';
      ctx.fillText(text, x - tw / 2, y - 7);
    },

    updateToolbarUI() {
      ['distance', 'angle', 'area'].forEach(m => {
        const btn = $('enhMeasure_' + m);
        if (btn) btn.classList.toggle('active', this.active && this.mode === m);
      });
    },

    updateStatus(msg) {
      const el = $('enhMeasureStatus');
      if (!el) return;
      if (msg) { el.innerHTML = msg; return; }
      const need = this.mode === 'distance' ? 2 : this.mode === 'angle' ? 3 : 3;
      const names = this.points.map(p => p.item.label || p.item.id);
      el.innerHTML = this.active
        ? '已选 ' + names.length + '/' + (this.mode === 'area' ? 'N' : need) + '：' + (names.join('、') || '—') + '<br>请点击画布上已存在的坐标点'
        : '选择测量工具后，点击画布上已存在的坐标点进行测量，结果记录在「数据」栏。';
    },
  };

  // ============================================================
  // 7.5 数据面板：测量记录 + 坐标点清单
  // ============================================================
  const DataPanel = {
    records: [],

    init() {
      this.render();
    },

    addRecord(rec) {
      this.records.unshift(rec);
      if (this.records.length > 50) this.records.length = 50;
      this.render();
    },

    clear() {
      this.records = [];
      this.render();
    },

    render() {
      const el = $('enhDataPanel');
      if (!el) return;
      let html = '<div class="tools-sep">测量记录</div>';
      if (this.records.length === 0) {
        html += '<div class="tools-hint">暂无测量记录。切换到「工具」栏使用距离/角度/面积测量（基于项目已有的坐标点），结果会记录在这里。</div>';
      } else {
        this.records.forEach(r => {
          html += '<div class="data-record"><div class="dr-title">' + escapeHtml(r.title) + '</div><div class="dr-val">' + escapeHtml(r.value) + '</div></div>';
        });
        html += '<button class="enh-btn" onclick="Enhancements.DataPanel.clear()" style="color:#e53e3e;">清空测量记录</button>';
      }
      const pts = (items || []).filter(it => it.type === 'point' && !it.hidden && !it.errorMsg);
      html += '<div class="tools-sep">坐标点</div>';
      if (pts.length === 0) {
        html += '<div class="tools-hint">当前项目没有坐标点。可在「+ 添加」菜单中选择「添加坐标点」创建。</div>';
      } else {
        pts.forEach(p => {
          const x = p.x == null ? '?' : p.x.toFixed(2);
          const y = p.y == null ? '?' : p.y.toFixed(2);
          html += '<div class="pt-list-item"><span class="pt-label">' + escapeHtml(p.label || p.id) + '</span><span class="pt-coord">(' + x + ', ' + y + ')</span></div>';
        });
      }
      el.innerHTML = html;
    },
  };

  // ============================================================
  // 8. 主题系统（深色模式 + 多主题）
  // 与 ../js/theme-switcher.js 协同工作
  // ============================================================
  const Theme = {
    current: 'light',

    init() {
      // 读取共享主题切换器的状态
      if (window.EnhTheme) {
        this.current = window.EnhTheme.get();
      } else {
        this.current = localStorage.getItem('htmlsee_theme') || 'light';
        this.apply(this.current);
      }
    },

    apply(name) {
      this.current = name;
      // 通过共享系统切换（会设置 data-theme 和 CSS 变量）
      if (window.EnhTheme) {
        window.EnhTheme.apply(name);
      } else {
        document.documentElement.setAttribute('data-theme', name);
        localStorage.setItem('htmlsee_theme', name);
      }
      // 触发重绘（网格颜色等可能需要更新）
      if (typeof fullRender === 'function') setTimeout(() => fullRender(), 50);
    },
  };

  // ============================================================
  // 9. 函数数值表格
  // ============================================================
  const ValueTable = {
    visible: false,

    toggle() {
      this.visible = !this.visible;
      const panel = $('enhValueTablePanel');
      if (panel) panel.style.display = this.visible ? 'flex' : 'none';
      if (this.visible) this.render();
    },

    render() {
      const panel = $('enhValueTablePanel');
      if (!panel) return;
      const funcs = (items || []).filter(it => it.type === 'function' && !it.hidden && it.expr && !it.errorMsg);
      if (funcs.length === 0) {
        panel.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;">暂无可用函数</div>';
        return;
      }
      // 获取x范围
      const xStart = parseFloat($('enhTableXStart')?.value || '-5');
      const xEnd = parseFloat($('enhTableXEnd')?.value || '5');
      const xStep = parseFloat($('enhTableXStep')?.value || '0.5');
      if (isNaN(xStart) || isNaN(xEnd) || isNaN(xStep) || xStep <= 0) return;

      const compiled = funcs.map(f => ({ item: f, fn: compileExpr(f.expr) })).filter(c => c.fn);
      let html = '<div class="vt-controls"><span>x范围:</span>';
      html += '<input type="number" id="enhTableXStart" value="' + xStart + '" step="0.5" style="width:60px;">';
      html += '~<input type="number" id="enhTableXEnd" value="' + xEnd + '" step="0.5" style="width:60px;">';
      html += '步长:<input type="number" id="enhTableXStep" value="' + xStep + '" step="0.1" min="0.1" style="width:50px;">';
      html += '<button onclick="Enhancements.ValueTable.render()" style="padding:2px 8px;cursor:pointer;">更新</button></div>';
      html += '<div class="vt-scroll"><table class="vt-table"><thead><tr><th>x</th>';
      compiled.forEach(c => { html += '<th style="color:' + c.item.color + '">y=' + escapeHtml(c.item.expr.slice(0, 12)) + '</th>'; });
      html += '</tr></thead><tbody>';
      for (let x = xStart; x <= xEnd + 0.0001; x += xStep) {
        html += '<tr><td>' + x.toFixed(2) + '</td>';
        compiled.forEach(c => {
          const y = c.fn(x);
          html += '<td>' + (y === null || isNaN(y) || !isFinite(y) ? '—' : y.toFixed(4)) + '</td>';
        });
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      panel.innerHTML = html;
      // 重新绑定事件
      ['enhTableXStart', 'enhTableXEnd', 'enhTableXStep'].forEach(id => {
        const el = $(id);
        if (el) el.addEventListener('change', () => this.render());
      });
    },
  };

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ============================================================
  // 10. Toast 提示
  // ============================================================
  let toastTimer = null;
  function showToast(msg, duration) {
    let t = $('enhToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'enhToast';
      t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.9);color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:99999;opacity:0;transition:opacity 0.3s;pointer-events:none;max-width:80%;text-align:center;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = '0'; }, duration || 2500);
  }

  // ============================================================
  // 11. 移动端适配 & 横屏提示
  // ============================================================
  function initMobile() {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768;
    if (!isMobile) return;
    // 检测竖屏时提示横屏
    const checkOrient = () => {
      if (window.innerHeight > window.innerWidth && !sessionStorage.getItem('enh_orient_dismissed')) {
        const tip = document.createElement('div');
        tip.id = 'enhOrientTip';
        tip.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:99998;font-size:16px;text-align:center;padding:20px;';
        tip.innerHTML = '<div style="font-size:48px;margin-bottom:16px;">📱↻</div><div style="font-size:18px;font-weight:600;margin-bottom:8px;">建议横屏使用</div><div style="color:#aaa;font-size:14px;margin-bottom:20px;">横屏模式下函数绘制器界面更宽敞，操作更方便</div><button style="padding:8px 24px;background:#6366f1;border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;">我知道了</button>';
        tip.querySelector('button').onclick = () => { tip.remove(); sessionStorage.setItem('enh_orient_dismissed', '1'); };
        document.body.appendChild(tip);
      }
    };
    checkOrient();
    window.addEventListener('orientationchange', checkOrient);
  }

  // ============================================================
  // 12. 性能优化：渲染防抖 + 网格缓存
  // ============================================================
  const Perf = {
    renderTimer: null,
    debounceRender() {
      if (this.renderTimer) return;
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        if (typeof fullRender === 'function') fullRender();
      }, 16);
    },
  };

  // ============================================================
  // 13. 项目模板
  // ============================================================
  const Templates = {
    list: [
      { name: '空白项目', icon: '📄', desc: '从零开始', build: () => [] },
      { name: '二次函数', icon: '📈', desc: 'y = ax² + bx + c', build: () => [
        { type: 'function', expr: 'x^2', color: '#6366f1' },
        { type: 'function', expr: '-x^2+4', color: '#22c55e' },
      ]},
      { name: '一次函数', icon: '📏', desc: 'y = kx + b', build: () => [
        { type: 'function', expr: '2*x+1', color: '#6366f1' },
        { type: 'function', expr: '-x+3', color: '#ef4444' },
      ]},
      { name: '反比例函数', icon: '📉', desc: 'y = k/x', build: () => [
        { type: 'function', expr: '1/x', color: '#6366f1' },
        { type: 'function', expr: '-2/x', color: '#f59e0b' },
      ]},
      { name: '三角函数', icon: '🌊', desc: 'sin / cos / tan', build: () => [
        { type: 'function', expr: 'sin(x)', color: '#6366f1' },
        { type: 'function', expr: 'cos(x)', color: '#22c55e' },
        { type: 'function', expr: 'tan(x)', color: '#f59e0b' },
      ]},
      { name: '指数与对数', icon: '📊', desc: 'a^x 与 log_a(x)', build: () => [
        { type: 'function', expr: '2^x', color: '#6366f1' },
        { type: 'function', expr: 'log(x)/log(2)', color: '#22c55e' },
      ]},
      { name: '绝对值函数', icon: '▽', desc: 'y = |x| 变换', build: () => [
        { type: 'function', expr: 'abs(x)', color: '#6366f1' },
        { type: 'function', expr: 'abs(x-2)+1', color: '#8b5cf6' },
      ]},
      { name: '圆与椭圆', icon: '⭕', desc: '隐函数方程', build: () => [
        { type: 'function', expr: 'x^2+y^2=4', color: '#6366f1' },
        { type: 'function', expr: 'x^2/9+y^2/4=1', color: '#ec4899' },
      ]},
      { name: '多项式对比', icon: '📐', desc: 'x, x², x³', build: () => [
        { type: 'function', expr: 'x', color: '#94a3b8' },
        { type: 'function', expr: 'x^2', color: '#6366f1' },
        { type: 'function', expr: 'x^3', color: '#ef4444' },
      ]},
    ],

    show() {
      // 关闭app菜单
      if (typeof closeAppMenu === 'function') closeAppMenu();
      // 创建模板选择弹窗
      let modal = $('enhTemplateModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'enhTemplateModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99990;';
        modal.innerHTML = `
          <div style="background:var(--bg-secondary,#fff);border-radius:12px;padding:20px;max-width:560px;width:90%;max-height:80vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
              <h3 style="margin:0;font-size:18px;color:var(--text-primary,#0f172a);">选择项目模板</h3>
              <button onclick="document.getElementById('enhTemplateModal').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-secondary,#666);">×</button>
            </div>
            <div id="enhTemplateGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;"></div>
            <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border-color,#eee);font-size:12px;color:var(--text-muted,#999);text-align:center;">选择模板后将清空当前项目，建议先保存</div>
          </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
      }
      const grid = modal.querySelector('#enhTemplateGrid');
      grid.innerHTML = '';
      this.list.forEach((t, i) => {
        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid var(--border-color,#e2e8f0);border-radius:8px;padding:12px;cursor:pointer;transition:all 0.15s;text-align:center;';
        card.onmouseenter = () => { card.style.borderColor = 'var(--accent,#6366f1)'; card.style.background = 'var(--bg-tertiary,#f8fafc)'; };
        card.onmouseleave = () => { card.style.borderColor = ''; card.style.background = ''; };
        card.innerHTML = `<div style="font-size:28px;margin-bottom:6px;">${t.icon}</div><div style="font-weight:600;font-size:14px;color:var(--text-primary,#0f172a);margin-bottom:4px;">${t.name}</div><div style="font-size:11px;color:var(--text-muted,#94a3b8);">${t.desc}</div>`;
        card.onclick = () => this.apply(i);
        grid.appendChild(card);
      });
      modal.style.display = 'flex';
    },

    apply(index) {
      const t = this.list[index];
      if (!t) return;
      const doApply = () => {
        History.snapshot();
        // 清空现有items
        if (typeof items !== 'undefined') {
          items.length = 0;
          const newItems = t.build();
          newItems.forEach((it, i) => {
            items.push({
              id: typeof nextItemId === 'function' ? nextItemId('function') : 'func_' + Date.now() + '_' + i,
              type: it.type || 'function',
              expr: it.expr,
              color: it.color || '#6366f1',
              hidden: false,
            });
          });
          if (typeof renderItemList === 'function') renderItemList();
          if (typeof updateItemCount === 'function') updateItemCount();
          if (typeof fullRender === 'function') fullRender();
        }
        $('enhTemplateModal')?.remove();
        showToast('已应用模板：' + t.name);
      };
      // 如果有未保存的更改，提示
      if (typeof isProjectDirty === 'function' && isProjectDirty() && items && items.length > 0) {
        if (confirm('当前项目有未保存的更改，应用模板将清空当前内容。确定继续吗？')) {
          doApply();
        }
      } else {
        doApply();
      }
    },
  };

  function injectTemplateMenu() {
    // 在更多菜单中添加"从模板创建"
    const appMenu = $('appMenu');
    if (!appMenu) return;
    const newItem = document.createElement('button');
    newItem.className = 'app-menu-item';
    newItem.textContent = '从模板创建';
    newItem.onclick = () => Templates.show();
    // 插入到"创建新项目"后面
    const createBtn = Array.from(appMenu.querySelectorAll('.app-menu-item')).find(b => b.textContent.includes('创建新项目'));
    if (createBtn) createBtn.after(newItem);
    else appMenu.appendChild(newItem);
  }

  // ============================================================
  // UI 注入：增强工具栏
  // ============================================================
  function injectUI() {
    // 注入CSS
    const style = document.createElement('style');
    style.textContent = `
      .enh-toolbar { display:flex; flex-wrap:wrap; gap:4px; padding:6px 8px; background:var(--bg-tertiary); border-bottom:1px solid var(--border-color); }
      .enh-btn { padding:5px 10px; border:1px solid var(--border-color); border-radius:5px; background:var(--bg-secondary); color:var(--text-primary); cursor:pointer; font-size:12px; transition:all 0.15s; white-space:nowrap; }
      .enh-btn:hover { background:var(--accent); color:#fff; border-color:var(--accent); }
      .enh-btn.active { background:var(--accent); color:#fff; border-color:var(--accent); }
      .enh-btn.danger { color:var(--danger); }
      .enh-btn.danger:hover { background:var(--danger); color:#fff; border-color:var(--danger); }
      .enh-sep { width:1px; background:var(--border-color); margin:2px 4px; }
      #enhValueTablePanel { display:flex; flex-direction:column; flex:1; min-height:0; border-top:1px solid var(--border-color); background:var(--bg-secondary); }
      .vt-controls { display:flex; align-items:center; gap:6px; padding:6px 8px; font-size:12px; color:var(--text-secondary); border-bottom:1px solid var(--border-color); flex-wrap:wrap; }
      .vt-controls input { padding:2px 4px; border:1px solid var(--border-color); border-radius:3px; font-size:12px; width:50px; }
      .vt-scroll { overflow:auto; max-height:160px; }
      .vt-table { width:100%; border-collapse:collapse; font-size:12px; }
      .vt-table th, .vt-table td { padding:4px 8px; border:1px solid var(--border-color); text-align:center; }
      .vt-table th { background:var(--bg-tertiary); position:sticky; top:0; font-weight:600; }
      .vt-table tr:nth-child(even) { background:var(--bg-tertiary); }
      .enh-settings-row { display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border-color); }
      .enh-settings-row select { padding:4px 8px; border:1px solid var(--border-color); border-radius:4px; font-size:12px; background:var(--bg-secondary); color:var(--text-primary); }
    `;
    document.head.appendChild(style);

    // 工具区：在「工具」栏注入测量与分析工具（撤销/重做已在项目列表标题行）
    const toolsPane = $('enhToolsPane');
    if (toolsPane) {
      toolsPane.innerHTML = `
        <div class="tools-head">分析</div>
        <button class="enh-btn" id="enhAnalyzeBtn" title="自动标注零点和交点">⊕ 交点分析</button>
        <button class="enh-btn" id="enhTangentBtn" title="绘制切线">∿ 切线</button>
        <div class="tools-sep">测量（点击画布上已存在的坐标点）</div>
        <button class="enh-btn" id="enhMeasure_distance" title="测量两点距离">📏 距离</button>
        <button class="enh-btn" id="enhMeasure_angle" title="测量三点角度">📐 角度</button>
        <button class="enh-btn" id="enhMeasure_area" title="测量多边形面积">▱ 面积</button>
        <div class="tools-sep">导出</div>
        <button class="enh-btn" id="enhExportPNG" title="导出为PNG图片">🖼 导出图</button>
        <div class="tools-hint" id="enhMeasureStatus">选择测量工具后，点击画布上已存在的坐标点进行测量，结果记录在「数据」栏。</div>
      `;
    }

    // 数据面板初始化
    DataPanel.init();

    // 绑定事件
    $('enhUndoBtn').onclick = () => History.undo();
    $('enhRedoBtn').onclick = () => History.redo();
    $('enhAnalyzeBtn').onclick = () => Analyzer.toggle();
    $('enhTangentBtn').onclick = () => TangentTool.toggle();
    $('enhMeasure_distance').onclick = () => MeasureTool.toggle('distance');
    $('enhMeasure_angle').onclick = () => MeasureTool.toggle('angle');
    $('enhMeasure_area').onclick = () => MeasureTool.toggle('area');
    $('enhExportPNG').onclick = () => exportPNG();

    // 画布点击事件（测量工具）
    const canvas = $('canvas');
    if (canvas) {
      canvas.addEventListener('click', (e) => MeasureTool.handleClick(e));
      canvas.addEventListener('dblclick', () => MeasureTool.handleDblClick());
    }

    // 在设置面板中添加主题选择
    injectThemeSetting();

    // 键盘快捷键（Ctrl+Z / Ctrl+Y）
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault(); History.undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault(); History.redo();
      }
    });

    // 包装修改操作以记录历史
    wrapHistoryOperations();
  }

  function injectThemeSetting() {
    // 找到设置面板中的画布设置section
    const canvasSection = document.querySelector('[data-snav-panel="canvas"]');
    if (!canvasSection) return;
    const row = document.createElement('div');
    row.className = 'enh-settings-row';
    row.innerHTML = '<span>界面主题</span><select id="enhThemeSelect"><option value="light">浅色</option><option value="dark">深色</option><option value="ocean">海洋蓝</option><option value="forest">森林绿</option></select>';
    canvasSection.querySelector('.section-body')?.appendChild(row);
    $('enhThemeSelect').value = Theme.current;
    $('enhThemeSelect').onchange = (e) => Theme.apply(e.target.value);
  }

  function wrapHistoryOperations() {
    // 监听items数组变化（通过代理常见操作函数）
    const origAddFunc = window.addFuncItem;
    if (typeof origAddFunc === 'function') {
      window.addFuncItem = function (...args) {
        History.snapshot();
        return origAddFunc.apply(this, args);
      };
    }
    // 监听删除（通过事件委托）
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[onclick*="deleteItem"], [onclick*="removeItem"], .item-delete');
      if (btn) History.snapshot();
    }, true);
  }

  // ============================================================
  // 绘制钩子：在主画布渲染后叠加分析/切线/测量层
  // ============================================================
  function hookRender() {
    const origFullRender = window.fullRender;
    if (typeof origFullRender === 'function') {
      window.fullRender = function (...args) {
        const result = origFullRender.apply(this, args);
        // 叠加绘制
        const canvas = $('canvas');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          Analyzer.draw(ctx);
          TangentTool.draw(ctx);
        }
        return result;
      };
    }
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    Theme.init();
    initWheelZoom();
    initExprValidation();
    initMobile();
    injectUI();
    injectTemplateMenu();
    hookRender();
    // 暴露给全局
    window.Enhancements = { History, Analyzer, TangentTool, MeasureTool, Theme, ValueTable, Templates, DataPanel, exportPNG };
    console.log('[html-see 增强模块] 已加载 ✓');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => waitForCore(init));
  } else {
    waitForCore(init);
  }
})();
