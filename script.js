// ==================== 视口状态 ====================
let items = [];
let idSeq = {function:0, point:0, segment:0, line:0, ray:0, param:0};
let itemColorSeq = 0;
function nextItemId(type){
  idSeq[type]=(idSeq[type]||0)+1;
  const map={function:'fx_',point:'xy_',segment:'line_',line:'line2_',ray:'line3_',param:'pa_'};
  return (map[type]||'id_')+idSeq[type];
}
function nextColor(palette){
  itemColorSeq++;
  return palette[(itemColorSeq-1)%palette.length];
}
function updateItemFilter() {
  const checks = document.querySelectorAll('[data-filter]');
  filterTypes = [];
  checks.forEach(cb => {
    if (cb.checked) filterTypes.push(cb.dataset.filter);
  });
  // 如果全部未选，则显示全部（或保留空数组表示全部）
  if (filterTypes.length === 0) filterTypes = ['function','point','param','segment','ray','line'];
  // 重置选中项（若当前选中的类型不在过滤中，取消选中）
  if (selectedItemId) {
    const it = items.find(i => i.id === selectedItemId);
    if (it && !filterTypes.includes(it.type)) selectedItemId = null;
  }
  renderItemCards();
}

let cacheIdMap = new Map();
let panelCollapsed = false;
let selectedItemId = null;
let pointPlacementMode = false;
let batchMode = false;
let batchSelected = new Set();
let pendingBatchDelete = new Set();
let filterTypes = ['function','point','param','segment','ray','line'];
const animSettings={mode:'bidirectional',speed:1};
const paramAnims=new Map();
let paramAnimRAF=0;
let autoCentered=false;

let view = { ox:0, oy:0, gridUnitLength:5, gridPixelSize:3, minorGridSteps:5, pointSize:4, renderPrecision:0.01, decimalPlaces:2 };
const PIXEL_SCALE = 50;
const PIXEL_SIZE_MIN = 0.1, PIXEL_SIZE_MAX = 10;

let unitLengthOptions = [];
(function buildUnitLengths() {
  let arr = [];
  for (let v=0.01; v<=0.02; v+=0.01) arr.push(parseFloat(v.toFixed(2)));
  arr.push(0.02, 0.05);
  for (let v=0.1; v<=0.5; v+=0.1) arr.push(parseFloat(v.toFixed(1)));
  arr.push(0.2, 0.5, 1, 2, 5);
  for (let v=10; v<=50; v+=5) arr.push(v);
  for (let v=60; v<=100; v+=10) arr.push(v);
  arr.sort((a,b)=>a-b);
  unitLengthOptions = [...new Set(arr)];
})();

function ppu() { return PIXEL_SCALE * view.gridPixelSize / view.gridUnitLength; }
function smallUnit() { return view.gridUnitLength / view.minorGridSteps; }

function screenToMath(sx, sy) {
  const p = ppu();
  return { mx:(sx-view.ox)/p, my:(view.oy-sy)/p };
}
function mathToScreen(mx, my) {
  const p = ppu();
  return { sx:view.ox+mx*p, sy:view.oy-my*p };
}

// 拖拽
let dragging = false, dragStartOx=0, dragStartOy=0;
let dragLastX=0, dragLastY=0, dragStartClientX=0, dragStartClientY=0;
const DRAG_THRESHOLD = 3;

// 离屏canvas用于拖拽缓存


// 缩放动画
let animTarget=null, animStart=null, animDuration=180, animating=false;
let animOnComplete=null;
let animStartTime=0;

// 单位长度切换动画
let ulAnimating=false, ulAnimPhase=0, ulAnimStartTime=0, ulAnimDurationMs=0;
let ulAnimStartPS=0, ulAnimExpandPS=0, ulAnimOrigPS=0, ulAnimNewUL=0;
let ulAnimStartOx=0, ulAnimStartOy=0;

// Worker
let worker=null, taskSeq=0, pendingTaskSeq=0, workerBusy=false, dirty=true, workerTimeoutTimer=null;
let pendingHashes=new Map();
const offscreenCache=new Map();

// 鼠标
let mouseMathX=0, mouseMathY=0, mouseOnCanvas=false;

// ==================== DOM ====================
const canvas=document.getElementById('canvas'), ctx=canvas.getContext('2d');
const canvasWrap=document.getElementById('canvasWrap');
const leftPanel=document.getElementById('leftPanel');
const itemListContainer=document.getElementById('itemListContainer');
const itemCount=document.getElementById('itemCount');
const coordDisplay=document.getElementById('coordDisplay');
const calcStatus=document.getElementById('calcStatus');
const togglePanelBtn=document.getElementById('togglePanelBtn');
const showGrid=document.getElementById('showGrid');
const showMinorGridI=document.getElementById('showMinorGrid');
const unitLengthVal=document.getElementById('unitLengthVal');
const pixelSizeVal=document.getElementById('pixelSizeVal');
const panelResizeHandle=document.getElementById('panelResizeHandle');
const placementToast=document.getElementById('placementToast');
const ptStyleSelect=document.getElementById('ptStyleSelect');
const renderPrecisionInput=document.getElementById('renderPrecisionInput');
const decimalPlacesInput=document.getElementById('decimalPlacesInput');

let canvasW=0, canvasH=0, dpr=(window.devicePixelRatio||1);

// ==================== Worker ====================
const workerCode = `
importScripts('https://cdn.jsdelivr.net/npm/mathjs@11.8.0/lib/browser/math.min.js');
math.config({number:'number',precision:14});

function preprocessAbs(expr){
  let result='',i=0,depth=0;
  while(i<expr.length){
    if(expr[i]==='|'){
      if(depth%2===0){result+='abs(';depth++;}
      else{result+=')';depth++;}
    }else{result+=expr[i];}
    i++;
  }
  while(depth%2!==0){result+=')';depth++;}
  return result;
}

function preprocessExpr(e){
  let s = preprocessAbs(e);
  s = s.replace(/([a-z]\\w*|\\([^)]*\\))\\^\\((\\d+)\\/(\\d+)\\)/g, 'nthRoot((($1)^$2),$3)');
  return s;
}

function compileExplicit(expr, paramVals){
  const c=math.compile(preprocessExpr(expr));
  return x=>{
    const scope={x};if(paramVals)Object.assign(scope,paramVals);
    try{const v=c.evaluate(scope);if(typeof v==='number')return[v];if(Array.isArray(v))return v.filter(y=>typeof y==='number'&&isFinite(y)&&!isNaN(y));if(v&&typeof v.valueOf==='function'){const n=Number(v);if(isFinite(n)&&!isNaN(n))return[n];}return[];}catch{return[];}};
}
function compileImplicit(eq, paramVals){
  const s=eq.split('=');if(s.length!==2)return null;
  const l=math.compile(preprocessExpr(s[0])),r=math.compile(preprocessExpr(s[1]));
  return(x,y)=>{
    const scope={x,y};if(paramVals)Object.assign(scope,paramVals);
    try{return Number(l.evaluate(scope))-Number(r.evaluate(scope));}catch{return NaN;}};
}

function marchingSquares(fn,xMin,xMax,yMin,yMax,gw,gh){
  const dx=(xMax-xMin)/gw,dy=(yMax-yMin)/gh;
  const vals=new Float64Array((gw+1)*(gh+1));
  for(let j=0;j<=gh;j++)for(let i=0;i<=gw;i++)vals[j*(gw+1)+i]=fn(xMin+i*dx,yMin+j*dy);
  const segs=[];
  for(let j=0;j<gh;j++)for(let i=0;i<gw;i++){
    const v00=vals[j*(gw+1)+i],v10=vals[j*(gw+1)+i+1],v11=vals[(j+1)*(gw+1)+i+1],v01=vals[(j+1)*(gw+1)+i];
    let bits=0;
    if(v00>=0||(v00===0&&v10>=0&&v01>=0))bits|=1;
    if(v10>=0||(v10===0&&v00>=0&&v11>=0))bits|=2;
    if(v11>=0||(v11===0&&v10>=0&&v01>=0))bits|=4;
    if(v01>=0||(v01===0&&v00>=0&&v11>=0))bits|=8;
    if(bits===0||bits===15)continue;
    const x0=xMin+i*dx,y0=yMin+j*dy;
    const cx=[x0,x0+dx,x0+dx,x0],cy=[y0,y0,y0+dy,y0+dy];
    const cv=[v00,v10,v11,v01];
    function ip(e){const e2=(e+1)%4;const t=cv[e]/(cv[e]-cv[e2]);return isFinite(t)?[cx[e]+t*(cx[e2]-cx[e]),cy[e]+t*(cy[e2]-cy[e])]:[cx[e],cy[e]];}
    const pairs=[];
    if(bits===1||bits===14)pairs.push([0,3]);
    if(bits===2||bits===13)pairs.push([0,1]);
    if(bits===3||bits===12)pairs.push([3,1]);
    if(bits===4||bits===11)pairs.push([1,2]);
    if(bits===6||bits===9)pairs.push([0,2]);
    if(bits===7||bits===8)pairs.push([3,2]);
    if(bits===5){const mc=fn(x0+dx/2,y0+dy/2);if(mc>=0){pairs.push([0,3]);pairs.push([1,2]);}else{pairs.push([0,1]);pairs.push([3,2]);}}
    if(bits===10){const mc=fn(x0+dx/2,y0+dy/2);if(mc>=0){pairs.push([0,1]);pairs.push([3,2]);}else{pairs.push([0,3]);pairs.push([1,2]);}}
    for(const[a,b]of pairs){const p1=ip(a),p2=ip(b);segs.push([p1[0],p1[1],p2[0],p2[1]]);}
  }
  return segs;
}

function sampleExplicit(fn,xMin,xMax,step){
  const pts=[];let py=null;
  function push(x,y){if(!isFinite(y)||isNaN(y)||Math.abs(y)>1e8){py=null;return;}if(py!==null&&Math.abs(y-py)>100){py=null;return;}pts.push([x,y]);py=y;}
  function findEdge(xLo,xHi,dir){
    let lo=xLo,hi=xHi;
    for(let k=0;k<40;k++){
      const mid=(lo+hi)/2;
      const ok=(fn(mid)||[]).length>0;
      if(dir===1){if(ok)lo=mid;else hi=mid;}
      else{if(ok)hi=mid;else lo=mid;}
    }
    const xb=dir===1?lo:hi;
    const ya=fn(xb);
    return(ya&&ya.length>0)?[xb,ya[0]]:null;
  }
  let lastDefined=false;
  for(let x=xMin;x<=xMax;x+=step){
    const ya=fn(x);
    const def=!!(ya&&ya.length>0);
    if(def){
      if(!lastDefined&&pts.length>0){
        const lastPt=pts[pts.length-1];
        if(x-lastPt[0]>step*0.5){
          const edge=findEdge(lastPt[0],x,-1);
          if(edge&&edge[0]>lastPt[0]&&edge[0]<x)push(edge[0],edge[1]);
        }
      }
      for(const y of ya)push(x,y);
    }else{
      if(lastDefined&&pts.length>0){
        const lastPt=pts[pts.length-1];
        if(x-lastPt[0]>step*0.5){
          const edge=findEdge(lastPt[0],x,1);
          if(edge&&edge[0]>lastPt[0]&&edge[0]<x)push(edge[0],edge[1]);
        }
      }
    }
    lastDefined=def;
  }
  return pts;
}

self.onmessage=function(e){console.log('[WORKER] 收到消息，taskSeq:',e.data.taskSeq,'funcs:',e.data.funcs.length);
  const{taskSeq:ts,funcs,viewXMin,viewXMax,viewYMin,viewYMax,targetCellSize,paramVals}=e.data;
  const sW=Math.abs(viewXMax-viewXMin),sH=Math.abs(viewYMax-viewYMin);
  const results=[];
  for(const f of funcs){
    if(f.hidden){results.push({id:f.id,type:'skip'});continue;}
    const eq=f.expr.trim().replace(/\\s/g,'');
    const isExplicit=eq.includes('y=')&&eq.indexOf('y=')===0;
    const isImplicit=eq.includes('=')&&!isExplicit;
    const isExpr=!eq.includes('=');

    if(isExplicit||isExpr){
      const ep=isExplicit?eq.substring(2):eq;
      try{
        const fn=compileExplicit(ep, paramVals);
        const sStep=sW/1600;
        const pad=sW*0.2;
        const xMin=viewXMin-pad;
        const xMax=viewXMax+pad;
        const pts=sampleExplicit(fn,xMin,xMax,sStep);
        const segs=[];
        if(pts.length>0){
          let seg=[pts[0]];
          for(let i=1;i<pts.length;i++){
            if(Math.abs(pts[i][1]-pts[i-1][1])>50){if(seg.length>1)segs.push(seg);seg=[pts[i]];}
            else seg.push(pts[i]);
          }
          if(seg.length>1)segs.push(seg);
        }
        results.push({id:f.id,type:'explicit',segments:segs,viewRange:{xMin:xMin,xMax:xMax}});
      }catch(e){results.push({id:f.id,type:'error'});}
    }else if(isImplicit){
      const fn=compileImplicit(eq, paramVals);
      if(!fn){results.push({id:f.id,type:'error'});continue;}
      const pad=0.2;
      const xMin=viewXMin-sW*pad,xMax=viewXMax+sW*pad;
      const yMin=viewYMin-sH*pad,yMax=viewYMax+sH*pad;
      const totalW=Math.abs(xMax-xMin),totalH=Math.abs(yMax-yMin);
      let gw=Math.round(totalW/targetCellSize),gh=Math.round(totalH/targetCellSize);
      gw=Math.max(250,Math.min(2000,gw));gh=Math.max(250,Math.min(2000,gh));
      const raw=marchingSquares(fn,xMin,xMax,yMin,yMax,gw,gh);
      results.push({id:f.id,type:'implicit',segments:raw.map(s=>[s[0],s[1],s[2],s[3]]),viewRange:{xMin:xMin,xMax:xMax,yMin:yMin,yMax:yMax}});
    }
  }
  console.log('[WORKER] 发送结果，results:',results.length);self.postMessage({taskSeq:ts,results});
};
`;

function initWorker(){
  try{
    console.log('[DEBUG] 开始创建 Worker');
    const blob=new Blob([workerCode],{type:'application/javascript'});
    worker=new Worker(URL.createObjectURL(blob));
    console.log('[DEBUG] Worker 创建成功');
    worker.onmessage=onWorkerMessage;
    console.log('[DEBUG] onmessage 已绑定');
    worker.onerror=function(err){
      console.error('Worker error:',err);
      workerBusy=false;
      document.getElementById('loadingToast').classList.remove('visible');
      calcStatus.textContent='Worker 异常，已重置';
      initWorker();
      dirty=true;
      fullRender();
    };
  }catch(err){console.error('Worker init failed:',err);worker=null;}
}

function groupSegments(segments){
  if(segments.length===0)return segments;
  const eps=1.5;
  const grid=new Map();
  function h(x,y){return Math.round(x/eps)+','+Math.round(y/eps);}
  function add(i,x,y){const k=h(x,y);let a=grid.get(k);if(!a){a=[];grid.set(k,a);}a.push(i);}
  for(let i=0;i<segments.length;i++){const s=segments[i];add(i,s[0],s[1]);add(i,s[2],s[3]);}
  function query(x,y,ex){
    const k=h(x,y);const a=grid.get(k);if(!a)return-1;
    for(const j of a){if(j===ex)continue;const s=segments[j];if(Math.hypot(s[0]-x,s[1]-y)<eps||Math.hypot(s[2]-x,s[3]-y)<eps)return j;}
    return-1;
  }
  const visited=new Set(),chains=[];
  for(let i=0;i<segments.length;i++){
    if(visited.has(i))continue;visited.add(i);
    const s=segments[i],chain=[s[0],s[1],s[2],s[3]];
    let ex=s[2],ey=s[3];
    while(true){
      const nxt=query(ex,ey,-1);
      if(nxt<0||visited.has(nxt))break;visited.add(nxt);
      const ns=segments[nxt];
      if(Math.hypot(ns[0]-ex,ns[1]-ey)<Math.hypot(ns[2]-ex,ns[3]-ey)){chain.push(ns[0],ns[1],ns[2],ns[3]);ex=ns[2];ey=ns[3];}
      else{chain.push(ns[2],ns[3],ns[0],ns[1]);ex=ns[0];ey=ns[1];}
    }
    chains.push(chain);
  }
  return chains;
}

function requestCompute(){
  if(!worker){renderFallback();return;}
  if(workerTimeoutTimer){clearTimeout(workerTimeoutTimer);workerTimeoutTimer=null;}
  if(workerBusy){dirty=true;calcStatus.textContent='排队中...';return;}
  const p=ppu();
  const vxMin=(0-view.ox)/p,vxMax=(canvasW-view.ox)/p;
  const vyMin=(view.oy-canvasH)/p,vyMax=view.oy/p;
  const targetCellSize=1/p;
  const paramVals=getParamValues();
  const ph=paramHash();
  const funcs=items.filter(it=>it.type==='function');
  const toCompute=funcs.filter(f=>!f.hidden&&needsRecompute(f,ph,vxMin,vxMax,vyMin,vyMax));
  if(toCompute.length===0){
    calcStatus.textContent='就绪';
    document.getElementById('loadingToast').classList.remove('visible');
    dirty=false;
    renderFull();
    return;
  }
  for(const f of toCompute){
    const c=cacheIdMap.get(f.id);
    if(c&&c.exprHash!==exprHash((f.expr||'').trim()))cacheIdMap.delete(f.id);
  }
  const sendFuncs=toCompute.map(f=>({id:f.id,expr:f.expr,hidden:f.hidden}));
  workerBusy=true;taskSeq++;pendingTaskSeq=taskSeq;
  pendingHashes.clear();
  for(const f of toCompute)pendingHashes.set(f.id,{exprHash:exprHash((f.expr||'').trim()),paramHash:ph});
  calcStatus.textContent='计算中...';
  document.getElementById('loadingToast').classList.add('visible');
  worker.postMessage({taskSeq,funcs:sendFuncs,viewXMin:vxMin,viewXMax:vxMax,viewYMin:vyMin,viewYMax:vyMax,targetCellSize,paramVals});
  workerTimeoutTimer=setTimeout(()=>{
    workerBusy=false;workerTimeoutTimer=null;
    document.getElementById('loadingToast').classList.remove('visible');
    calcStatus.textContent='计算超时';
    renderFallback();
    scheduleDirtyCompute();
  },8000);
}

function exprHash(str){
  let h=0x811c9dc5;
  for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
  return h>>>0;
}

function paramHash(){
  const vals=getParamValues();
  const keys=Object.keys(vals).sort();
  let s='';
  for(const k of keys)s+=k+'='+Number(vals[k])+';';
  return exprHash(s);
}

function viewKey(){
  return Math.round(view.ox*10)+','+Math.round(view.oy*10)+','+view.gridPixelSize.toFixed(2)+','+view.gridUnitLength+','+canvasW+'x'+canvasH;
}

function needsRecompute(f,ph,vxMin,vxMax,vyMin,vyMax){
  const c=cacheIdMap.get(f.id);
  if(!c||c.type==='skip'||c.type==='error')return true;
  if(c.exprHash!==exprHash((f.expr||'').trim())||c.paramHash!==ph)return true;
  const vr=c.viewRange;
  if(!vr||vr.xMin===undefined)return true;
  const padX=(vr.xMax-vr.xMin)*0.05;
  if(vxMin<vr.xMin-padX||vxMax>vr.xMax+padX)return true;
  if(vr.yMin!==undefined){
    const padY=(vr.yMax-vr.yMin)*0.05;
    if(vyMin<vr.yMin-padY||vyMax>vr.yMax+padY)return true;
  }
  return false;
}

function scheduleDirtyCompute(){
  if(dirty&&!workerBusy){dirty=false;requestCompute();}
}

function autoCenterOnCurves(){
  if(autoCentered)return;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,any=false;
  for(const it of items){
    if(it.type!=='function'||it.hidden)continue;
    const c=cacheIdMap.get(it.id);
    if(!c||c.type==='skip'||c.type==='error')continue;
    const segs=c.segments||[];
    for(const seg of segs){
      for(let i=0;i<seg.length;i+=(c.type==='explicit'?1:2)){
        const mx=c.type==='explicit'?seg[i][0]:seg[i],my=c.type==='explicit'?seg[i][1]:seg[i+1];
        if(!isFinite(mx)||!isFinite(my))continue;
        minX=Math.min(minX,mx);maxX=Math.max(maxX,mx);
        minY=Math.min(minY,my);maxY=Math.max(maxY,my);any=true;
      }
    }
  }
  if(any&&isFinite(minX)){
    const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
    const ps=mathToScreen(cx,cy);
    view.ox+=canvasW/2-ps.sx;view.oy+=canvasH/2-ps.sy;
  }
  autoCentered=true;
}

function onWorkerMessage(e){
  if(workerTimeoutTimer){clearTimeout(workerTimeoutTimer);workerTimeoutTimer=null;}
  workerBusy=false;
  const{taskSeq:ts,results}=e.data;
  if(ts!==pendingTaskSeq){dirty=false;return;}
  for(const r of results){
    if(r.type==='skip')continue;
    if(r.type==='implicit'&&r.segments)r.segments=groupSegments(r.segments);
    const meta=pendingHashes.get(r.id);
    if(meta){r.exprHash=meta.exprHash;r.paramHash=meta.paramHash;}
    cacheIdMap.set(r.id,r);
  }
  pendingHashes.clear();
  calcStatus.textContent='就绪';
  document.getElementById('loadingToast').classList.remove('visible');
  if(!autoCentered)autoCenterOnCurves();
  renderFull();
  scheduleDirtyCompute();
}

function renderFallback(){
  const p=ppu();const vxMin=(0-view.ox)/p,vxMax=(canvasW-view.ox)/p;
  const sW=Math.abs(vxMax-vxMin);const sStep=sW/1600;
  const ph=paramHash();
  for(const it of items){
    if(it.type!=='function'||it.hidden)continue;
    const eq=it.expr.trim().replace(/\s/g,'');
    const isExplicit=eq.includes('y=')&&eq.indexOf('y=')===0;
    const isImplicit=eq.includes('=')&&!isExplicit;
    const isExpr=!eq.includes('=');
    if(isExplicit||isExpr){
      const ep=isExplicit?eq.substring(2):eq;
      try{
        const c=math.compile(preprocessExpr(ep));
        const fn=x=>{try{const v=c.evaluate({x});if(typeof v==='number')return[v];if(Array.isArray(v))return v.filter(y=>typeof y==='number'&&isFinite(y)&&!isNaN(y));return[];}catch{return[];}};
        const pts=[];let py=null;
        function push(x,y){if(!isFinite(y)||isNaN(y)||Math.abs(y)>1e8){py=null;return;}if(py!==null&&Math.abs(y-py)>100){py=null;return;}pts.push([x,y]);py=y;}
        function findEdge(xLo,xHi,dir){
          let lo=xLo,hi=xHi;
          for(let k=0;k<40;k++){
            const mid=(lo+hi)/2;
            const ok=(fn(mid)||[]).length>0;
            if(dir===1){if(ok)lo=mid;else hi=mid;}
            else{if(ok)hi=mid;else lo=mid;}
          }
          const xb=dir===1?lo:hi;
          const ya=fn(xb);
          return(ya&&ya.length>0)?[xb,ya[0]]:null;
        }
        let lastDefined=false;
        for(let x=vxMin-sW*0.2;x<=vxMax+sW*0.2;x+=sStep){
          const ya=fn(x);
          const def=!!(ya&&ya.length>0);
          if(def){
            if(!lastDefined&&pts.length>0){
              const lastPt=pts[pts.length-1];
              if(x-lastPt[0]>sStep*0.5){
                const edge=findEdge(lastPt[0],x,-1);
                if(edge&&edge[0]>lastPt[0]&&edge[0]<x)push(edge[0],edge[1]);
              }
            }
            for(const y of ya)push(x,y);
          }else{
            if(lastDefined&&pts.length>0){
              const lastPt=pts[pts.length-1];
              if(x-lastPt[0]>sStep*0.5){
                const edge=findEdge(lastPt[0],x,1);
                if(edge&&edge[0]>lastPt[0]&&edge[0]<x)push(edge[0],edge[1]);
              }
            }
          }
          lastDefined=def;
        }
        let seg=[];const segs=[];
        for(let i=0;i<pts.length;i++){if(i>0&&Math.abs(pts[i][1]-pts[i-1][1])>50){if(seg.length>1)segs.push(seg);seg=[pts[i]];}else seg.push(pts[i]);}
        if(seg.length>1)segs.push(seg);
        cacheIdMap.set(it.id,{id:it.id,type:'explicit',segments:segs,exprHash:exprHash(it.expr.trim()),paramHash:ph,viewRange:{xMin:vxMin-sW*0.2,xMax:vxMax+sW*0.2}});
      }catch(e){cacheIdMap.set(it.id,{id:it.id,type:'error',exprHash:exprHash(it.expr.trim()),paramHash:ph});}
    }
  }
  dirty=false;
}

// ==================== 渲染 ====================
function formatAxisLabel(val){
  if(Math.abs(val)>=1e5||(Math.abs(val)<1e-8&&val!==0))return val.toExponential(1);
  if(Number.isInteger(val))return val.toString();
  const dp=getDecimalPrecision();
  if(dp===0)return val.toString();
  return val.toFixed(dp);
}

function getDecimalPrecision(){
  return view.decimalPlaces;
}

function drawGridTo(target){
  const W=canvasW,H=canvasH,p=ppu(),su=smallUnit(),ulg=view.gridUnitLength;
  const showG=showGrid.checked;
  const tickSz=parseInt(tickFontSizeI.value)||14;
  const mgc=hexToRgba(majorGridColorI.value,parseInt(majorGridAlphaI.value)||100);
  const mnc=hexToRgba(minorGridColorI.value,parseInt(minorGridAlphaI.value)||100);
  const hideX=hideXAxisI.checked,hideY=hideYAxisI.checked;
  target.clearRect(0,0,W,H);

  const vxMin=(0-view.ox)/p,vxMax=(W-view.ox)/p;
  const vyMin=(view.oy-H)/p,vyMax=view.oy/p;

  // 小网格
  const showMG=showMinorGridI.checked;
  if(showG&&showMG){
    target.strokeStyle=mnc;target.lineWidth=0.4;
    const firstSx=Math.ceil(vxMin/su)*su;
    let lx=null;
    for(let mx=firstSx;mx<=vxMax;mx+=su){
      const sx=view.ox+mx*p;
      if(sx<0||sx>W)continue;
      if(lx!==null&&sx-lx<2)continue;
      lx=sx;target.beginPath();target.moveTo(sx,0);target.lineTo(sx,H);target.stroke();
    }
    const firstSy=Math.floor(vyMax/su)*su;
    let ly=null;
    for(let my=firstSy;my>=vyMin;my-=su){
      const sy=view.oy-my*p;
      if(sy<0||sy>H)continue;
      if(ly!==null&&Math.abs(sy-ly)<2)continue;
      ly=sy;target.beginPath();target.moveTo(0,sy);target.lineTo(W,sy);target.stroke();
    }
  }

  // 大网格
  if(showG){
    target.strokeStyle=mgc;target.lineWidth=0.6;
    const firstGx=Math.ceil(vxMin/ulg)*ulg;
    for(let mx=firstGx;mx<=vxMax;mx+=ulg){
      const sx=view.ox+mx*p;
      if(sx<0||sx>W)continue;
      target.beginPath();target.moveTo(sx,0);target.lineTo(sx,H);target.stroke();
    }
    const firstGy=Math.floor(vyMax/ulg)*ulg;
    for(let my=firstGy;my>=vyMin;my-=ulg){
      const sy=view.oy-my*p;
      if(sy<0||sy>H)continue;
      target.beginPath();target.moveTo(0,sy);target.lineTo(W,sy);target.stroke();
    }
  }

  // 坐标轴
  const osx=view.ox,osy=view.oy;
  target.strokeStyle='#222';target.lineWidth=1.2;
  if(!hideX){target.beginPath();target.moveTo(0,osy);target.lineTo(W,osy);target.stroke();}
  if(!hideY){target.beginPath();target.moveTo(osx,0);target.lineTo(osx,H);target.stroke();}

  // 箭头
  const arr=10;
  target.fillStyle='#222';
  if(!hideX&&osy>=0&&osy<=H){target.beginPath();target.moveTo(W-2,osy);target.lineTo(W-2-arr,osy-arr*0.45);target.lineTo(W-2-arr,osy+arr*0.45);target.closePath();target.fill();}
  if(!hideY&&osx>=0&&osx<=W){target.beginPath();target.moveTo(osx,2);target.lineTo(osx-arr*0.45,2+arr);target.lineTo(osx+arr*0.45,2+arr);target.closePath();target.fill();}

  target.fillStyle='#333';
  target.font=tickSz+"px 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";

  // X轴刻度标签
  if(!hideX){
  const xAxisY=osy>=0&&osy<=H?osy:(osy<0?0:H);
  const xAxisYOff=osy<0?16:(osy>H?-20:18);
  target.textBaseline='top';
  target.textAlign='center';
  const firstGx2=Math.ceil(vxMin/ulg)*ulg;
  for(let mx=firstGx2;mx<=vxMax;mx+=ulg){
    if(Math.abs(mx)<ulg*0.05)continue;
    const sx=view.ox+mx*p;
    if(sx<10||sx>W-10)continue;
    const ly=(osy>=0&&osy<=H)?(osy+tickSz+4):(osy<0?tickSz+2:H-tickSz*2);
    target.fillText(formatAxisLabel(mx),sx,ly);
  }
  }

  // Y轴刻度标签
  if(!hideY){
  const yAxisX=osx>=0&&osx<=W?osx:(osx<0?0:W);
  target.textBaseline='middle';
  target.textAlign='right';
  const firstGy2=Math.floor(vyMax/ulg)*ulg;
  for(let my=firstGy2;my>=vyMin;my-=ulg){
    if(Math.abs(my)<ulg*0.05)continue;
    const sy=view.oy-my*p;
    if(sy<10||sy>H-10)continue;
    const lx=(osx>=0&&osx<=W)?(osx-10):(osx<0?10:W-10);
    target.textAlign=osx<0?'left':(osx>W?'right':'right');
    target.fillText(formatAxisLabel(my),lx,sy);
  }
  }

  // 原点 O
  if(!hideX&&!hideY&&osx>=0&&osx<=W&&osy>=0&&osy<=H){
    target.textAlign='left';target.textBaseline='bottom';
    target.fillText('O',osx+4,osy-4);
  }
}

function drawCurvesTo(target){
  const p=ppu();
  for(const it of items){
    if(it.type!=='function'||it.hidden)continue;
    const c=cacheIdMap.get(it.id);
    if(!c||c.type==='skip'||c.type==='error')continue;
    target.strokeStyle=it.color;target.lineWidth=1.8;target.lineCap='round';
    try{
      if(c.type==='explicit'){
        for(const seg of c.segments){
          if(seg.length<4)continue;
          target.beginPath();
          const p0=mathToScreen(seg[0][0],seg[0][1]);
          target.moveTo(p0.sx,p0.sy);
          for(let i=1;i<seg.length;i++){
            const pt=mathToScreen(seg[i][0],seg[i][1]);
            target.lineTo(pt.sx,pt.sy);
          }
          target.stroke();
        }
      }else if(c.type==='implicit'){
        const offKey=it.id+'|'+(c.exprHash||0)+'|'+(c.paramHash||0)+'|'+viewKey()+'|'+it.color;
        let off=offscreenCache.get(offKey);
        if(!off){
          off=document.createElement('canvas');
          off.width=canvasW*dpr;off.height=canvasH*dpr;
          const octx=off.getContext('2d');
          octx.setTransform(dpr,0,0,dpr,0,0);
          drawImplicitTo(octx,c,it.color);
          offscreenCache.set(offKey,off);
          if(offscreenCache.size>8){const k=offscreenCache.keys().next().value;offscreenCache.delete(k);}
        }
        target.drawImage(off,0,0,canvasW,canvasH);
      }
    }catch(e){}
  }
}

function drawImplicitTo(target,c,color){
  target.strokeStyle=color;target.lineWidth=1.8;target.lineCap='round';
  try{
    for(const chain of c.segments){
      if(chain.length<4)continue;
      target.beginPath();
      const q0=mathToScreen(chain[0],chain[1]);
      target.moveTo(q0.sx,q0.sy);
      for(let i=2;i<chain.length;i+=2){
        const ps=mathToScreen(chain[i],chain[i+1]);
        target.lineTo(ps.sx,ps.sy);
      }
      target.stroke();
    }
  }catch(e){}
}

function drawPointsTo(target){
  const p=ppu();
  // 声明全局 variables 引用 (避免严格模式报错)
  const _lpA=typeof linePointA!=='undefined'?linePointA:null;
  const _lpB=typeof linePointB!=='undefined'?linePointB:null;
  for(const it of items){
    if(it.type!=='point'||it.hidden)continue;
    if(it.errorMsg)continue;
    const ps=mathToScreen(it.x,it.y);
    if(ps.sx<-50||ps.sx>canvasW+50||ps.sy<-50||ps.sy>canvasH+50)continue;
    target.fillStyle=it.color;target.strokeStyle=it.color;

    if(ptStyleSelect.value==='crosshair'){
      // 十字虚线：完整贯穿整个画布，不受坐标轴位置或可视区域截断
      target.setLineDash([4,4]);target.lineWidth=1.5;target.strokeStyle=it.color;
      target.beginPath();target.moveTo(ps.sx,0);target.lineTo(ps.sx,canvasH);target.stroke();
      target.beginPath();target.moveTo(0,ps.sy);target.lineTo(canvasW,ps.sy);target.stroke();
      target.setLineDash([]);
    }

    // 圆点
    target.beginPath();target.arc(ps.sx,ps.sy,view.pointSize,0,Math.PI*2);
    target.fillStyle=it.color;target.fill();
    // 描边
    target.strokeStyle='#fff';target.lineWidth=2;
    target.stroke();
    // 选中时添加黑色外圈
    if(selectedItemId===it.id||_lpA&&it.id===_lpA.id||_lpB&&it.id===_lpB.id){
      target.beginPath();target.arc(ps.sx,ps.sy,view.pointSize+2,0,Math.PI*2);
      target.strokeStyle='#000';target.lineWidth=3;target.stroke();
    }

    // 标签
    if(it.label){
      target.font="bold 13px 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
      target.fillStyle=it.color;
      target.textAlign='left';target.textBaseline='bottom';
      target.fillText(it.label,ps.sx+8,ps.sy-6);
    }
  }
}

function evalBoundFunc(funcId,inputX){
  const f=items.find(i=>i.id===funcId&&i.type==='function');
  if(!f)return{error:'找不到函数 ID '+funcId};
  const eq=(f.expr||'').trim().replace(/\s/g,'');
  if(!eq)return{error:'函数表达式为空'};
  let ep=eq;
  if(eq.indexOf('y=')===0)ep=eq.substring(2);
  else if(eq.includes('='))return{error:'隐式函数不能用于绑定'};
  try{
    const c=math.compile(preprocessExpr(ep));
    const scope={x:Number(inputX)||0};
    Object.assign(scope,getParamValues());
    const v=c.evaluate(scope);
    const n=(typeof v==='number')?v:Number(v.valueOf&&v.valueOf());
    if(isFinite(n)&&!isNaN(n))return{value:n};
    return{error:'函数计算无有效结果'};
  }catch(e){return{error:'函数表达式错误'};}
}

function paramNameById(id){
  const p=items.find(i=>i.id===id&&i.type==='param');
  return p?p.name:'';
}

function evalParamExpr(expr,paramVals){
  const s=String(expr==null?'':expr).trim();
  if(!s)return{error:'参数表达式为空'};
  try{
    const params=detectParams(s);
    const missing=params.filter(p=>!(p in paramVals));
    if(missing.length)return{error:'参数不存在：'+missing.join(', ')};
    const c=math.compile(preprocessExpr(s));
    const scope=Object.assign({},paramVals);
    const v=c.evaluate(scope);
    const n=(typeof v==='number')?v:(v&&typeof v.valueOf==='function'?Number(v.valueOf()):NaN);
    if(!isFinite(n)||isNaN(n))return{error:'表达式计算无有效结果'};
    return{value:n};
  }catch(e){return{error:'表达式语法错误：'+(e&&e.message?e.message:'')};}
}

function resolveAllPoints(){
  const paramVals=getParamValues();
  for(const it of items){
    if(it.type!=='point')continue;
    let xErr=null,yErr=null;
    const xMode=it.xMode||'fixed';
    if(xMode==='fixed'){
      it.x=Number(it.xFixed!==undefined?it.xFixed:it.x)||0;
    }else if(xMode==='param'){
      const expr=it.xParamExpr!=null?String(it.xParamExpr):(it.xParamId?paramNameById(it.xParamId):'');
      const r=evalParamExpr(expr,paramVals);
      if(r.error)xErr=r.error;else it.x=r.value;
    }else{
      it.xMode='fixed';
      it.x=Number(it.xFixed!==undefined?it.xFixed:it.x)||0;
    }
    const yMode=it.yMode||'fixed';
    if(yMode==='fixed'){
      it.y=Number(it.yFixed!==undefined?it.yFixed:it.y)||0;
    }else if(yMode==='param'){
      const expr=it.yParamExpr!=null?String(it.yParamExpr):(it.yParamId?paramNameById(it.yParamId):'');
      const r=evalParamExpr(expr,paramVals);
      if(r.error)yErr=r.error;else it.y=r.value;
    }else if(yMode==='func'&&it.yFuncId){
      const r=evalBoundFunc(it.yFuncId,it.x);
      if(r.error)yErr=r.error;else it.y=r.value;
    }
    it.xErr=xErr;it.yErr=yErr;
    it.errorMsg=xErr||yErr||null;
  }
  updateSegmentLineItems();
}

// ===== 更新连线项的一次函数 =====
function updateSegmentLineItems() {
  for (const it of items) {
    if (it.type !== 'segment' && it.type !== 'line' && it.type !== 'ray') continue;
    if (!it.pointA || !it.pointB) {
      it.k = undefined;
      it.b = undefined;
      continue;
    }
    const x1 = it.pointA.x, y1 = it.pointA.y;
    const x2 = it.pointB.x, y2 = it.pointB.y;
    if (Math.abs(x2 - x1) < 1e-12) {
      it.k = Infinity;
      it.b = x1;   // 垂直线 x = 常数
    } else {
      it.k = (y2 - y1) / (x2 - x1);
      it.b = y1 - it.k * x1;
    }
    // 为线段预存范围（用于渲染裁剪）
    if (it.type === 'segment') {
      it.xMin = Math.min(x1, x2);
      it.xMax = Math.max(x1, x2);
    } else {
      it.xMin = -Infinity;
      it.xMax = Infinity;
    }
  }
}

function renderFull(){resolveAllPoints();drawGridTo(ctx);drawCurvesTo(ctx);drawSegmentsTo(ctx);drawPointsTo(ctx);}

function segmentIntersectsRect(x1,y1,x2,y2,left,top,right,bottom){
  let t0=0,t1=1;
  const dx=x2-x1,dy=y2-y1;
  const p=[-dx,dx,-dy,dy];
  const q=[x1-left,right-x1,y1-top,bottom-y1];
  for(let i=0;i<4;i++){
    if(p[i]===0){
      if(q[i]<0)return false;
    }else{
      const r=q[i]/p[i];
      if(p[i]<0){if(r>t1)return false;if(r>t0)t0=r;}
      else{if(r<t0)return false;if(r<t1)t1=r;}
    }
  }
  return true;
}

function drawSegmentsTo(target) {
  const p = ppu();
  // 视口的数学范围（用于裁剪无限延伸的线）
  const vxMin = (0 - view.ox) / p;
  const vxMax = (canvasW - view.ox) / p;
  const vyMin = (view.oy - canvasH) / p;
  const vyMax = view.oy / p;

  for (const it of items) {
    if ((it.type !== 'segment' && it.type !== 'line' && it.type !== 'ray') || it.hidden) continue;
    if (!it.pointA || !it.pointB || it.k === undefined) continue;

    target.strokeStyle = it.color;
    target.lineWidth = 2.5;

    // 确定要画的 x 范围
    let x1, x2;
    if (it.type === 'segment') {
      x1 = it.pointA.x;
      x2 = it.pointB.x;
      // 如果两点 x 相同（垂直线段），直接画垂直有限线段
      if (it.k === Infinity) {
        const ps1 = mathToScreen(x1, it.pointA.y);
        const ps2 = mathToScreen(x1, it.pointB.y);
        target.beginPath();
        target.moveTo(ps1.sx, ps1.sy);
        target.lineTo(ps2.sx, ps2.sy);
        target.stroke();
        continue;
      }
    } else if (it.type === 'ray') {
      // 射线：从 pointA 出发，沿方向延伸
      const dx = it.pointB.x - it.pointA.x;
      if (Math.abs(dx) < 1e-12) {
        // 垂直射线：从 A 向上下延伸
        const yA = it.pointA.y;
        const yExt = (it.pointB.y > yA) ? vyMax + (vyMax - vyMin) * 0.5 : vyMin - (vyMax - vyMin) * 0.5;
        const ps1 = mathToScreen(it.pointA.x, yA);
        const ps2 = mathToScreen(it.pointA.x, yExt);
        target.beginPath();
        target.moveTo(ps1.sx, ps1.sy);
        target.lineTo(ps2.sx, ps2.sy);
        target.stroke();
        continue;
      }
      if (dx > 0) {
        x1 = it.pointA.x;
        x2 = vxMax + (vxMax - vxMin) * 0.5; // 超出视口右侧
      } else {
        x1 = vxMin - (vxMax - vxMin) * 0.5;
        x2 = it.pointA.x;
      }
    } else { // 直线
      if (it.k === Infinity) {
        // 垂直直线
        const x = it.b;
        const y1 = vyMin - (vyMax - vyMin) * 0.5;
        const y2 = vyMax + (vyMax - vyMin) * 0.5;
        const ps1 = mathToScreen(x, y1);
        const ps2 = mathToScreen(x, y2);
        target.beginPath();
        target.moveTo(ps1.sx, ps1.sy);
        target.lineTo(ps2.sx, ps2.sy);
        target.stroke();
        continue;
      }
      x1 = vxMin - (vxMax - vxMin) * 0.2;
      x2 = vxMax + (vxMax - vxMin) * 0.2;
    }

    // 对于非垂直线，计算两端点的 y
    const y1 = it.k * x1 + it.b;
    const y2 = it.k * x2 + it.b;

    // 转换到屏幕坐标并画线
    const ps1 = mathToScreen(x1, y1);
    const ps2 = mathToScreen(x2, y2);
    target.beginPath();
    target.moveTo(ps1.sx, ps1.sy);
    target.lineTo(ps2.sx, ps2.sy);
    target.stroke();
  }
}

function renderFullOnly(){resolveAllPoints();drawGridTo(ctx);drawCurvesTo(ctx);drawSegmentsTo(ctx);drawPointsTo(ctx);}

// ==================== 动画 ====================
function easeInOutCubic(t){return t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;}

function startAnim(targetOx,targetOy,targetPS,callback){
  animTarget={ox:targetOx,oy:targetOy,gridPixelSize:parseFloat(targetPS.toFixed(2))};
  animStart={ox:view.ox,oy:view.oy,gridPixelSize:view.gridPixelSize,_ts:0};
  animOnComplete=callback||null;
  animDuration=160;
  if(!animating){animating=true;animStartTime=performance.now();animStart._ts=animStartTime;requestAnimationFrame(animStep);}
}

function animStep(ts){
  if(!animTarget)return;
  const elapsed=ts-animStartTime;
  let t=Math.min(elapsed/animDuration,1);
  t=easeInOutCubic(t);
  const ox0=animStart.ox,oy0=animStart.oy,ps0=animStart.gridPixelSize;
  view.gridPixelSize=Math.max(PIXEL_SIZE_MIN,Math.min(PIXEL_SIZE_MAX,ps0+(animTarget.gridPixelSize-ps0)*t));
  view.ox=ox0+(animTarget.ox-ox0)*t;
  view.oy=oy0+(animTarget.oy-oy0)*t;
  updateDisplayValues();
  renderFull();
  if(t>=1){
    view.ox=animTarget.ox;view.oy=animTarget.oy;view.gridPixelSize=animTarget.gridPixelSize;
    animating=false;animTarget=null;animStart=null;
    if(animOnComplete){const cb=animOnComplete;animOnComplete=null;cb();}
    dirty=true;fullRender();
  }else{requestAnimationFrame(animStep);}
}

function startULAnim(newUL){
  if(ulAnimating)return;
  const isIncrease=newUL>view.gridUnitLength;
  ulAnimating=true;ulAnimPhase=0;
  ulAnimOrigPS=view.gridPixelSize;
  ulAnimExpandPS=isIncrease?ulAnimOrigPS*2:ulAnimOrigPS*0.5;
  ulAnimNewUL=newUL;
  ulAnimStartOx=view.ox;ulAnimStartOy=view.oy;
  ulAnimStartTime=performance.now();
  ulAnimDurationMs=160;
  requestAnimationFrame(ulAnimStep);
}

function ulAnimStep(ts){
  const elapsed=ts-ulAnimStartTime;
  let t=Math.min(elapsed/ulAnimDurationMs,1);
  t=easeInOutCubic(t);
  const ox0=ulAnimStartOx,oy0=ulAnimStartOy;

  if(ulAnimPhase===0){
    view.gridPixelSize=ulAnimOrigPS+(ulAnimExpandPS-ulAnimOrigPS)*t;
    const ratio=view.gridPixelSize/ulAnimOrigPS;
    view.ox=canvasW/2+(ox0-canvasW/2)*ratio;
    view.oy=canvasH/2+(oy0-canvasH/2)*ratio;
    updateDisplayValues();
    renderFull();
    if(t>=1){
      ulAnimPhase=1;
      view.gridUnitLength=ulAnimNewUL;
      view.gridPixelSize=ulAnimExpandPS;
      ulAnimStartTime=performance.now();
      ulAnimStartPS=ulAnimExpandPS;
      ulAnimStartOx=view.ox;ulAnimStartOy=view.oy;
      ulAnimDurationMs=120;
      updateDisplayValues();
      requestAnimationFrame(ulAnimStep);
    }else{requestAnimationFrame(ulAnimStep);}
  }else{
    view.gridPixelSize=ulAnimStartPS+(ulAnimOrigPS-ulAnimStartPS)*t;
    const ratio=view.gridPixelSize/ulAnimStartPS;
    view.ox=canvasW/2+(ulAnimStartOx-canvasW/2)*ratio;
    view.oy=canvasH/2+(ulAnimStartOy-canvasH/2)*ratio;
    updateDisplayValues();
    renderFull();
    if(t>=1){
      ulAnimating=false;view.gridUnitLength=ulAnimNewUL;view.gridPixelSize=ulAnimOrigPS;
      updateDisplayValues();dirty=true;renderFull();fullRender();
    }else{requestAnimationFrame(ulAnimStep);}
  }
}

// ==================== 画布尺寸 ====================
function resizeCanvas(){
  const rect=canvasWrap.getBoundingClientRect();
  canvasW=rect.width;canvasH=rect.height;
  canvas.width=canvasW*dpr;canvas.height=canvasH*dpr;
  canvas.style.width=canvasW+'px';canvas.style.height=canvasH+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
  if(view.ox===0&&view.oy===0){view.ox=canvasW/2;view.oy=canvasH/2;}

  fullRender();
}
window.addEventListener('resize',resizeCanvas);

// ==================== 面板拖拽大小 ====================
let resizing=false,resizeStartX=0,resizeStartW=0;

panelResizeHandle.addEventListener('mousedown',(e)=>{
  e.preventDefault();e.stopPropagation();
  resizing=true;resizeStartX=e.clientX;
  resizeStartW=leftPanel.getBoundingClientRect().width;
  panelResizeHandle.classList.add('active');
});

// ==================== 交互 ====================
canvas.addEventListener('mousedown',(e)=>{
  if(resizing)return;
  if(pointPlacementMode){
    e.preventDefault();
    dragStartClientX=e.clientX;dragStartClientY=e.clientY;
    dragLastClientX=e.clientX;dragLastClientY=e.clientY;
    return;
  }
    dragging=true;dragStartOx=view.ox;dragStartOy=view.oy;
    dragLastX=e.clientX;dragLastY=e.clientY;
    dragStartClientX=e.clientX;dragStartClientY=e.clientY;
    dragLastClientX=e.clientX;dragLastClientY=e.clientY;
});

window.addEventListener('mousemove',(e)=>{
  if(resizing){
    const newW=Math.max(240,Math.min(600,resizeStartW+(e.clientX-resizeStartX)));
    document.body.style.setProperty('--panel-w',newW+'px');
    document.body.style.userSelect='none';
    return;
  }
  if(pointPlacementMode)return;
  if(dragging){
    const dx=e.clientX-dragLastX,dy=e.clientY-dragLastY;
    dragLastX=e.clientX;dragLastY=e.clientY;
    dragLastClientX=e.clientX;dragLastClientY=e.clientY;
    view.ox+=dx;view.oy+=dy;
    renderFullOnly();
    return;
  }
  const rect=canvas.getBoundingClientRect();
  const px=e.clientX-rect.left,py=e.clientY-rect.top;
  if(px>=0&&px<=canvasW&&py>=0&&py<=canvasH){
    mouseOnCanvas=true;
    const m=screenToMath(px,py);
    mouseMathX=m.mx;mouseMathY=m.my;
    updateCoordDisplay();
  }else{mouseOnCanvas=false;coordDisplay.classList.remove('visible');}
});

window.addEventListener('mouseup',()=>{
  if(resizing){resizing=false;panelResizeHandle.classList.remove('active');document.body.style.userSelect='';resizeCanvas();}
  if(pointPlacementMode)return;
  if(dragging){
    dragging=false;
    const dx=Math.abs(dragLastClientX||0 - dragStartClientX);
    const dy=Math.abs(dragLastClientY||0 - dragStartClientY);
    if(dx<DRAG_THRESHOLD&&dy<DRAG_THRESHOLD){
      // 点击画布查找最近的项并高亮
      handleCanvasClick(dragStartClientX,dragStartClientY);
    }
    dirty=true;fullRender();
  }
});

canvas.addEventListener('wheel',(e)=>{e.preventDefault();},{passive:false});

canvasWrap.addEventListener('click',(e)=>{
  if(e.target.closest('button')||e.target.closest('.placement-toast')||e.target.closest('.coord-display')||e.target.closest('.loading-toast')||e.target.closest('#lineDialog'))return;
  if(pointPlacementMode){
    placePointAt(e.clientX,e.clientY);
    return;
  }
  if(linePlacementMode){
    const rect=canvas.getBoundingClientRect();
    const px=e.clientX-rect.left,py=e.clientY-rect.top;
    const m=screenToMath(px,py);
    const su=smallUnit();
    const snapX=Math.round(m.mx/su)*su;
    const snapY=Math.round(m.my/su)*su;
    const eps=su*0.05;
    for(let i=items.length-1;i>=0;i--){
      const it=items[i];
      if(it.type!=='point'||it.hidden||Math.abs(it.x-snapX)>=eps*5||Math.abs(it.y-snapY)>=eps*5)continue;
      // 如果已经选中了这个点，取消选中（允许重新选择）
      if(linePointA&&it.id===linePointA.id){
        linePointA=linePointB;linePointB=null;
        updateLineDialog();renderFullOnly();
      }
      else if(linePointB&&it.id===linePointB.id){
        linePointB=null;
        updateLineDialog();renderFullOnly();
      }
      else handleLinePointClick(it);
      break;
    }
  }
});

canvas.addEventListener('touchstart',(e)=>{
  if(e.touches.length===1){
    if(pointPlacementMode)return;
    dragging=true;dragStartOx=view.ox;dragStartOy=view.oy;
    dragLastX=e.touches[0].clientX;dragLastY=e.touches[0].clientY;
    dragStartClientX=e.touches[0].clientX;dragStartClientY=e.touches[0].clientY;
    dragLastClientX=e.touches[0].clientX;dragLastClientY=e.touches[0].clientY;
  }
});
canvas.addEventListener('touchmove',(e)=>{
  if(pointPlacementMode)return;
  if(!dragging||e.touches.length!==1)return;e.preventDefault();
  const dx=e.touches[0].clientX-dragLastX,dy=e.touches[0].clientY-dragLastY;
  dragLastX=e.touches[0].clientX;dragLastY=e.touches[0].clientY;
  dragLastClientX=e.touches[0].clientX;dragLastClientY=e.touches[0].clientY;
  view.ox+=dx;view.oy+=dy;
  renderFullOnly();
},{passive:false});
canvas.addEventListener('touchend',()=>{
  if(pointPlacementMode)return;
  if(dragging){
    dragging=false;
    const dx=Math.abs(dragLastClientX - dragStartClientX);
    const dy=Math.abs(dragLastClientY - dragStartClientY);
    if(dx<DRAG_THRESHOLD&&dy<DRAG_THRESHOLD)handleCanvasClick(dragStartClientX,dragStartClientY);
    dirty=true;fullRender();
  }
});

canvas.style.cursor='crosshair';

// ==================== 坐标点拾取 ====================
function nextPointLabel(){
  const used=new Set();
  for(const it of items){if(it.type==='point'&&it.label)used.add(it.label);}
  const letters='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for(let suffix=0;;suffix++){
    for(let i=0;i<26;i++){
      const label=suffix===0?letters[i]:letters[i]+suffix;
      if(!used.has(label))return label;
    }
  }
}

function startPointPlacement(){
  pointPlacementMode=true;
  canvasWrap.classList.add('placement-mode');
  placementToast.classList.add('visible');
  leftPanel.classList.add('disabled');
}

function exitPointPlacement(){
  pointPlacementMode=false;
  canvasWrap.classList.remove('placement-mode');
  placementToast.classList.remove('visible');
  leftPanel.classList.remove('disabled');
}

// ==================== 连线模式 ====================
let linePlacementMode=false;
let linePointA=null;
let linePointB=null;
let lineType='segment';

function startLinePlacement(){
  linePlacementMode=true;
  linePointA=null;
  linePointB=null;
  lineType='segment';
  document.getElementById('linePanelOverlay').classList.add('visible');
  document.getElementById('lineDialog').classList.add('visible');
  leftPanel.classList.add('disabled');
  updateLineDialog();
}

function exitLinePlacement(){
  linePlacementMode=false;
  linePointA=null;
  linePointB=null;
  document.getElementById('linePanelOverlay').classList.remove('visible');
  document.getElementById('lineDialog').classList.remove('visible');
  leftPanel.classList.remove('disabled');
}

function updateLineDialog(){
  const aEl=document.getElementById('linePointA');
  const bEl=document.getElementById('linePointB');
  if(aEl)aEl.textContent=linePointA?linePointA.label:'_';
  if(bEl)bEl.textContent=linePointB?linePointB.label:'_';
  document.querySelectorAll('.line-type-btn').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.lineType===lineType);
  });
}

function selectLineType(type){
  lineType=type;
  updateLineDialog();
}

function handleLinePointClick(point){
  if(!linePlacementMode)return;
  // 禁止重复选择同一个点
  if(!linePointA){
    linePointA=point;
  }else if(!linePointB&&point.id!==linePointA.id){
    linePointB=point;
  }
  updateLineDialog();
  renderFullOnly();
}

function confirmLineCreate(){
  if(!linePointA||!linePointB)return;
  const color=['#16a34a','#dc2626','#ca8a04'][['segment','line','ray'].indexOf(lineType)];
  const label=nextSegmentLabel();
  const midX=(linePointA.x+linePointB.x)/2;
  const midY=(linePointA.y+linePointB.y)/2;
  const length=Math.sqrt(Math.pow(linePointB.x-linePointA.x,2)+Math.pow(linePointB.y-linePointA.y,2));
  const item={
    id:nextItemId(lineType),
    type:lineType,  // segment/line/ray
    pointAId:linePointA.id,
    pointBId:linePointB.id,
    pointA:linePointA,
    pointB:linePointB,
    color:color || '#16a34a',
    hidden:false,
    label:label,
    midX:midX,
    midY:midY,
    length:length
  };
  items.push(item);
  renderItemCards();
  updateItemCount();
  exitLinePlacement();
  fullRender();
  selectItem(item.id);
}

function nextSegmentLabel(){
  const usedLabels=new Set();
  items.forEach(it=>{if(it.type==='segment'||it.type==='line'||it.type==='ray')usedLabels.add(it.label);});
  let idx=0;
  while(true){
    const label=String.fromCharCode(97+idx);
    if(!usedLabels.has(label))return label;
    idx++;
    if(idx>=26)break;
  }
  return 'x';
}



function placePointAt(clientX,clientY){
  const rect=canvas.getBoundingClientRect();
  const px=clientX-rect.left,py=clientY-rect.top;
  const m=screenToMath(px,py);
  const su=smallUnit();
  const snapX=Math.round(m.mx/su)*su;
  const snapY=Math.round(m.my/su)*su;
  const eps=su*0.001;
  for(const it of items){
    if(it.type==='point'&&!it.hidden&&Math.abs(it.x-snapX)<eps&&Math.abs(it.y-snapY)<eps){
      selectItem(it.id,{noAnim:true});
      return;
    }
  }
  const color=nextColor(['#ef4444','#22c55e','#3b82f6','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#f97316']);
  const label=nextPointLabel();
  const item={id:nextItemId('point'),type:'point',x:snapX,y:snapY,color,hidden:false,label};
  items.push(item);
  selectItem(item.id,{noAnim:true});
  renderItemCards();
  updateItemCount();
  fullRender();
}


function toggleAxis() {
  var leftX = document.getElementById('hideXAxis');
  var rightX = document.getElementById('hideXAxisSetting');
  if (rightX) rightX.checked = leftX.checked;
  var leftY = document.getElementById('hideYAxis');
  var rightY = document.getElementById('hideYAxisSetting');
  if (rightY) rightY.checked = leftY.checked;
  view.hideXAxis = leftX.checked;
  view.hideYAxis = leftY.checked;
  fullRender();
}
function toggleGrid() {
  var left = document.getElementById('showGrid');
  var right = document.getElementById('showGridSetting');
  if (right) right.checked = left.checked;   // 同步右侧
  fullRender();
}

function toggleMinorGrid() {
  var left = document.getElementById('showMinorGrid');
  var right = document.getElementById('showMinorGridSetting');
  if (right) right.checked = left.checked;   // 同步右侧
  fullRender();
}

function updatePointStyle() {
  var left = document.getElementById('ptStyleSelect');
  var right = document.getElementById('ptStyleSelectSetting');
  if (right) right.value = left.value;        // 同步右侧
  view.pointStyle = left.value;
  fullRender();
}

document.addEventListener('keydown',(e)=>{
  if(e.key==='Escape'){if(pointPlacementMode)exitPointPlacement();if(linePlacementMode)exitLinePlacement();}if(e.key==='s'||e.key==='S'){toggleCanvasSettings();}
});

// ==================== 虚拟键盘 ====================
let vkVisible=false;
const virtualKeyboard=document.getElementById('virtualKeyboard');
const vkToggle=document.getElementById('vkToggle');
let vkBlurTimeout=null;

function toggleKeyboard(e){
  if(e)e.stopPropagation();
  vkVisible=!vkVisible;
  virtualKeyboard.classList.toggle('visible',vkVisible);
  vkToggle.classList.toggle('active',vkVisible);
}

// 项目列表区域的事件代理：仅手动点击虚拟键盘按钮唤起，聚焦函数输入框不自动弹出
leftPanel.addEventListener('focusout',(e)=>{
  if(e.target.classList.contains('func-expr')){
    if(e.relatedTarget&&virtualKeyboard.contains(e.relatedTarget))return;
    vkBlurTimeout=setTimeout(()=>{
      vkVisible=false;virtualKeyboard.classList.remove('visible');vkToggle.classList.remove('active');
    },200);
  }
});

// 虚拟键盘分栏切换
virtualKeyboard.addEventListener('mousedown',(e)=>{
  e.preventDefault();
  if(vkBlurTimeout){clearTimeout(vkBlurTimeout);vkBlurTimeout=null;}
  // 分栏切换
  const tabBtn=e.target.closest('[data-vktab]');
  if(tabBtn){
    const panelName=tabBtn.dataset.vktab;
    virtualKeyboard.querySelectorAll('.vk-tab').forEach(t=>t.classList.toggle('active',t===tabBtn));
    virtualKeyboard.querySelectorAll('.vk-panel').forEach(p=>p.classList.toggle('active',p.dataset.vkpanel===panelName));
    return;
  }
  // 按钮点击
  const btn=e.target.closest('[data-vk]');
  if(!btn)return;
  const v=btn.dataset.vk;
  const ta=leftPanel.querySelector('.func-expr:focus');
  if(!ta)return;
  if(v==='del'){
    const start=ta.selectionStart,end=ta.selectionEnd;
    if(start!==end){ta.setRangeText('',start,end,'end');}
    else if(start>0){ta.setRangeText('',start-1,start,'end');}
  }else{
    const fnNames=['sin','cos','tan','log','ln','sqrt','abs','exp','asin','acos','atan'];
    const t=v==='pi'?'pi':v;
    const suffix=fnNames.includes(t)?'(':''; // 函数名后自动加括号
    const start=ta.selectionStart,end=ta.selectionEnd;
    ta.setRangeText(t+suffix,start,end,'end');
  }
  ta.dispatchEvent(new Event('input',{bubbles:true}));
  ta.focus();
});

// ==================== 键盘快捷键 ====================
window.addEventListener('keydown',(e)=>{
  if(e.key==='Escape'&&pointPlacementMode){exitPointPlacement();return;}
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
  if(animating||ulAnimating||pointPlacementMode)return;
  const step=canvasW*0.08;
  switch(e.key){
    case 'ArrowLeft':view.ox-=step;break;
    case 'ArrowRight':view.ox+=step;break;
    case 'ArrowUp':view.oy-=step;break;
    case 'ArrowDown':view.oy+=step;break;
    case '0':resetView();return;
    case 'f':case 'F':fitAll();return;
    case 'o':case 'O':centerOrigin();return;
    default:return;
  }
  dirty=true;fullRender();
});

// ==================== 参数管理 ====================
function preprocessAbs(expr){
  let result='',i=0,depth=0;
  while(i<expr.length){
    if(expr[i]==='|'){
      if(depth%2===0){result+='abs(';depth++;}
      else{result+=')';depth++;}
    }else{result+=expr[i];}
    i++;
  }
  while(depth%2!==0){result+=')';depth++;}
  return result;
}

function preprocessExpr(e){
  let s=preprocessAbs(e);
  s=s.replace(/([a-z]\w*|\([^)]*\))\^\((\d+)\/(\d+)\)/g,'nthRoot(($1)^$2,$3)');
  return s;
}

const KNOWN_SYMBOLS=new Set(['x','y','sin','cos','tan','asin','acos','atan','sinh','cosh','tanh','asinh','acosh','atanh','csc','sec','cot','acsc','asec','acot','csch','sech','coth','log','log2','log10','ln','sqrt','abs','exp','mod','ceil','floor','round','sign','min','max','pi','e','i','Infinity','NaN','true','false','null','nthRoot','derivative','simplify','rationalize','pow','norm','det','inv','trace','transpose','concat','cross','dot','map','filter','forEach','sort','size','sum','prod','mean','median','mode','variance','std','combinations','permutations','factorial','gamma','gcd','lcm','random','distance','intersect','bignumber','fraction','matrix','complex','unit','string','number','boolean']);

function detectParams(expr){
  if(!expr||!expr.trim())return[];
  const eq=expr.trim().replace(/\s/g,'');
  let toParse=eq;
  if(eq.includes('y=')&&eq.indexOf('y=')===0)toParse=eq.substring(2);
  if(toParse.includes('=')){const s=toParse.split('=');if(s.length!==2)return[];toParse=s[0]+'-('+s[1]+')';}
  const symbols=new Set();
  try{
    const node=math.parse(preprocessExpr(toParse));
    node.traverse(n=>{if(n.type==='SymbolNode'&&!KNOWN_SYMBOLS.has(n.name))symbols.add(n.name);});
  }catch(e){}
  return [...symbols].sort();
}

function getParamValues(){
  const vals={};
  for(const it of items){if(it.type==='param'&&!it.hidden)vals[it.name]=it.value;}
  return vals;
}

function updateParamButtons(it,pbEl){
  if(!pbEl)return;
  const params=detectParams(it.expr);
  const existing=items.filter(i=>i.type==='param'&&!i.hidden).map(i=>i.name);
  const missing=params.filter(p=>!existing.includes(p));
  if(missing.length===0){
    if(it.errorMsg&&it.errorMsg.indexOf('引用的参数')===0)it.errorMsg='';
    pbEl.style.display='none';return;
  }
  pbEl.style.display='block';
  pbEl.innerHTML='添加滑块：'+missing.map(p=>'<button class="add-param-btn" data-pname="'+p+'">'+p+'</button>').join('');
  pbEl.querySelectorAll('.add-param-btn').forEach(btn=>{
    btn.addEventListener('click',(e)=>{
      e.stopPropagation();
      const name=btn.dataset.pname;
      const item={id:nextItemId('param'),type:'param',name,name,min:-10,max:10,step:0.1,value:1,hidden:false};
      items.push(item);
      selectItem(item.id);
      updateParamButtons(it,pbEl);
      fullRender();
    });
  });
}

// ==================== 添加参数对话框 ====================
function openAddParamDialog(){
  document.getElementById('newParamName').value='';
  document.getElementById('newParamMin').value=-10;
  document.getElementById('newParamMax').value=10;
  document.getElementById('newParamStep').value=0.1;
  document.getElementById('newParamValue').value=1;
  const errEl=document.getElementById('newParamErr');
  errEl.style.display='none';
  document.getElementById('paramDialogOverlay').classList.add('visible');
  setTimeout(()=>{const el=document.getElementById('newParamName');if(el)el.focus();},50);
}

function closeAddParamDialog(){
  document.getElementById('paramDialogOverlay').classList.remove('visible');
}

function confirmAddParam(){
  const nameEl=document.getElementById('newParamName');
  const name=(nameEl.value||'').trim().toLowerCase();
  const errEl=document.getElementById('newParamErr');
  if(!/^[a-z]+$/.test(name)){
    errEl.textContent='参数名称仅允许小写字母 (a-z)，不能包含数字或符号';
    errEl.style.display='block';
    return;
  }
  const existing=items.filter(i=>i.type==='param').map(i=>i.name);
  if(existing.includes(name)){
    errEl.textContent='参数 "'+name+'" 已存在，请更换名称';
    errEl.style.display='block';
    return;
  }
  let min=parseFloat(document.getElementById('newParamMin').value);
  let max=parseFloat(document.getElementById('newParamMax').value);
  let step=parseFloat(document.getElementById('newParamStep').value);
  let value=parseFloat(document.getElementById('newParamValue').value);
  if(isNaN(min))min=-10;
  if(isNaN(max))max=10;
  if(isNaN(step)||step<0)step=0.1;
  if(isNaN(value))value=1;
  if(min>max){const t=min;min=max;max=t;}
  value=clampParam(value,min,max);
  const item={id:nextItemId('param'),type:'param',name,min,max,step,value,hidden:false};
  items.push(item);
  closeAddParamDialog();
  selectItem(item.id);
  renderItemCards();
  updateItemCount();
  fullRender();
}

(function(){
  const el=document.getElementById('newParamName');
  if(el)el.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();confirmAddParam();}});
})();

function isFuncErrored(it){
  if(it.type!=='function')return false;
  if(it.errorMsg)return true;
  const eq=(it.expr||'').trim();
  if(!eq)return false;
  const c=cacheIdMap.get(it.id);
  if(c&&c.type==='error')return true;
  const params=detectParams(it.expr);
  const existing=items.filter(i=>i.type==='param'&&!i.hidden).map(i=>i.name);
  return params.some(p=>!existing.includes(p));
}
function exprToTex(expr){
  const eq=expr.trim().replace(/\s/g,'');
  if(!eq)return '';
  if(!eq.includes('=')&&!eq.includes('y=')){
    try{return math.parse(eq).toTex({parenthesis:'auto',implicit:'hide'});}catch(e){return escapeHtml(eq);}
  }
  if(eq.includes('y=')&&eq.indexOf('y=')===0){
    const rhs=eq.substring(2);
    try{return 'f(x)='+math.parse(rhs).toTex({parenthesis:'auto',implicit:'hide'});}catch(e){return escapeHtml(eq);}
  }
  const sides=eq.split('=');
  if(sides.length!==2)return escapeHtml(eq);
  try{
    return math.parse(sides[0]).toTex({parenthesis:'auto',implicit:'hide'})+'='+math.parse(sides[1]).toTex({parenthesis:'auto',implicit:'hide'});
  }catch(e){return escapeHtml(eq);}
}

function renderFormulaPreview(expr,previewEl){
  if(!previewEl)return;
  const tex=exprToTex(expr);
  if(!tex){previewEl.innerHTML='';return;}
  try{katex.render(tex,previewEl,{throwOnError:false,displayMode:false});}catch(e){previewEl.textContent=expr||'';}
}

function escapeHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function setItemFilter(v){
  itemFilterType=v;
  if(selectedItemId&&itemFilterType!=='all'&&items.find(i=>i.id===selectedItemId&&i.type!==itemFilterType)){
    selectedItemId=null;
  }
  renderItemCards();
}

function renderItemCards(){
  itemListContainer.innerHTML='';
  if(batchMode)selectedItemId=null;
  const visibleItems = filterTypes.length === 0 ? items : items.filter(it => filterTypes.includes(it.type));
  visibleItems.forEach(it=>{
    const card=document.createElement('div');
    card.className='item-card'+(it.id===selectedItemId&&!batchMode?' selected':'')+(batchMode&&batchSelected.has(it.id)?' item-checked':'');
    card.dataset.id=it.id;

    if(it.id===selectedItemId&&!batchMode){
      card.innerHTML=createExpandedHTML(it);
      setupExpandedEvents(card,it);
    }else{
      card.innerHTML=createCompactHTML(it);
      const fEl=card.querySelector('.compact-formula');
      if(fEl&&fEl.dataset.katex){
        try{katex.render(fEl.dataset.katex,fEl,{throwOnError:false,displayMode:false});}catch(e){fEl.textContent=it.expr||'(空)';}
      }
      // Update checkbox state for batch mode
      const cb=card.querySelector('.batch-cb');
      if(cb)cb.checked=batchSelected.has(it.id);
    }

    card.addEventListener('click',(e)=>{
      if(e.target.closest('[data-del]')){
        e.stopPropagation();
        if(batchMode)return;
        removeItem(e.target.closest('[data-del]').dataset.del);
        return;
      }
      if(batchMode){
        if(e.target.classList.contains('batch-cb'))return;
        toggleBatchItem(null,it.id);
        return;
      }
      if(e.target.tagName==='BUTTON'||e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
      if(e.target.closest('.drag-handle'))return;
      if(it.id===selectedItemId){selectItem(null);}else{selectItem(it.id);}
    });

    // 拖拽排序：仅按住标题条目标签区域（.drag-handle）可拖动
    if(!batchMode){
      card.addEventListener('dragstart',(e)=>{
        if(!e.target.closest('.drag-handle')){e.preventDefault();return;}
        if(it.id!==selectedItemId)return;
        e.dataTransfer.setData('text/plain',it.id.toString());
        e.dataTransfer.effectAllowed='move';
        card.style.opacity='0.5';
      });
      card.addEventListener('dragend',()=>{card.style.opacity='';});
      card.addEventListener('dragover',(e)=>{e.preventDefault();e.dataTransfer.dropEffect='move';});
      card.addEventListener('drop',(e)=>{
        e.preventDefault();
        const fromId=e.dataTransfer.getData('text/plain');
        if(fromId===it.id)return;
        const fromIdx=items.findIndex(x=>x.id===fromId);
        const toIdx=items.findIndex(x=>x.id===it.id);
        if(fromIdx<0||toIdx<0)return;
        const [moved]=items.splice(fromIdx,1);
        items.splice(toIdx,0,moved);
        selectItem(moved.id);
        renderItemCards();
        updateItemCount();
      });
    }

    itemListContainer.appendChild(card);
  });
  updateBatchUI();
}

function createCompactHTML(it){
  const seq=items.indexOf(it)+1;
  if(it.type==='function'){
    const tex=exprToTex(it.expr||'');
    const errored=isFuncErrored(it);
    return '<div class="item-card-compact">'+
      '<input type="checkbox" class="batch-cb" data-batch="'+it.id+'" onchange="toggleBatchItem(event,\''+it.id+'\')">'+
      '<span class="seq">#'+seq+'</span>'+
      '<span class="type-tag func'+(errored?' errored':'')+'">函数 </span>'+
      '<span class="compact-formula" data-katex="'+escapeHtml(tex||'(空)')+'"></span>'+
      '</div>';
  }else if(it.type==='point'){
    const dp=getDecimalPrecision();
    const label=it.label||'';
    return '<div class="item-card-compact">'+
      '<input type="checkbox" class="batch-cb" data-batch="'+it.id+'" onchange="toggleBatchItem(event,\''+it.id+'\')">'+
      '<span class="seq">#'+seq+'</span>'+
      '<span class="type-tag point">坐标 </span>'+
      '<span class="compact-formula">'+(label?label+' = ':'')+'('+safeToFixed(it.x,dp)+', '+safeToFixed(it.y,dp)+')</span>'+
      '<button class="del-btn-sm" data-del="'+it.id+'">删除</button>'+
      '</div>';
  }else if(it.type==='segment'||it.type==='line'||it.type==='ray'){
    const typeName=it.type==='segment'?'线段':it.type==='line'?'直线':'射线';
    const typeClass=it.type;
    const label=it.label||'';
    const aLabel=it.pointA?it.pointA.label:'?';
    const bLabel=it.pointB?it.pointB.label:'?';
    const dp=getDecimalPrecision();
    const lenDisplay=typeof it.length==='number'?it.length.toFixed(dp):'?';
    const isSelected=it.id===selectedItemId&&!batchMode;
    let html='<div class="item-card-compact">'+
      '<input type="checkbox" class="batch-cb" data-batch="'+it.id+'" onchange="toggleBatchItem(event,\''+it.id+'\')">'+
      '<span class="seq">#'+seq+'</span>'+
      '<span class="type-tag '+typeClass+'">'+typeName+' </span>';
    if(isSelected){
      // 获焦点：显示 x(字母) = 线段长度
      const nextLetter=aLabel.replace(/[a-z]/,l=>String.fromCharCode(96+((l.charCodeAt(0)-96+1)%26||26)));
      html+='<span class="compact-formula">'+label+'( '+aLabel+nextLetter+' ) = '+lenDisplay+'</span>';
    }else{
      // 失焦点：显示序号 + 小写字母 + 两点标号 + 长度
      const nextLetter=aLabel.replace(/[a-z]/,l=>String.fromCharCode(96+((l.charCodeAt(0)-96+1)%26||26)));
      html+='<span class="compact-formula">'+label+'('+aLabel+'→'+bLabel+') = '+lenDisplay+'</span>';
    }
    html+='<button class="del-btn-sm" data-del="'+it.id+'">删除</button></div>';
    return html;
  }else{
    // param type
    return '<div class="item-card-compact">'+
      '<input type="checkbox" class="batch-cb" data-batch="'+it.id+'" onchange="toggleBatchItem(event,\''+it.id+'\')">'+
      '<span class="seq">#'+seq+'</span>'+
      '<span class="type-tag param">参数 </span>'+
      '<span class="compact-formula">'+it.name+' = '+safeToFixed(it.value,2)+'</span>'+
      '</div>';
  }
}

function createExpandedHTML(it){
  if(it.type==='function')return createFuncExpandedHTML(it);
  if(it.type==='point')return createPointExpandedHTML(it);
  if(it.type==='segment'||it.type==='line'||it.type==='ray')return createSegmentExpandedHTML(it);
  return createParamExpandedHTML(it);
}

function createFuncExpandedHTML(it){
  const seq=items.indexOf(it)+1;
  const errored=isFuncErrored(it);
  return '<div class="item-card-expanded">'+
    '<div style="display:flex;justify-content:space-between;align-items:center;"><span class="drag-handle" draggable="true" title="按住拖动排序">&#9776; <span class="type-tag func'+(errored?' errored':'')+'">函数 #'+seq+'</span></span>'+
    '<div style="display:flex;align-items:center;gap:6px;"><span class="item-id">ID: '+it.id+'</span>'+
    '<button class="vis-btn" data-vis="'+it.id+'">'+(it.hidden?'显示':'隐藏')+'</button>'+
    '<button class="danger-btn del-btn-sm" data-del="'+it.id+'">删除</button></div></div>'+
    '<div class="formula-preview" data-preview="'+it.id+'"></div>'+
    '<textarea class="func-expr" data-expr="'+it.id+'" placeholder="y=sin(x) 或 x^2+y^2=1">'+escapeHtml(it.expr)+'</textarea>'+
    '<div class="err-msg" data-err="'+it.id+'"'+(it.errorMsg?' style="display:block;">'+escapeHtml(it.errorMsg):'>')+'</div>'+
    '<div class="param-buttons" data-params="'+it.id+'" style="display:none;margin-top:6px;font-size:12px;"></div>'+
    '<div class="item-meta"><input type="color" value="'+it.color+'" data-color="'+it.id+'" title="曲线颜色"></div>'+
    '</div>';
}

function createParamExpandedHTML(it){
  const seq=items.indexOf(it)+1;
  const v=it.value;
  return '<div class="item-card-expanded">'+
    '<div style="display:flex;justify-content:space-between;align-items:center;"><span class="drag-handle" draggable="true" title="按住拖动排序">&#9776; <span class="type-tag param">参数 #'+seq+' ('+it.name+')</span></span>'+
    '<div style="display:flex;align-items:center;gap:6px;"><span class="item-id">ID: '+it.id+'</span>'+
    '<button class="vis-btn" data-vis="'+it.id+'">'+(it.hidden?'显示':'隐藏')+'</button>'+
    '<button class="danger-btn del-btn-sm" data-del="'+it.id+'">删除</button></div></div>'+
    '<div style="display:flex;align-items:center;gap:8px;">'+
    '<input type="range" min="'+it.min+'" max="'+it.max+'" step="'+it.step+'" value="'+v+'" data-prange="'+it.id+'" style="flex:1;min-width:0;">'+
    '<button data-pstep-btn="-1" title="按步长减小" style="width:26px;height:26px;border:1px solid #d1d5db;background:#fff;border-radius:4px;cursor:pointer;font-size:14px;flex-shrink:0;">-</button>'+
    '<button data-pstep-btn="1" title="按步长增加" style="width:26px;height:26px;border:1px solid #d1d5db;background:#fff;border-radius:4px;cursor:pointer;font-size:14px;flex-shrink:0;">+</button>'+
    '<button data-panim="'+it.id+'" title="播放/暂停参数动画" style="width:26px;height:26px;border:1px solid '+(paramAnims.has(it.id)?'#6366f1':'#d1d5db')+';background:'+(paramAnims.has(it.id)?'#eef2ff':'#fff')+';border-radius:4px;cursor:pointer;font-size:13px;flex-shrink:0;">'+(paramAnims.has(it.id)?'⏸':'▶')+'</button>'+
    '</div>'+
    '<div class="item-meta" style="gap:4px;flex-wrap:wrap;">'+
    '<label>最小: <input type="number" value="'+it.min+'" data-pmin="'+it.id+'" step="any" style="width:50px;"></label>'+
    '<label>最大: <input type="number" value="'+it.max+'" data-pmax="'+it.id+'" step="any" style="width:50px;"></label>'+
    '<label>步长: <input type="number" value="'+it.step+'" data-pstep="'+it.id+'" step="any" style="width:50px;"></label>'+
    '<label>值: <input type="number" value="'+safeToFixed(v,2)+'" data-pval="'+it.id+'" step="any" style="width:56px;"></label>'+
    '</div></div>';
}

function funcOptions(selId){
  let s='<option value="">无</option>';
  for(const f of items){
    if(f.type!=='function')continue;
    s+='<option value="'+f.id+'"'+(f.id===selId?' selected':'')+'>'+escapeHtml(f.id)+'</option>';
  }
  return s;
}

// 实时刷新展开中的坐标点卡片：更新 X/Y 值显示、Y 函数下拉选项与绑定失效提示。
// 在参数值变化、函数增删后调用，避免整卡重建打断正在编辑的输入框。
function refreshPointDisplays(){
  document.querySelectorAll('.item-card-expanded').forEach(card=>{
    const delBtn=card.querySelector('[data-del]');
    if(!delBtn)return;
    const it=items.find(i=>i.id===delBtn.dataset.del);
    if(!it||it.type!=='point')return;
    const xv=card.querySelector('[data-ptxval]');
    const yv=card.querySelector('[data-ptyval]');
    if(xv)xv.textContent=formatNumber(it.x);
    if(yv)yv.textContent=formatNumber(it.y);
    const yf=card.querySelector('[data-ptyfunc]');
    if(yf){
      const sel=yf.value;
      yf.innerHTML=funcOptions(it.yFuncId);
      if(sel&&yf.querySelector('option[value="'+sel+'"]'))yf.value=sel;
    }
    const yerr=card.querySelector('[data-ptyerr]');
    if(yerr){
      if(it.yMode==='func'&&it.yFuncId&&!items.some(f=>f.type==='function'&&f.id===it.yFuncId)){
        yerr.textContent='绑定的函数已删除，请重新选择函数';
        yerr.style.display='block';
      }else{
        yerr.textContent='';
        yerr.style.display='none';
      }
    }
  });
}

function createPointExpandedHTML(it){
  const seq=items.indexOf(it)+1;
  const dp=getDecimalPrecision();
  const label=it.label||'';
  const xMode=it.xMode||'fixed';
  const yMode=it.yMode||'fixed';
  const xFixed=(it.xFixed!==undefined?it.xFixed:it.x);
  const yFixed=(it.yFixed!==undefined?it.yFixed:it.y);
  const escExpr=function(s){return escapeHtml(s==null?'':s).replace(/"/g,'&quot;');};
  const xExpr=it.xParamExpr!=null?String(it.xParamExpr):(it.xParamId?paramNameById(it.xParamId):'');
  const yExpr=it.yParamExpr!=null?String(it.yParamExpr):(it.yParamId?paramNameById(it.yParamId):'');
  const modeOptsX=function(sel){
    return '<option value="fixed"'+(sel==='fixed'?' selected':'')+'>固定</option>'+
      '<option value="param"'+(sel==='param'?' selected':'')+'>参数</option>';
  };
  const modeOpts=function(sel){
    return '<option value="fixed"'+(sel==='fixed'?' selected':'')+'>固定</option>'+
      '<option value="param"'+(sel==='param'?' selected':'')+'>参数</option>'+
      '<option value="func"'+(sel==='func'?' selected':'')+'>函数</option>';
  };
  const rowX='<div class="pt-row">'+
    '<span class="pt-axis">X</span>'+
    '<select data-ptxmode>'+modeOptsX(xMode==='func'?'fixed':xMode)+'</select>'+
    '<span class="pt-wrap" data-ptx-fixedwrap'+(xMode==='fixed'?'':' style="display:none;"')+'><input type="number" data-ptx-fixed step="0.01" value="'+safeToFixed(xFixed,dp)+'" style="width:76px;" title="固定数值"></span>'+
    '<span class="pt-wrap" data-ptx-paramwrap'+(xMode==='param'?'':' style="display:none;"')+'><input type="text" data-ptxparam-expr placeholder="如 2*a+1" value="'+escExpr(xExpr)+'" style="width:112px;" title="参数表达式，可引用已创建的参数"></span>'+
    '<span class="pt-val" data-ptxval>'+formatNumber(it.x)+'</span>'+
    '<span class="pt-hint">'+(xMode==='param'?'参数表达式':'')+'</span>'+
  '</div>'+
  '<div class="pt-row pt-row-err" data-ptxerr style="display:none;"></div>';
  const rowY='<div class="pt-row">'+
    '<span class="pt-axis">Y</span>'+
    '<select data-ptymode>'+modeOpts(yMode)+'</select>'+
    '<span class="pt-wrap" data-pty-fixedwrap'+(yMode==='fixed'?'':' style="display:none;"')+'><input type="number" data-pty-fixed step="0.01" value="'+safeToFixed(yFixed,dp)+'" style="width:76px;" title="固定数值"></span>'+
    '<span class="pt-wrap" data-pty-paramwrap'+(yMode==='param'?'':' style="display:none;"')+'><input type="text" data-ptyparam-expr placeholder="如 3*b-1" value="'+escExpr(yExpr)+'" style="width:112px;" title="参数表达式，可引用已创建的参数"></span>'+
    '<span class="pt-wrap" data-pty-funcwrap'+(yMode==='func'?'':' style="display:none;"')+'><select data-ptyfunc style="max-width:90px;" title="绑定函数唯一ID">'+funcOptions(it.yFuncId)+'</select></span>'+
    '<span class="pt-val" data-ptyval>'+formatNumber(it.y)+'</span>'+
    '<span class="pt-hint">'+((yMode==='func'?'y=f(x)':yMode==='param'?'参数表达式':''))+'</span>'+
  '</div>'+
  '<div class="pt-row pt-row-err" data-ptyerr style="display:none;"></div>';
  return '<div class="item-card-expanded">'+
    '<div style="display:flex;justify-content:space-between;align-items:center;"><span class="drag-handle" draggable="true" title="按住拖动排序">&#9776; <span class="type-tag point">坐标 #'+seq+(label?' <b>'+label+'</b>':'')+'</span></span>'+
    '<div style="display:flex;align-items:center;gap:6px;"><span class="item-id">ID: '+it.id+'</span>'+
    '<button class="vis-btn" data-vis="'+it.id+'">'+(it.hidden?'显示':'隐藏')+'</button>'+
    '<button class="danger-btn del-btn-sm" data-del="'+it.id+'">删除</button></div></div>'+
    '<div class="item-meta point-edit-meta">'+
    rowX+rowY+
    '<div style="display:flex;align-items:center;gap:8px;"><input type="color" value="'+it.color+'" data-color="'+it.id+'" title="颜色">'+
    '<span class="pt-hint">函数模式：将另一轴的值代入绑定函数计算</span></div>'+
    '</div>'+
    '</div>';
}

function createSegmentExpandedHTML(it) {
  const seq = items.indexOf(it) + 1;
  const typeName = it.type === 'segment' ? '线段' : (it.type === 'line' ? '直线' : '射线');
  const aLabel = it.pointA ? it.pointA.label : '?';
  const bLabel = it.pointB ? it.pointB.label : '?';
  // 计算当前 k, b 并生成公式字符串 + 自变量范围
  let formula = '未定义';
  let rangeStr = '';
  if (it.k !== undefined) {
    if (it.k === Infinity) {
      formula = 'x = ' + safeToFixed(it.b, 2);
      // 垂直线的范围显示为 y ∈ ℝ（可忽略）
      rangeStr = ', y ∈ ℝ';
    } else {
      const sign = it.b >= 0 ? '+ ' : '- ';
      formula = 'y = ' + safeToFixed(it.k, 2) + 'x ' + sign + safeToFixed(Math.abs(it.b), 2);
      // 根据类型添加自变量范围
      if (it.type === 'segment') {
        const xMin = Math.min(it.pointA.x, it.pointB.x);
        const xMax = Math.max(it.pointA.x, it.pointB.x);
        rangeStr = `, x ∈ [${safeToFixed(xMin, 2)}, ${safeToFixed(xMax, 2)}]`;
      } else if (it.type === 'ray') {
        const dx = it.pointB.x - it.pointA.x;
        if (dx > 0) {
          rangeStr = `, x ∈ [${safeToFixed(it.pointA.x, 2)}, ∞)`;
        } else {
          rangeStr = `, x ∈ (-∞, ${safeToFixed(it.pointA.x, 2)}]`;
        }
      } else { // line
        rangeStr = ', x ∈ ℝ';
      }
    }
  }
  const fullFormula = formula + rangeStr;

  return `<div class="item-card-expanded">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <span class="drag-handle" draggable="true">&#9776; <span class="type-tag ${it.type}">${typeName} #${seq} <b>${it.label}</b></span></span>
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="item-id">ID: ${it.id}</span>
        <button class="vis-btn" data-vis="${it.id}">${it.hidden ? '显示' : '隐藏'}</button>
        <button class="danger-btn del-btn-sm" data-del="${it.id}">删除</button>
      </div>
    </div>
    <div style="font-size:12px;color:#666;margin-bottom:8px;">
      长度：${typeof it.length === 'number' ? it.length.toFixed(2) : '?'} 单位
    </div>
    <div style="margin-bottom:8px;background:#f5f5f5;padding:6px 10px;border-radius:4px;font-family:Consolas;font-size:13px;">
      <strong>一次函数：</strong> ${fullFormula}
    </div>
    <div class="item-meta" style="gap:8px;flex-wrap:wrap;">
      <label>点 A: <input type="text" value="${aLabel}" data-seg-pointa="${it.id}" style="width:60px;text-transform:lowercase;" pattern="[a-z]"></label>
      <label>点 B: <input type="text" value="${bLabel}" data-seg-pointb="${it.id}" style="width:60px;text-transform:lowercase;" pattern="[a-z]"></label>
      <input type="color" value="${it.color}" data-color="${it.id}" title="颜色">
    </div>
  </div>`;
}

function setupExpandedEvents(card,it){
  if(it.type==='function'){
    setupFuncExpandedEvents(card,it);
  }else if(it.type==='point'){
    setupPointExpandedEvents(card,it);
  }else if(it.type==='segment'||it.type==='line'||it.type==='ray'){
    setupSegmentExpandedEvents(card,it);
  }else{
    setupParamExpandedEvents(card,it);
  }
  // common events
  const visBtn=card.querySelector('[data-vis]');
  if(visBtn)visBtn.addEventListener('click',(e)=>{e.stopPropagation();it.hidden=!it.hidden;visBtn.textContent=it.hidden?'显示':'隐藏';fullRender();});
  const colorI=card.querySelector('[data-color]');
  if(colorI)colorI.addEventListener('input',()=>{it.color=colorI.value;fullRender();});
}

function setupFuncExpandedEvents(card,it){
  const eI=card.querySelector('[data-expr]');
  const eM=card.querySelector('[data-err]');
  const pv=card.querySelector('[data-preview]');
  const pb=card.querySelector('[data-params]');
  if(eI){
    renderFormulaPreview(it.expr,pv);
    const updateExpr=()=>{
      it.expr=eI.value;
      renderFormulaPreview(it.expr,pv);
      const eq=it.expr.trim().replace(/\s/g,'');
      if(pb)updateParamButtons(it,pb);
      if(!eq){it.errorMsg='表达式为空';if(eM){eM.style.display='block';eM.textContent=it.errorMsg;}fullRender();return;}
      if(!eq.includes('=')&&!eq.includes('y=')){try{math.compile(preprocessExpr(eq));it.errorMsg='';if(eM)eM.style.display='none';}catch(e){it.errorMsg='语法错误: '+e.message;if(eM){eM.style.display='block';eM.textContent=it.errorMsg;}}fullRender();return;}
      if(eq.includes('y=')&&eq.indexOf('y=')===0){try{math.compile(preprocessExpr(eq.substring(2)));it.errorMsg='';if(eM)eM.style.display='none';}catch(e){it.errorMsg='语法错误: '+e.message;if(eM){eM.style.display='block';eM.textContent=it.errorMsg;}}fullRender();return;}
      const sides=eq.split('=');
      if(sides.length!==2){it.errorMsg='等式需恰好一个 =';if(eM){eM.style.display='block';eM.textContent=it.errorMsg;}fullRender();return;}
      try{math.compile(preprocessExpr(sides[0]));math.compile(preprocessExpr(sides[1]));it.errorMsg='';if(eM)eM.style.display='none';}catch(e){it.errorMsg='语法错误: '+e.message;if(eM){eM.style.display='block';eM.textContent=it.errorMsg;}}
      fullRender();
    };
    eI.addEventListener('input',updateExpr);
    eI.addEventListener('focus',()=>{
      updateExpr();
    });
    eI.addEventListener('blur',()=>{
      updateExpr();
      renderItemCards();
    });
    updateExpr();
    if(pb)updateParamButtons(it,pb);
  }
}

function setupPointExpandedEvents(card,it){
  const modeX=card.querySelector('[data-ptxmode]');
  const modeY=card.querySelector('[data-ptymode]');
  const fixedX=card.querySelector('[data-ptx-fixed]');
  const fixedY=card.querySelector('[data-pty-fixed]');
  const paramX=card.querySelector('[data-ptxparam-expr]');
  const paramY=card.querySelector('[data-ptyparam-expr]');
  const funcY=card.querySelector('[data-ptyfunc]');
  const valX=card.querySelector('[data-ptxval]');
  const valY=card.querySelector('[data-ptyval]');
  const errX=card.querySelector('[data-ptxerr]');
  const errY=card.querySelector('[data-ptyerr]');

  function apply(silent){
    resolveAllPoints();
    if(valX)valX.textContent=formatNumber(it.x);
    if(valY)valY.textContent=formatNumber(it.y);
    if(errX){errX.textContent=it.xErr||'';errX.style.display=it.xErr?'block':'none';}
    if(errY){errY.textContent=it.yErr||'';errY.style.display=it.yErr?'block':'none';}
    if(it.errorMsg){
      if(!silent&&!it._errNotified){
        it._errNotified=true;
        alert('坐标点 '+(it.label||it.id)+' 计算异常：'+it.errorMsg);
      }
    }else{
      it._errNotified=false;
    }
    renderFull();
  }
  function refreshCard(){
    apply(true);
    renderExpandedItem(it.id);
  }
  if(modeX)modeX.addEventListener('change',()=>{it.xMode=modeX.value;refreshCard();});
  if(modeY)modeY.addEventListener('change',()=>{it.yMode=modeY.value;refreshCard();});
  if(fixedX)fixedX.addEventListener('input',()=>{it.xFixed=Number(fixedX.value)||0;apply(true);});
  if(fixedY)fixedY.addEventListener('input',()=>{it.yFixed=Number(fixedY.value)||0;apply(true);});
  if(paramX){
    paramX.addEventListener('input',()=>{it.xParamExpr=paramX.value;apply(true);});
    paramX.addEventListener('blur',()=>{if(it.xErr){it._errNotified=false;apply(false);}});
  }
  if(paramY){
    paramY.addEventListener('input',()=>{it.yParamExpr=paramY.value;apply(true);});
    paramY.addEventListener('blur',()=>{if(it.yErr){it._errNotified=false;apply(false);}});
  }
  if(funcY)funcY.addEventListener('change',()=>{it.yFuncId=funcY.value||null;if(funcY.value)it.yMode='func';apply();});
}


function setupSegmentExpandedEvents(card, it) {
  const pointAInput = card.querySelector('[data-seg-pointa]');
  const pointBInput = card.querySelector('[data-seg-pointb]');

  // 通用的重新绑定函数
  function rebindPoint(input, which) {
    const val = input.value.trim().toLowerCase();
    if (!/^[a-z]$/.test(val)) {
      alert('标号必须是单个小写字母');
      input.value = which === 'A' ? (it.pointA ? it.pointA.label : '') : (it.pointB ? it.pointB.label : '');
      return;
    }
    const found = items.find(p => p.type === 'point' && p.label && p.label.toLowerCase() === val);
    if (!found) {
      alert('找不到标号为 "' + val + '" 的坐标点');
      input.value = which === 'A' ? (it.pointA ? it.pointA.label : '') : (it.pointB ? it.pointB.label : '');
      return;
    }
    if (which === 'A') it.pointA = found;
    else it.pointB = found;
    // 更新一次函数并刷新界面
    updateSegmentLineItems();
    fullRender();
    // 刷新卡片中的公式显示
    const formulaDiv = card.querySelector('.item-card-expanded > div:nth-child(3)');
    if (formulaDiv) {
      let formula = '未定义';
      if (it.k !== undefined) {
        if (it.k === Infinity) {
          formula = 'x = ' + safeToFixed(it.b, 2);
        } else {
          const sign = it.b >= 0 ? '+ ' : '- ';
          formula = 'y = ' + safeToFixed(it.k, 2) + 'x ' + sign + safeToFixed(Math.abs(it.b), 2);
        }
      }
      formulaDiv.innerHTML = '<strong>一次函数：</strong> ' + formula;
    }
  }

  if (pointAInput) {
    pointAInput.addEventListener('blur', () => rebindPoint(pointAInput, 'A'));
  }
  if (pointBInput) {
    pointBInput.addEventListener('blur', () => rebindPoint(pointBInput, 'B'));
  }
}

function updateSegmentData(it){
  if(!it.pointA||!it.pointB)return;
  it.midX=(it.pointA.x+it.pointB.x)/2;
  it.midY=(it.pointA.y+it.pointB.y)/2;
  it.length=Math.sqrt(Math.pow(it.pointB.x-it.pointA.x,2)+Math.pow(it.pointB.y-it.pointA.y,2));
}

function renderExpandedItem(id){
  const card=itemListContainer.querySelector('.item-card.selected');
  if(card){
    const it=items.find(x=>x.id===id);
    if(it&&it.id===selectedItemId){
      card.innerHTML=createExpandedHTML(it);
      setupExpandedEvents(card,it);
    }
  }
}

function clampParam(v,min,max){
  v=Number(v);
  if(!isFinite(v))v=min;
  return Math.min(max,Math.max(min,v));
}

function setupParamExpandedEvents(card,it){
  const rangeI=card.querySelector('[data-prange]');
  const valI=card.querySelector('[data-pval]');
  const minI=card.querySelector('[data-pmin]');
  const maxI=card.querySelector('[data-pmax]');
  const stepI=card.querySelector('[data-pstep]');
  function syncVal(){
    if(rangeI)rangeI.value=it.value;
    if(valI)valI.value=it.value.toFixed(2);
  }
  if(rangeI&&valI){
    rangeI.addEventListener('input',()=>{
      it.value=Number(rangeI.value);valI.value=it.value.toFixed(2);
      fullRender();refreshPointDisplays();
    });
    valI.addEventListener('input',()=>{
      it.value=clampParam(valI.value,it.min,it.max);rangeI.value=it.value;
      fullRender();refreshPointDisplays();
    });
  }
  if(minI)minI.addEventListener('input',()=>{
    it.min=Number(minI.value)||-10;
    it.value=clampParam(it.value,it.min,it.max);
    if(rangeI){rangeI.min=it.min;rangeI.max=it.max;rangeI.step=it.step;rangeI.value=it.value;}
    if(valI){valI.value=it.value.toFixed(2);}
    fullRender();
  });
  if(maxI)maxI.addEventListener('input',()=>{
    it.max=Number(maxI.value)||10;
    it.value=clampParam(it.value,it.min,it.max);
    if(rangeI){rangeI.max=it.max;rangeI.step=it.step;rangeI.value=it.value;}
    if(valI){valI.value=it.value.toFixed(2);}
    fullRender();
  });
  if(stepI)stepI.addEventListener('input',()=>{
    it.step=Number(stepI.value)||0.1;
    if(rangeI){rangeI.step=it.step;rangeI.min=it.min;rangeI.max=it.max;rangeI.value=it.value;}
    if(valI){valI.value=it.value.toFixed(2);}
    fullRender();
  });
  card.querySelectorAll('[data-pstep-btn]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const dir=parseInt(btn.dataset.pstepBtn,10)||0;
      const step=Math.abs(it.step)||0.1;
      it.value=clampParam(it.value+dir*step,it.min,it.max);
      syncVal();
      fullRender();
    });
  });
  const animBtn=card.querySelector('[data-panim]');
  if(animBtn)animBtn.addEventListener('click',()=>toggleParamAnim(it.id));
}

function refreshParamAnimBtn(id,playing){
  const card=itemListContainer.querySelector('[data-id="'+id+'"] .item-card-expanded');
  if(!card)return;
  const b=card.querySelector('[data-panim]');
  if(b){
    b.textContent=playing?'⏸':'▶';
    b.style.borderColor=playing?'#6366f1':'#d1d5db';
    b.style.background=playing?'#eef2ff':'#fff';
  }
}

function startParamAnim(id){
  const p=items.find(i=>i.id===id&&i.type==='param');
  if(!p||paramAnims.has(id))return;
  paramAnims.set(id,{mode:animSettings.mode,dir:1,atTop:false,atBottom:false});
  refreshParamAnimBtn(id,true);
  if(!paramAnimRAF)paramAnimRAF=requestAnimationFrame(paramAnimLoop);
}

function stopParamAnim(id){
  paramAnims.delete(id);
  refreshParamAnimBtn(id,false);
  if(paramAnims.size===0&&paramAnimRAF){
    cancelAnimationFrame(paramAnimRAF);paramAnimRAF=0;
  }
}

function toggleParamAnim(id){
  if(paramAnims.has(id))stopParamAnim(id);
  else startParamAnim(id);
}

let lastComputeTime = 0;
let computeInterval = 100;  // 可调参数

function paramAnimLoop(now) {
  if (paramAnims.size === 0) {
    paramAnimRAF = 0;
    return;
  }
  let changed = false;
  for (const [id, st] of [...paramAnims]) {
    const p = items.find(i => i.id === id && i.type === 'param');
    if (!p) {
      paramAnims.delete(id);
      refreshParamAnimBtn(id, false);
      continue;
    }
    const step = Math.max(Math.abs(p.step) || 0.1, 1e-6) * animSettings.speed;
    let v;
    if (st.mode === 'bidirectional') {
      v = p.value + st.dir * step;
      if (v >= p.max) { v = p.max; st.dir = -1; }
      else if (v <= p.min) { v = p.min; st.dir = 1; }
    } else if (st.mode === 'increment') {
      if (st.atTop) { v = p.min; st.atTop = false; }
      else { v = p.value + step; if (v >= p.max) { v = p.max; st.atTop = true; } }
    } else {
      if (st.atBottom) { v = p.max; st.atBottom = false; }
      else { v = p.value - step; if (v <= p.min) { v = p.min; st.atBottom = true; } }
    }
    p.value = Math.min(p.max, Math.max(p.min, v));
    // 更新 UI 滑块和数值显示
    const card = itemListContainer.querySelector('[data-id="'+id+'"] .item-card-expanded');
    if (card) {
      const rangeI = card.querySelector('[data-prange]');
      const valI = card.querySelector('[data-pval]');
      if (rangeI) rangeI.value = p.value;
      if (valI) valI.value = p.value.toFixed(2);
    }
    changed = true;
  }

  if (changed) {
    // 1. 更新所有坐标点和连线（同步）
    resolveAllPoints();  // 内部会调用 updateSegmentLineItems

    // 2. 立即绘制所有内容（使用现有函数图像缓存）
    drawGridTo(ctx);
    drawCurvesTo(ctx);   // 使用缓存图像
    drawSegmentsTo(ctx);
    drawPointsTo(ctx);

    // 3. 控制函数图像重新计算的频率（节流）
    const nowTime = performance.now();
    if (nowTime - lastComputeTime > computeInterval) {
      lastComputeTime = nowTime;
      // 触发 Worker 更新函数图像（异步）
      dirty = true;
      requestCompute();
    }
  }

  paramAnimRAF = requestAnimationFrame(paramAnimLoop);
}
function selectItem(id,opts){
  const noAnim=opts&&opts.noAnim;
  if(batchMode){batchMode=false;batchSelected.clear();leftPanel.classList.remove('batch-mode');document.getElementById('batchToolbar').style.display='none';const btEl=document.getElementById('batchToggle');if(btEl)btEl.classList.remove('active');}
  selectedItemId=id;
  if(id!==null&&!noAnim){
    const it=items.find(i=>i.id===id);
    if(it&&it.type==='point'){
      const ps=mathToScreen(it.x,it.y);
      startAnim(view.ox+canvasW/2-ps.sx,view.oy+canvasH/2-ps.sy,view.gridPixelSize);
    }else if(it&&it.type==='function'){
      const c=cacheIdMap.get(it.id);
      if(c&&c.type!=='skip'&&c.type!=='error'){
        let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
        const segs=c.type==='explicit'?c.segments:(c.segments||[]);
        for(const seg of segs){
          for(let i=c.type==='explicit'?0:0;i<seg.length;i+=(c.type==='explicit'?1:2)){
            const mx=c.type==='explicit'?seg[i][0]:seg[i],my=c.type==='explicit'?seg[i][1]:seg[i+1];
            if(isFinite(mx)){minX=Math.min(minX,mx);maxX=Math.max(maxX,mx);}
            if(isFinite(my)){minY=Math.min(minY,my);maxY=Math.max(maxY,my);}
          }
        }
        if(isFinite(minX)){
          const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
          const ps=mathToScreen(cx,cy);
          startAnim(view.ox+canvasW/2-ps.sx,view.oy+canvasH/2-ps.sy,view.gridPixelSize);
        }
      }
    }
  }
  renderItemCards();
  if(id!==null){
    setTimeout(()=>{
      const card=itemListContainer.querySelector('[data-id="'+id+'"]');
      if(card)card.scrollIntoView({behavior:'smooth',block:'center'});
    },50);
  }
}

function handleCanvasClick(clientX,clientY){
  // 在加点或连线编辑模式下禁用自动滚动高亮
  if(pointPlacementMode||linePlacementMode)return;
  const rect=canvas.getBoundingClientRect();
  const px=clientX-rect.left,py=clientY-rect.top;
  const m=screenToMath(px,py);
  const p=ppu();
  const clickRadiusPx=12;

  let bestPointId=null;
  for(let i=items.length-1;i>=0;i--){
    const it=items[i];
    if(it.type!=='point'||it.hidden)continue;
    const ps=mathToScreen(it.x,it.y);
    const dist=Math.hypot(ps.sx-px,ps.sy-py);
    if(dist<clickRadiusPx){bestPointId=it.id;break;}
  }

  if(bestPointId!==null){
    selectItem(bestPointId,{noAnim:true});
    scrollToAndCenterItem(bestPointId);
    return;
  }

  let bestFuncId=null,bestFuncDist=Infinity;
  for(const it of items){
    if(it.type!=='function'||it.hidden)continue;
    const c=cacheIdMap.get(it.id);
    if(!c||c.type==='skip'||c.type==='error')continue;
    if(c.type==='explicit'){
      for(const seg of c.segments){
        for(let i=0;i<seg.length;i++){
          const ps=mathToScreen(seg[i][0],seg[i][1]);
          const dist=Math.hypot(ps.sx-px,ps.sy-py);
          if(dist<clickRadiusPx&&dist<bestFuncDist){bestFuncDist=dist;bestFuncId=it.id;}
        }
      }
    }else if(c.type==='implicit'){
      for(const chain of c.segments){
        for(let i=0;i<chain.length;i+=2){
          const ps=mathToScreen(chain[i],chain[i+1]);
          const dist=Math.hypot(ps.sx-px,ps.sy-py);
          if(dist<clickRadiusPx&&dist<bestFuncDist){bestFuncDist=dist;bestFuncId=it.id;}
        }
      }
    }
  }

  if(bestFuncId!==null){selectItem(bestFuncId,{noAnim:true});scrollToAndCenterItem(bestFuncId);}
  else{
    // 检查是否点击了线段/连线
    let bestSegId=null,bestSegDist=Infinity;
    for(const it of items){
      if(it.type!=='segment'&&it.type!=='line'&&it.type!=='ray')continue;
      if(it.hidden||!it.pointA||!it.pointB)continue;
      const psA=mathToScreen(it.pointA.x,it.pointA.y);
      const psB=mathToScreen(it.pointB.x,it.pointB.y);
      // 计算点到线段的距离
      const dist=pointToSegmentDistance(px,py,psA.sx,psA.sy,psB.sx,psB.sy);
      if(dist<clickRadiusPx&&dist<bestSegDist){bestSegDist=dist;bestSegId=it.id;}
    }
    if(bestSegId!==null){selectItem(bestSegId,{noAnim:true});scrollToAndCenterItem(bestSegId);}
  }
}
function pointToSegmentDistance(px,py,x1,y1,x2,y2){
  const A=px-x1,B=py-y1,C=x2-x1,D=y2-y1;
  const dot=A*C+B*D,lenSq=C*C+D*D;
  let param=-1;
  if(lenSq!==0)param=dot/lenSq;
  let xx,yy;
  if(param<0){xx=x1;yy=y1;}
  else if(param>1){xx=x2;yy=y2;}
  else{xx=x1+param*C;yy=y1+param*D;}
  const dx=px-xx,dy=py-yy;
  return Math.sqrt(dx*dx+dy*dy);
}
function scrollToAndCenterItem(id){
  const card=itemListContainer.querySelector('[data-id="'+id+'"]');
  if(card){
    const container=itemListContainer;
    const cardTop=card.offsetTop;
    const cardHeight=card.offsetHeight;
    const containerHeight=container.clientHeight;
    const scrollTop=container.scrollTop;
    const cardCenter=cardTop-cardHeight/2;
    if(cardCenter<scrollTop||cardCenter>scrollTop+containerHeight){
      container.scrollTo({top:cardCenter-containerHeight/2,behavior:'smooth'});
    }
  }
}

function addFuncItem(){
  const color=nextColor(['#6366f1','#22c55e','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#f97316']);
  const item={id:nextItemId('function'),type:'function',expr:'',color,hidden:false};
  items.push(item);
  selectItem(item.id);
  renderItemCards();
  updateItemCount();
  fullRender();
}

let genericConfirmCb=null;
function showGenericConfirm(title,msg,cb){
  document.getElementById('genericConfirmTitle').textContent=title;
  document.getElementById('genericConfirmMsg').innerHTML=msg;
  genericConfirmCb=cb;
  document.getElementById('genericConfirmOverlay').classList.add('visible');
}
function genericConfirmResult(ok){
  document.getElementById('genericConfirmOverlay').classList.remove('visible');
  if(genericConfirmCb){const cb=genericConfirmCb;genericConfirmCb=null;cb(ok);}
}

function removeItem(id){
  const deleted=items.find(it=>it.id===id);
  if(!deleted)return;
  // ---- 新增：若删除的是坐标点，检查是否有连线依赖 ----
  if (deleted.type === 'point') {
    const dependentSegments = items.filter(it =>
      (it.type === 'segment' || it.type === 'line' || it.type === 'ray') &&
      ( (it.pointA && it.pointA.id === deleted.id) || (it.pointB && it.pointB.id === deleted.id) )
    );
    if (dependentSegments.length > 0) {
      const segNames = dependentSegments.map(s => s.label || s.id).join('、');
      showGenericConfirm(
        '删除坐标点',
        `该点被 ${dependentSegments.length} 个连线项（${segNames}）引用，删除后将同时删除这些连线。<br>确认删除？`,
        (ok) => {
          if (ok) {
            // 删除所有依赖的连线
            const ids = new Set(dependentSegments.map(s => s.id));
            items = items.filter(it => !ids.has(it.id));
            // 然后删除该点
            items = items.filter(it => it.id !== deleted.id);
            // 清理选中
            if (selectedItemId === deleted.id || ids.has(selectedItemId)) selectedItemId = null;
            // 更新界面
            renderItemCards();
            updateItemCount();
            fullRender();
          }
        }
      );
      return; // 不再执行后续删除逻辑
    }
    // 若无依赖，则继续往下执行普通的删除逻辑
  }

  if(deleted.type==='function'){
    const affectedPoints=items.filter(p=>p.type==='point'&&((p.xMode==='func'&&p.xFuncId===deleted.id)||(p.yMode==='func'&&p.yFuncId===deleted.id)));
    if(affectedPoints.length>0){
      showGenericConfirm('删除函数','函数 <b>'+deleted.id+'</b> 正被 '+affectedPoints.length+' 个坐标点绑定（函数模式）。<br>删除后，这些坐标点将自动重置为固定模式。<br><br>确认删除？',(ok)=>{
        if(ok)performRemove(deleted,affectedPoints,[]);
      });
      return;
    }
    performRemove(deleted,[],[]);
    return;
  }

  if(deleted.type==='param'){
    const affectedFuncs=[];
    for(const f of items){
      if(f.type==='function'&&detectParams(f.expr).includes(deleted.name))affectedFuncs.push(f);
    }
    const affectedPoints=items.filter(p=>p.type==='point'&&(
      (p.xMode==='param'&&detectParams(p.xParamExpr||'').includes(deleted.name))||
      (p.yMode==='param'&&detectParams(p.yParamExpr||'').includes(deleted.name))));
    if(affectedFuncs.length||affectedPoints.length){
      alert('参数 '+deleted.name+' 已被删除，影响 '+affectedFuncs.length+' 个函数、'+affectedPoints.length+' 个坐标点。');
    }
    performRemove(deleted,affectedPoints,affectedFuncs);
    return;
  }
  performRemove(deleted,[],[]);
}

function performRemove(deleted,affectedPoints,affectedFuncs){
  items=items.filter(it=>it.id!==deleted.id);
  if(paramAnims.has(deleted.id))stopParamAnim(deleted.id);
  if(selectedItemId===deleted.id)selectedItemId=null;
  if(deleted.type==='param'){
    for(const f of affectedFuncs)f.errorMsg='引用的参数 '+deleted.name+' 已被删除';
  }else if(deleted.type==='function'){
    for(const p of affectedPoints){
      p.errorMsg='绑定的函数已被删除';
      if(p.xMode==='func'&&p.xFuncId===deleted.id){p.xMode='fixed';p.xFuncId=null;}
      if(p.yMode==='func'&&p.yFuncId===deleted.id){p.yMode='fixed';p.yFuncId=null;}
    }
  }
  renderItemCards();
  updateItemCount();
  if(deleted.type==='param'){
    // Refresh param buttons on all expanded function cards
    const selectedFunc=items.find(it=>it.type==='function'&&it.id===selectedItemId);
    if(selectedFunc){
      const card=itemListContainer.querySelector('[data-id="'+selectedItemId+'"]');
      if(card){
        const pb=card.querySelector('[data-params]');
        if(pb)updateParamButtons(selectedFunc,pb);
      }
    }
  }
  fullRender();
}

function fullRender(){
  resolveAllPoints();drawGridTo(ctx);drawCurvesTo(ctx);drawPointsTo(ctx);dirty=true;requestCompute();
}

function forceResetRender(){
  if(workerTimeoutTimer){clearTimeout(workerTimeoutTimer);workerTimeoutTimer=null;}
  if(worker&&worker.terminate){try{worker.terminate();}catch(e){}}
  workerBusy=false;dirty=true;
  taskSeq++;pendingTaskSeq=taskSeq;
  cacheIdMap.clear();
  offscreenCache.clear();
  pendingHashes.clear();
  autoCentered=false;
  document.getElementById('loadingToast').classList.remove('visible');
  calcStatus.textContent='已重置';
  initWorker();
  renderFull();
}

function updateItemCount(){itemCount.textContent='('+items.length+')';}

// ==================== 面板 & 设置 ====================
function togglePanel(){
  panelCollapsed=!panelCollapsed;
  leftPanel.classList.toggle('collapsed',panelCollapsed);
  togglePanelBtn.innerHTML=panelCollapsed?'&#9654;':'&#9664;';
  setTimeout(resizeCanvas,350);
}

function aiAction() {
  alert('AI 功能开发中，敬请期待！');
  // 此处可预留接口，例如调用后端 API
}

function toggleSection(titleEl){
  const body=titleEl.nextElementSibling;
  body.classList.toggle('open');
  const arrow=titleEl.querySelector('span:last-child');
  arrow.textContent=body.classList.contains('open')?'\u25bc':'\u25b6';
}

function findUnitLengthIndex(val){
  for(let i=0;i<unitLengthOptions.length;i++){if(unitLengthOptions[i]>=val)return i;}
  return unitLengthOptions.length-1;
}

function changeGridUnit(dir){
  if(ulAnimating)return;
  let idx=findUnitLengthIndex(view.gridUnitLength);
  idx=Math.max(0,Math.min(unitLengthOptions.length-1,idx+dir));
  if(unitLengthOptions[idx]===view.gridUnitLength){idx=Math.max(0,Math.min(unitLengthOptions.length-1,idx+dir));}const ulEl=document.getElementById('unitLengthVal');if(ulEl)ulEl.textContent=unitLengthOptions[idx];const ulInp=document.getElementById('unitLengthInput');if(ulInp)ulInp.value=unitLengthOptions[idx];
  const newUL=unitLengthOptions[idx];
  if(newUL===view.gridUnitLength)return;
  updateDisplayValues();
  startULAnim(newUL);
}

function changePixelSize(dir){
  if(ulAnimating)return;
  const cur=view.gridPixelSize;
  let step;
  if(cur<0.5)step=0.05;else if(cur<1)step=0.1;else if(cur<3)step=0.25;else step=0.5;
  view.gridPixelSize=parseFloat(Math.max(PIXEL_SIZE_MIN,Math.min(PIXEL_SIZE_MAX,cur+dir*step)).toFixed(2));
  updateDisplayValues();
  pixelSizeVal.textContent=Number.isInteger(view.gridPixelSize)?view.gridPixelSize.toString():view.gridPixelSize.toFixed(2);const psEl=document.getElementById('pixelSizeVal');if(psEl)psEl.textContent=Number.isInteger(view.gridPixelSize)?view.gridPixelSize.toString():view.gridPixelSize.toFixed(2);const psInp=document.getElementById('pixelSizeInput');if(psInp)psInp.value=pixelSizeVal.textContent;
  fullRender();
}

function changeMinorGridSteps(delta){
  const newSteps=view.minorGridSteps+delta;
  if(newSteps<2||newSteps>10)return;
  view.minorGridSteps=newSteps;
  updateDisplayValues();
  const mgsEl=document.getElementById('minorGridStepsVal');if(mgsEl)mgsEl.textContent=view.minorGridSteps;const mgsInp=document.getElementById('minorGridStepsInput');if(mgsInp)mgsInp.value=view.minorGridSteps;
  fullRender();
}

function setGridUnit(val){
  let v=parseFloat(val);
  if(isNaN(v))return;
  v=Math.max(0.0001,Math.min(5000,v));
  if(v>20){v=Math.round(v/5)*5;}
  view.gridUnitLength=v;
  const ulEl=document.getElementById('unitLengthVal');if(ulEl)ulEl.textContent=v.toFixed(2);
  updateDisplayValues();
  fullRender();
}
function setPixelSize(val){
  let v=parseFloat(val);
  if(isNaN(v))return;
  view.gridPixelSize=parseFloat(Math.max(0.1,Math.min(50,v)).toFixed(2));
  updateDisplayValues();
  fullRender();
}
function setMinorGridSteps(val){
  let v=parseInt(val);
  if(isNaN(v))return;
  v=Math.max(2,Math.min(10,v));
  view.minorGridSteps=v;
  updateDisplayValues();
  fullRender();
}
function setPointSize(val){
  let v=parseFloat(val);
  if(isNaN(v))return;
  view.pointSize=parseFloat(Math.max(1,Math.min(20,v)).toFixed(1));
  fullRender();
}
function changePointSize(delta){
  let newSz=view.pointSize+delta;
  newSz=Math.max(1,Math.min(20,newSz));
  view.pointSize=parseFloat(newSz.toFixed(1));
  const psInp=document.getElementById('pointSizeInput');if(psInp)psInp.value=view.pointSize;
  fullRender();
}
function changeRenderPrecision(delta){
  let newPrec=view.renderPrecision+delta*0.001;
  newPrec=Math.max(0.001,Math.min(0.1,newPrec));
  view.renderPrecision=parseFloat(newPrec.toFixed(3));
  const rpInp=document.getElementById('renderPrecisionInput');if(rpInp)rpInp.value=view.renderPrecision.toFixed(3);
  fullRender();
}
function setRenderPrecision(val){
  let v=parseFloat(val);
  if(isNaN(v))return;
  view.renderPrecision=parseFloat(Math.max(0.001,Math.min(0.1,v)).toFixed(3));
  fullRender();
}
function changeDecimalPlaces(delta){
  let newDp=view.decimalPlaces+delta;
  newDp=Math.max(0,Math.min(13,newDp));
  view.decimalPlaces=newDp;
  const dpInp=document.getElementById('decimalPlacesInput');if(dpInp)dpInp.value=view.decimalPlaces;
  updateCoordDisplay();
}
function setDecimalPlaces(val){
  let v=parseInt(val);
  if(isNaN(v))return;
  view.decimalPlaces=Math.max(0,Math.min(13,v));
  updateCoordDisplay();
}
function changeComputeInterval(delta) {
  let newVal = computeInterval + delta;
  newVal = Math.max(50, Math.min(500, newVal));
  computeInterval = newVal;
  document.getElementById('computeIntervalVal').textContent = computeInterval;
}


function updateDisplayValues(){
  unitLengthVal.textContent=view.gridUnitLength;
  const ulEl=document.getElementById('unitLengthVal');if(ulEl)ulEl.textContent=view.gridUnitLength;
  const ulInp=document.getElementById('unitLengthInput');if(ulInp)ulInp.value=view.gridUnitLength>20?(Math.round(view.gridUnitLength/5)*5).toFixed(0):view.gridUnitLength.toFixed(4);
  const ps=view.gridPixelSize;
  pixelSizeVal.textContent=Number.isInteger(ps)?ps.toString():ps.toFixed(2);
  const psEl=document.getElementById('pixelSizeVal');if(psEl)psEl.textContent=pixelSizeVal.textContent;
  const minorGridStepsValEl=document.getElementById('minorGridStepsVal');
  if(minorGridStepsValEl)minorGridStepsValEl.textContent=view.minorGridSteps;
  const minorGridValEl=document.getElementById('minorGridVal');
  if(minorGridValEl)minorGridValEl.textContent=smallUnit().toFixed(1);
  const majorGridValEl=document.getElementById('majorGridVal');
  if(majorGridValEl)majorGridValEl.textContent=view.gridUnitLength;
  const psInp=document.getElementById('pointSizeInput');if(psInp)psInp.value=view.pointSize;
  const rpInp=document.getElementById('renderPrecisionInput');if(rpInp)rpInp.value=view.renderPrecision.toFixed(3);
  const dpInp=document.getElementById('decimalPlacesInput');if(dpInp)dpInp.value=view.decimalPlaces;
}

function resetView(){
  if(ulAnimating)return;
  view.gridUnitLength=5;view.gridPixelSize=3;
  updateDisplayValues();
  startAnim(canvasW/2,canvasH/2,3);
}

function centerOrigin(){
  if(ulAnimating||animating||pointPlacementMode)return;   // 动画/加点模式中拒绝
  startAnim(canvasW/2,canvasH/2,view.gridPixelSize);      // 保持比例, 平移到原点
}

function centerViewAtOrigin(){
  if(ulAnimating||animating||pointPlacementMode)return;
  startAnim(canvasW/2,canvasH/2,view.gridPixelSize);
}

function fitAll(){
  if(ulAnimating||animating)return;
  resetView();
}

showGrid.addEventListener('change',()=>{fullRender();});
showMinorGridI.addEventListener('change',()=>{fullRender();});
ptStyleSelect.addEventListener('change',()=>{fullRender();});

function getDecimalPrecisionForDisplay(){
  const s=view.gridUnitLength.toString();
  const di=s.indexOf('.');
  return di>=0?s.length-di-1:0;
}

function updateCoordDisplay(){
  const dp=view.decimalPlaces;
  coordDisplay.textContent='x='+mouseMathX.toFixed(dp)+'  y='+mouseMathY.toFixed(dp);
  coordDisplay.classList.add('visible');
}
function safeToFixed(v, dp){
  return (typeof v==='number'&&isFinite(v))?v.toFixed(dp):'?';
}
function formatNumber(num){return safeToFixed(num,view.decimalPlaces);}

// ==================== 设置面板 ====================
function toggleSettings(){
  const panel=document.getElementById('settingsPanel');
  const overlay=document.getElementById('settingsOverlay');
  const btn=document.getElementById('settingsBtn');
  const visible=panel.classList.toggle('visible');
  overlay.classList.toggle('visible',visible);
  // 需求二：画布自动挤占设置面板宽度
  const wrap=document.getElementById('canvasWrap');
  if(wrap)wrap.classList.toggle('settings-open',visible);
  if(btn)btn.style.display=visible?'none':'';
}

// ==================== 设置面板宽度拖拽（需求二） ====================
const SETTINGS_W_KEY='ai_settings_panel_width';
function applySettingsWidth(w){
  document.body.style.setProperty('--settings-w',w+'px');
}
function initSettingsResize(){
  const handle=document.getElementById('settingsResizeHandle');
  const panel=document.getElementById('settingsPanel');
  const wrap=document.getElementById('canvasWrap');
  if(!handle||!panel)return;
  // 恢复上次宽度（240 ~ min(视口宽-48, 720) 边界）
  try{
    const saved=parseInt(localStorage.getItem(SETTINGS_W_KEY),10);
    if(saved>=240&&saved<=720)applySettingsWidth(saved);
  }catch(e){}
  let dragging=false,startX=0,startW=0;
  handle.addEventListener('mousedown',(e)=>{
    e.preventDefault();e.stopPropagation();
    dragging=true;startX=e.clientX;
    startW=panel.getBoundingClientRect().width;
    handle.classList.add('active');
    panel.classList.add('resizing');
    if(wrap)wrap.classList.add('settings-resizing');
    document.body.style.userSelect='none';
  });
  document.addEventListener('mousemove',(e)=>{
    if(!dragging)return;
    const vw=window.innerWidth;
    const minW=240,maxW=Math.max(minW,Math.min(720,vw-48));
    const w=Math.max(minW,Math.min(maxW,startW+(startX-e.clientX)));
    applySettingsWidth(w);
  });
  document.addEventListener('mouseup',()=>{
    if(!dragging)return;
    dragging=false;
    handle.classList.remove('active');
    panel.classList.remove('resizing');
    if(wrap)wrap.classList.remove('settings-resizing');
    document.body.style.userSelect='';
    try{localStorage.setItem(SETTINGS_W_KEY,String(Math.round(panel.getBoundingClientRect().width)));}catch(e){}
  });
}
document.addEventListener('DOMContentLoaded',initSettingsResize);
if(document.readyState!=='loading')initSettingsResize();
function toggleCanvasSettings(){
  const dropdown=document.getElementById('canvasSettingsDropdown');
  const btn=document.getElementById('settingsBtn');
  const visible=dropdown.classList.toggle('visible');
  if(btn)btn.classList.toggle('active',visible);
}

// 设置面板侧边分类导航
function switchSettingsNav(name){
  document.querySelectorAll('.settings-nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.snav===name));
  document.querySelectorAll('[data-snav-panel]').forEach(p=>{p.style.display=p.dataset.snavPanel===name?'':'none';});
}
document.addEventListener('click',(e)=>{
  const dropdown=document.getElementById('canvasSettingsDropdown');
  const btn=document.getElementById('settingsBtn');
  if(dropdown&&!dropdown.contains(e.target)&&!btn.contains(e.target)){
    dropdown.classList.remove('visible');
    if(btn)btn.classList.remove('active');
  }
});


function toggleAddDropdown(e){
  e.stopPropagation();
  document.getElementById('headerAddDropdown').classList.toggle('visible');
}
document.addEventListener('click',(e)=>{
  if(!e.target.closest('#headerAddBtn')&&!e.target.closest('#headerAddDropdown')){
    document.getElementById('headerAddDropdown').classList.remove('visible');
  }
});

// 设置面板事件
const tickFontSizeI=document.getElementById('tickFontSize');
const formulaFontSizeI=document.getElementById('formulaFontSize');
const majorGridColorI=document.getElementById('majorGridColor');
const majorGridAlphaI=document.getElementById('majorGridAlpha');
const majorGridAlphaVal=document.getElementById('majorGridAlphaVal');
const minorGridColorI=document.getElementById('minorGridColor');
const minorGridAlphaI=document.getElementById('minorGridAlpha');
const minorGridAlphaVal=document.getElementById('minorGridAlphaVal');
const hideXAxisI=document.getElementById('hideXAxis');
const hideYAxisI=document.getElementById('hideYAxis');

function hexToRgba(hex,alpha){
  const r=parseInt(hex.slice(1,3),16);
  const g=parseInt(hex.slice(3,5),16);
  const b=parseInt(hex.slice(5,7),16);
  return 'rgba('+r+','+g+','+b+','+(alpha/100)+')';
}

tickFontSizeI.addEventListener('input',()=>{fullRender();});
formulaFontSizeI.addEventListener('input',()=>{
  const sz=parseInt(formulaFontSizeI.value)||18;
  document.body.style.setProperty('--formula-font-size',sz+'px');
  fullRender();
});
majorGridColorI.addEventListener('input',()=>{fullRender();});
majorGridAlphaI.addEventListener('input',()=>{
  majorGridAlphaVal.textContent=majorGridAlphaI.value+'%';
  fullRender();
});
minorGridColorI.addEventListener('input',()=>{fullRender();});
minorGridAlphaI.addEventListener('input',()=>{
  minorGridAlphaVal.textContent=minorGridAlphaI.value+'%';
  fullRender();
});
hideXAxisI.addEventListener('change',()=>{fullRender();});
hideYAxisI.addEventListener('change',()=>{fullRender();});

// 设置面板侧边导航点击
document.querySelectorAll('.settings-nav-btn').forEach(btn=>{
  btn.addEventListener('click',()=>switchSettingsNav(btn.dataset.snav));
});

// 动画设置绑定
const animModeSelect=document.getElementById('animModeSelect');
const animSpeedSelect=document.getElementById('animSpeedSelect');
if(animModeSelect)animModeSelect.addEventListener('change',()=>{animSettings.mode=animModeSelect.value;});
if(animSpeedSelect)animSpeedSelect.addEventListener('change',()=>{animSettings.speed=parseFloat(animSpeedSelect.value)||1;});

// ==================== 批量模式 ====================
function toggleBatchMode(e){
  if(e)e.stopPropagation();
  batchMode=!batchMode;
  batchSelected.clear();
  const bti=document.getElementById('batchToggle');
  leftPanel.classList.toggle('batch-mode',batchMode);
  if(batchMode){
    if(vkVisible){vkVisible=false;virtualKeyboard.classList.remove('visible');vkToggle.classList.remove('active');}
    document.getElementById('batchToolbar').style.display='flex';
    if(bti)bti.classList.add('active');
  }else{
    document.getElementById('batchToolbar').style.display='none';
    if(bti)bti.classList.remove('active');
  }
  renderItemCards();
}

function toggleBatchItem(e,id){
  if(e)e.stopPropagation();
  if(batchSelected.has(id))batchSelected.delete(id);
  else batchSelected.add(id);
  const card=itemListContainer.querySelector('[data-id="'+id+'"]');
  if(card){card.classList.toggle('item-checked',batchSelected.has(id));const cb=card.querySelector('.batch-cb');if(cb)cb.checked=batchSelected.has(id);}
  updateBatchUI();
}

function selectAllItems(){
  batchSelected.clear();
  for(const it of items)batchSelected.add(it.id);
  renderItemCards();
}

function deselectAllItems(){
  batchSelected.clear();
  renderItemCards();
}

function updateBatchUI(){
  document.getElementById('batchCount').textContent=batchSelected.size;
  document.getElementById('batchDeleteBtn').disabled=batchSelected.size===0;
}

function confirmBatchDelete(){
  if(batchSelected.size===0)return;
  document.getElementById('confirmMsg').textContent='确定要删除已选的 '+batchSelected.size+' 个项目吗？此操作不可撤销。';
  document.getElementById('confirmOverlay').classList.add('visible');
}

function cancelBatchDelete(){
  document.getElementById('confirmOverlay').classList.remove('visible');
}

function executeBatchDelete(){
  const ids=[...batchSelected];
  items=items.filter(it=>!batchSelected.has(it.id));
  if(batchSelected.has(selectedItemId))selectedItemId=null;
  batchSelected.clear();
  batchMode=false;
  leftPanel.classList.remove('batch-mode');
  document.getElementById('batchToolbar').style.display='none';
  const btEl=document.getElementById('batchToggle');
  if(btEl)btEl.classList.remove('active');
  document.getElementById('confirmOverlay').classList.remove('visible');
  renderItemCards();
  updateItemCount();
  fullRender();
}

function exportProject(){
  // 需求：导出项目需登录
  if (window.UserAuth && !window.UserAuth.isLoggedIn()) {
    if (window.UserAuth && UserAuth.showToast) UserAuth.showToast('请先登录后再导出项目');
    if (window.UserAuth) UserAuth.requireLogin().then(function(ok){ if(ok) doExportProject(); });
    return;
  }
  doExportProject();
}
function doExportProject(){
  const settings={
    gridUnitLength:view.gridUnitLength,
    gridPixelSize:view.gridPixelSize,
    minorGridSteps:view.minorGridSteps,
    pointSize:view.pointSize,
    renderPrecision:view.renderPrecision,
    decimalPlaces:view.decimalPlaces,
    showMinorGrid:showMinorGridI.checked,
    hideXAxis:hideXAxisI.checked,
    hideYAxis:hideYAxisI.checked,
    showGrid:showGrid.checked,
    pointStyle:ptStyleSelect.value
  };
  const data={version:2,settings,items:JSON.parse(JSON.stringify(items)),idSeq};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='function-plotter-project.json';
  document.body.appendChild(a);a.click();
  document.body.removeChild(a);URL.revokeObjectURL(url);
}
// 需求：导入项目需登录（未登录先弹登录窗，登录成功后再打开文件选择器）
// 且当前项目有未保存改动时，先让用户保存当前文件，再打开文件选择器
function onImportClick(){
  const doOpen=function(){ document.getElementById('importFile').click(); };
  if (window.UserAuth && !window.UserAuth.isLoggedIn()) {
    if (window.UserAuth && UserAuth.showToast) UserAuth.showToast('请先登录后再导入项目');
    if (window.UserAuth) UserAuth.requireLogin().then(function(ok){ if(ok) saveBeforeAction(doOpen,'直接导入文件将丢失这些数据'); });
    return;
  }
  saveBeforeAction(doOpen,'直接导入文件将丢失这些数据');
}
function importProject(e){
  const file=e.target.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=(evt)=>{
    try{
      const data=JSON.parse(evt.target.result);
      if(!data.version||!data.items){throw new Error('无效的项目文件');}
      items=data.items;
      if(data.idSeq)idSeq=data.idSeq;
      else idSeq={function:0,point:0,segment:0,line:0,ray:0,param:0};
      itemColorSeq=0;
      // 迁移旧版纯数字 ID -> 前缀字符串 ID
      const idMap={};
      for(const it of items){
        if(typeof it.id==='number'){
          const newId=nextItemId(it.type);
          idMap[it.id]=newId;
          it.id=newId;
        }
      }
      for(const it of items){
        if(it.type==='point'){
          if(it.xParamId!=null&&idMap[it.xParamId])it.xParamId=idMap[it.xParamId];
          if(it.yParamId!=null&&idMap[it.yParamId])it.yParamId=idMap[it.yParamId];
          if(it.xFuncId!=null&&idMap[it.xFuncId])it.xFuncId=idMap[it.xFuncId];
          if(it.yFuncId!=null&&idMap[it.yFuncId])it.yFuncId=idMap[it.yFuncId];
        }
        if((it.type==='segment'||it.type==='line'||it.type==='ray')&&it.pointAId!=null&&idMap[it.pointAId])it.pointAId=idMap[it.pointAId];
        if((it.type==='segment'||it.type==='line'||it.type==='ray')&&it.pointBId!=null&&idMap[it.pointBId])it.pointBId=idMap[it.pointBId];
      }
      // 迁移旧版参数引用（xParamId/yParamId）为参数表达式，X 函数绑定回退为固定
      for(const it of items){
        if(it.type!=='point')continue;
        if(it.xMode==='param'){
          if(it.xParamExpr==null&&it.xParamId){
            const p=items.find(i=>i.id===it.xParamId&&i.type==='param');
            if(p)it.xParamExpr=p.name;
            else{it.xMode='fixed';it.xParamId=null;}
          }
        }else if(it.xMode==='func'){
          it.xMode='fixed';it.xFuncId=null;
        }
        if(it.yMode==='param'){
          if(it.yParamExpr==null&&it.yParamId){
            const p=items.find(i=>i.id===it.yParamId&&i.type==='param');
            if(p)it.yParamExpr=p.name;
            else{it.yMode='fixed';it.yParamId=null;}
          }
        }
        it.xErr=null;it.yErr=null;
      }
      // 同步计数器，确保新 ID 不与已导入的 ID 冲突
      for(const it of items){
        if(typeof it.id==='string'){
          const m=/^([a-z0-9]+)_(\d+)$/.exec(it.id);
          if(m){
            const keyMap={fx:'function',xy:'point',line:'segment',line2:'line',line3:'ray',pa:'param'};
            const t=keyMap[m[1]];
            if(t)idSeq[t]=Math.max(idSeq[t]||0,parseInt(m[2],10));
          }
        }
      }
      if(data.settings){
        if(data.settings.gridUnitLength)view.gridUnitLength=data.settings.gridUnitLength;
        if(data.settings.gridPixelSize)view.gridPixelSize=data.settings.gridPixelSize;
        if(data.settings.minorGridSteps)view.minorGridSteps=data.settings.minorGridSteps;
        if(data.settings.pointSize)view.pointSize=data.settings.pointSize;
        if(data.settings.renderPrecision)view.renderPrecision=data.settings.renderPrecision;
        if(data.settings.decimalPlaces)view.decimalPlaces=data.settings.decimalPlaces;
        if(data.settings.showMinorGrid!==undefined){showMinorGridI.checked=data.settings.showMinorGrid;document.getElementById('showMinorGrid').checked=data.settings.showMinorGrid;}
        if(data.settings.hideXAxis!==undefined){hideXAxisI.checked=data.settings.hideXAxis;document.getElementById('hideXAxis').checked=data.settings.hideXAxis;}
        if(data.settings.hideYAxis!==undefined){hideYAxisI.checked=data.settings.hideYAxis;document.getElementById('hideYAxis').checked=data.settings.hideYAxis;}
        if(data.settings.showGrid!==undefined){showGrid.checked=data.settings.showGrid;document.getElementById('showGrid').checked=data.settings.showGrid;}
        if(data.settings.pointStyle){ptStyleSelect.value=data.settings.pointStyle;}
        updateDisplayValues();
      }
      selectedItemId=null;
      batchMode=false;batchSelected.clear();
      leftPanel.classList.remove('batch-mode');
      document.getElementById('batchToolbar').style.display='none';
      const btEl=document.getElementById('batchToggle');
      if(btEl)btEl.classList.remove('active');
      cacheIdMap.clear();
      offscreenCache.clear();
      pendingHashes.clear();
      autoCentered=false;
      for(const id of [...paramAnims.keys()])stopParamAnim(id);
      // ---- 绑定连线项的点引用 ----
      for (const it of items) {
        if (it.type === 'segment' || it.type === 'line' || it.type === 'ray') {
          // 根据 pointAId 查找点对象
          if (it.pointAId) {
            const p = items.find(i => i.id === it.pointAId && i.type === 'point');
            it.pointA = p || null;
          } else {
            it.pointA = null;
          }
          // 根据 pointBId 查找点对象
          if (it.pointBId) {
            const p = items.find(i => i.id === it.pointBId && i.type === 'point');
            it.pointB = p || null;
          } else {
            it.pointB = null;
          }
          // 若两个点都存在，预计算中点、长度（渲染时会重新计算，但先填充默认值）
          if (it.pointA && it.pointB) {
            it.midX = (it.pointA.x + it.pointB.x) / 2;
            it.midY = (it.pointA.y + it.pointB.y) / 2;
            it.length = Math.hypot(it.pointB.x - it.pointA.x, it.pointB.y - it.pointA.y);
          } else {
            // 若点缺失，保留旧值或置零，避免渲染报错
            it.midX = it.midX || 0;
            it.midY = it.midY || 0;
            it.length = it.length || 0;
          }
        }
      }
      // 确保所有连线项更新一次函数
      updateSegmentLineItems();

      // 然后更新界面
      renderItemCards();
      updateItemCount();
      fullRender();
      if(items.length>0){selectItem(items[0].id);renderItemCards();}
      e.target.value='';
    }catch(err){
      alert('导入失败：'+err.message);
      e.target.value='';
    }
  };
  reader.readAsText(file);
}

// ==================== 云端项目与更多菜单 ====================
// 未保存检测：对比当前项目数据与上次保存/加载/重置的快照（不含视图平移 ox/oy）
let lastSavedKey = '';
function getProjectDataPayload() {
  const settings = {
    gridUnitLength: view.gridUnitLength, gridPixelSize: view.gridPixelSize,
    minorGridSteps: view.minorGridSteps, pointSize: view.pointSize,
    renderPrecision: view.renderPrecision, decimalPlaces: view.decimalPlaces,
    showMinorGrid: showMinorGridI.checked, hideXAxis: hideXAxisI.checked,
    hideYAxis: hideYAxisI.checked, showGrid: showGrid.checked,
    pointStyle: ptStyleSelect.value
  };
  return { version: 2, settings, items, idSeq };
}
function currentProjectKey() {
  return JSON.stringify(getProjectDataPayload());
}
function isProjectDirty() { return currentProjectKey() !== lastSavedKey; }
function markSaved() { lastSavedKey = currentProjectKey(); }
let cloudProjectId = ''; // 当前项目唯一 ID（无则下次保存时自动生成）
lastSavedKey = currentProjectKey();

// ---- 更多菜单 ----
let appMenuOpen = false;
function toggleAppMenu() { if (appMenuOpen) closeAppMenu(); else openAppMenu(); }
function openAppMenu() {
  appMenuOpen = true;
  const menu = document.getElementById('appMenu');
  const back = document.getElementById('menuBackdrop');
  if (menu) menu.classList.add('visible');
  if (back) back.classList.add('visible');
  updateMenuAuthItem();
}
function closeAppMenu() {
  appMenuOpen = false;
  const menu = document.getElementById('appMenu');
  const back = document.getElementById('menuBackdrop');
  if (menu) menu.classList.remove('visible');
  if (back) back.classList.remove('visible');
}
function updateMenuAuthItem() {
  const el = document.getElementById('appMenuAuthItem');
  if (!el) return;
  el.textContent = (window.UserAuth && UserAuth.isLoggedIn()) ? '登出' : '登录 / 注册';
}
function menuImportLocal() { closeAppMenu(); onImportClick(); }
function menuExportLocal() { closeAppMenu(); exportProject(); }
function menuSettings() { closeAppMenu(); openSettings(); }
function openSettings() {
  const panel = document.getElementById('settingsPanel');
  if (panel && !panel.classList.contains('visible') && typeof toggleSettings === 'function') toggleSettings();
}
function menuAuthAction() {
  closeAppMenu();
  if (!window.UserAuth) return;
  if (UserAuth.isLoggedIn()) UserAuth.logout();
  else UserAuth.openLoginModal();
}
function menuSaveCloud() {
  closeAppMenu();
  if (!window.UserAuth) return;
  if (!UserAuth.isLoggedIn()) { UserAuth.showToast('请先登录后再保存到云端'); UserAuth.requireLogin().then(function (ok) { if (ok) openSaveCloudModal(null); }); return; }
  openSaveCloudModal(null);
}
function menuOpenCloud() {
  closeAppMenu();
  if (!window.UserAuth) return;
  if (!UserAuth.isLoggedIn()) { UserAuth.showToast('请先登录后再打开云端文件'); UserAuth.requireLogin().then(function (ok) { if (ok) saveBeforeAction(openCloudModal,'直接打开云端文件将丢失这些数据'); }); return; }
  saveBeforeAction(openCloudModal,'直接打开云端文件将丢失这些数据');
}
function menuNewProject() {
  closeAppMenu();
  const doAction = function () {
    resetProjectData();
    cloudProjectId = '';
    if (window.UserAuth && UserAuth.showToast) UserAuth.showToast('创建新项目成功');
  };
  const afterLogin = function () { saveBeforeAction(doAction, '直接创建新项目将丢失这些数据'); };
  if (isProjectDirty() && window.UserAuth && !UserAuth.isLoggedIn()) {
    UserAuth.showToast('请先登录后再保存当前项目');
    UserAuth.requireLogin().then(function (ok) { if (ok) afterLogin(); });
    return;
  }
  afterLogin();
}

// 统一的「操作前先保存」流程：
// 当前项目有未保存改动时，先弹出保存框；点「保存」保存后执行 actionFn；
// 点「取消」则弹出数据丢失警告，选择「我不想保存」直接执行，选择「取消」返回保存框。
// 当前项目无未保存改动时直接执行 actionFn。
function saveBeforeAction(actionFn, proceedText) {
  const run = function () { actionFn(); };
  if (!isProjectDirty()) { run(); return; }
  const openWarn = function () {
    showConfirm('未保存的改动', '当前项目存在未保存的改动，' + (proceedText || '直接继续将丢失这些数据') + '。确定不保存并继续吗？', '我不想保存', run, function () {
      openSaveCloudModal({ onSaved: run, onCancel: openWarn });
    });
  };
  openSaveCloudModal({ onSaved: run, onCancel: openWarn });
}

// ---- 保存到云端弹窗 ----
let saveCloudExtra = null;
function openSaveCloudModal(extra) {
  const overlay = document.getElementById('saveCloudOverlay');
  const idEl = document.getElementById('saveCloudId');
  const nameEl = document.getElementById('saveCloudName');
  const msgEl = document.getElementById('saveCloudMsg');
  if (!overlay) return;
  saveCloudExtra = extra || null;
  if (msgEl) msgEl.style.display = 'none';
  if (nameEl) { nameEl.classList.remove('error'); nameEl.value = '未命名'; }
  // 无唯一 ID 则自动生成
  if (!cloudProjectId) cloudProjectId = (window.UserAuth && UserAuth.genProjectId) ? UserAuth.genProjectId() : ('prj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  if (idEl) idEl.textContent = cloudProjectId;
  overlay.classList.add('visible');
  if (nameEl) setTimeout(function () { nameEl.focus(); nameEl.select(); }, 60);
}
function closeSaveCloudModal() { document.getElementById('saveCloudOverlay').classList.remove('visible'); }
function doSaveCloud() {
  const btn = document.getElementById('saveCloudConfirmBtn');
  const msgEl = document.getElementById('saveCloudMsg');
  const nameEl = document.getElementById('saveCloudName');
  const name = (nameEl.value || '').trim();
  if (!name) {
    if (msgEl) { msgEl.style.display = 'block'; msgEl.style.color = '#dc2626'; msgEl.textContent = '项目名称不能为空'; }
    if (nameEl) nameEl.classList.add('error');
    return;
  }
  btn.disabled = true; btn.textContent = '保存中...';
  (async function () {
    try {
      const payload = getProjectDataPayload();
      payload._id = cloudProjectId;
      const data = await UserAuth.writeCloudProject(name, payload);
      cloudProjectId = data._id;
      markSaved();
      closeSaveCloudModal();
      if (UserAuth.showToast) UserAuth.showToast('已保存到云端：' + data.name);
      if (saveCloudExtra && saveCloudExtra.onSaved) saveCloudExtra.onSaved(data);
    } catch (e) {
      if (msgEl) { msgEl.style.display = 'block'; msgEl.style.color = '#dc2626'; msgEl.textContent = e.message || '保存失败'; }
      if (nameEl && /同名/.test(e.message || '')) nameEl.classList.add('error');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  })();
}
function initSaveCloudModal() {
  document.getElementById('saveCloudConfirmBtn').addEventListener('click', doSaveCloud);
  document.getElementById('saveCloudName').addEventListener('input', function () { this.classList.remove('error'); document.getElementById('saveCloudMsg').style.display = 'none'; });
  document.getElementById('saveCloudCancelBtn').addEventListener('click', function () {
    closeSaveCloudModal();
    if (saveCloudExtra && saveCloudExtra.onCancel) saveCloudExtra.onCancel();
  });
  document.getElementById('saveCloudOverlay').addEventListener('click', function (e) {
    if (e.target === document.getElementById('saveCloudOverlay')) {
      closeSaveCloudModal();
      if (saveCloudExtra && saveCloudExtra.onCancel) saveCloudExtra.onCancel();
    }
  });
  document.getElementById('saveCloudName').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSaveCloud(); } });
}

// ---- 打开云端文件弹窗 ----
function openCloudModal() {
  const overlay = document.getElementById('openCloudOverlay');
  const msgEl = document.getElementById('openCloudMsg');
  if (msgEl) msgEl.style.display = 'none';
  const inp = document.getElementById('openCloudIdInput');
  if (inp) inp.value = '';
  overlay.classList.add('visible');
  loadCloudList();
}
function showOpenCloudError(text) {
  const msgEl = document.getElementById('openCloudMsg');
  if (msgEl) { msgEl.style.display = 'block'; msgEl.style.color = '#dc2626'; msgEl.textContent = text; }
}
async function loadCloudList() {
  const listEl = document.getElementById('openCloudList');
  listEl.innerHTML = '正在读取云端项目...';
  try {
    const list = await UserAuth.listCloudProjects();
    if (!list.length) { listEl.innerHTML = '<div class="cloud-empty">暂无云端项目，请先在菜单中「保存到云端」</div>'; return; }
    listEl.innerHTML = '<div class="cloud-list-title">我的云端项目</div>' + list.map(function (p) {
      return '<button class="cloud-item" data-id="' + escapeHtml(p.id) + '">' +
        '<span class="cloud-item-name">' + escapeHtml(p.name) + '</span>' +
        '<span class="cloud-item-id">' + escapeHtml(p.id) + '</span>' +
        '<span class="cloud-item-time">' + (UserAuth.formatTime ? UserAuth.formatTime(p.savedAt) : '') + '</span>' +
        '</button>';
    }).join('');
    listEl.querySelectorAll('.cloud-item').forEach(function (el) {
      el.addEventListener('click', function () { openCloudById(this.dataset.id); });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="cloud-empty">读取云端项目失败：' + escapeHtml(e.message) + '</div>';
  }
}
function openCloudById(id) {
  if (!id) return;
  (async function () {
    try {
      const r = await UserAuth.readCloudProject(id);
      applyProjectData(r.project);
      cloudProjectId = r.id;
      markSaved();
      document.getElementById('openCloudOverlay').classList.remove('visible');
      if (UserAuth.showToast) UserAuth.showToast('已打开云端项目：' + r.name);
    } catch (e) { showOpenCloudError(e.message || '打开失败'); }
  })();
}
function initOpenCloudModal() {
  document.getElementById('openCloudIdBtn').addEventListener('click', function () {
    const v = document.getElementById('openCloudIdInput').value.trim();
    if (!v) { showOpenCloudError('请输入项目唯一 ID'); return; }
    openCloudById(v);
  });
  document.getElementById('openCloudIdInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('openCloudIdBtn').click(); } });
  document.getElementById('openCloudCancelBtn').addEventListener('click', function () {
    document.getElementById('openCloudOverlay').classList.remove('visible');
  });
  document.getElementById('openCloudOverlay').addEventListener('click', function (e) {
    if (e.target === document.getElementById('openCloudOverlay')) document.getElementById('openCloudOverlay').classList.remove('visible');
  });
}

// ---- 通用确认弹窗 ----
let confirmCloudCb = null;
function showConfirm(title, text, okLabel, okCb, cancelCb) {
  confirmCloudCb = { ok: okCb, cancel: cancelCb };
  document.getElementById('confirmCloudTitle').textContent = title || '确认';
  document.getElementById('confirmCloudText').innerHTML = String(text || '').replace(/\n/g, '<br>');
  const okBtn = document.getElementById('confirmCloudOkBtn');
  okBtn.textContent = okLabel || '确定';
  document.getElementById('confirmCloudMsg').style.display = 'none';
  document.getElementById('confirmCloudOverlay').classList.add('visible');
}
function closeConfirm() {
  confirmCloudCb = null;
  document.getElementById('confirmCloudOverlay').classList.remove('visible');
}
function initConfirmModal() {
  document.getElementById('confirmCloudOkBtn').addEventListener('click', function () {
    const cb = confirmCloudCb;
    closeConfirm();
    if (cb && cb.ok) cb.ok();
  });
  document.getElementById('confirmCloudCancelBtn').addEventListener('click', function () {
    const cb = confirmCloudCb;
    closeConfirm();
    if (cb && cb.cancel) cb.cancel();
  });
  document.getElementById('confirmCloudOverlay').addEventListener('click', function (e) {
    if (e.target === document.getElementById('confirmCloudOverlay')) {
      const cb = confirmCloudCb;
      closeConfirm();
      if (cb && cb.cancel) cb.cancel();
    }
  });
}

// ---- 应用云端/导入的项目数据（无旧版迁移，云端项目为当前版本） ----
function applyProjectData(data) {
  if (!data || !data.items) throw new Error('无效的项目数据');
  items = JSON.parse(JSON.stringify(data.items));
  if (data.idSeq) idSeq = JSON.parse(JSON.stringify(data.idSeq));
  else idSeq = { function: 0, point: 0, segment: 0, line: 0, ray: 0, param: 0 };
  itemColorSeq = 0;
  if (data.settings) {
    const s = data.settings;
    if (s.gridUnitLength) view.gridUnitLength = s.gridUnitLength;
    if (s.gridPixelSize) view.gridPixelSize = s.gridPixelSize;
    if (s.minorGridSteps) view.minorGridSteps = s.minorGridSteps;
    if (s.pointSize) view.pointSize = s.pointSize;
    if (s.renderPrecision) view.renderPrecision = s.renderPrecision;
    if (s.decimalPlaces) view.decimalPlaces = s.decimalPlaces;
    if (s.showMinorGrid !== undefined) { showMinorGridI.checked = s.showMinorGrid; const el = document.getElementById('showMinorGrid'); if (el) el.checked = s.showMinorGrid; }
    if (s.hideXAxis !== undefined) { hideXAxisI.checked = s.hideXAxis; const el = document.getElementById('hideXAxis'); if (el) el.checked = s.hideXAxis; }
    if (s.hideYAxis !== undefined) { hideYAxisI.checked = s.hideYAxis; const el = document.getElementById('hideYAxis'); if (el) el.checked = s.hideYAxis; }
    if (s.showGrid !== undefined) { showGrid.checked = s.showGrid; const el = document.getElementById('showGrid'); if (el) el.checked = s.showGrid; }
    if (s.pointStyle) ptStyleSelect.value = s.pointStyle;
  }
  selectedItemId = null;
  batchMode = false; batchSelected.clear();
  const lp = document.getElementById('leftPanel');
  if (lp) lp.classList.remove('batch-mode');
  const bt = document.getElementById('batchToolbar');
  if (bt) bt.style.display = 'none';
  const tg = document.getElementById('batchToggle');
  if (tg) tg.classList.remove('active');
  cacheIdMap.clear();
  offscreenCache.clear();
  pendingHashes.clear();
  autoCentered = false;
  for (const id of [...paramAnims.keys()]) stopParamAnim(id);
  for (const it of items) {
    if (it.type === 'segment' || it.type === 'line' || it.type === 'ray') {
      it.pointA = it.pointAId ? (items.find(i => i.id === it.pointAId && i.type === 'point') || null) : null;
      it.pointB = it.pointBId ? (items.find(i => i.id === it.pointBId && i.type === 'point') || null) : null;
      if (it.pointA && it.pointB) {
        it.midX = (it.pointA.x + it.pointB.x) / 2; it.midY = (it.pointA.y + it.pointB.y) / 2;
        it.length = Math.hypot(it.pointB.x - it.pointA.x, it.pointB.y - it.pointA.y);
      } else { it.midX = it.midX || 0; it.midY = it.midY || 0; it.length = it.length || 0; }
    }
  }
  updateSegmentLineItems();
  renderItemCards();
  updateItemCount();
  fullRender();
}

// ---- 创建新项目：重置项目数据与视图到默认状态 ----
function resetProjectData() {
  items = [];
  idSeq = { function: 0, point: 0, segment: 0, line: 0, ray: 0, param: 0 };
  itemColorSeq = 0;
  view.ox = 0; view.oy = 0;
  view.gridUnitLength = 5; view.gridPixelSize = 3; view.minorGridSteps = 5;
  view.pointSize = 4; view.renderPrecision = 0.01; view.decimalPlaces = 2;
  showGrid.checked = true;
  showMinorGridI.checked = true;
  hideXAxisI.checked = false;
  hideYAxisI.checked = false;
  ptStyleSelect.value = 'dot';
  if (tickFontSizeI) tickFontSizeI.value = 14;
  if (formulaFontSizeI) formulaFontSizeI.value = 18;
  if (majorGridColorI) majorGridColorI.value = '#555555';
  if (majorGridAlphaI) { majorGridAlphaI.value = 100; if (majorGridAlphaVal) majorGridAlphaVal.textContent = '100%'; }
  if (minorGridColorI) minorGridColorI.value = '#c8c8c8';
  if (minorGridAlphaI) { minorGridAlphaI.value = 100; if (minorGridAlphaVal) minorGridAlphaVal.textContent = '100%'; }
  const rg = document.getElementById('showGridSetting'); if (rg) rg.checked = true;
  const rsm = document.getElementById('showMinorGridSetting'); if (rsm) rsm.checked = true;
  const rhx = document.getElementById('hideXAxisSetting'); if (rhx) rhx.checked = false;
  const rhy = document.getElementById('hideYAxisSetting'); if (rhy) rhy.checked = false;
  const rps = document.getElementById('ptStyleSelectSetting'); if (rps) rps.value = 'dot';
  selectedItemId = null;
  batchMode = false; batchSelected.clear();
  const lp = document.getElementById('leftPanel');
  if (lp) lp.classList.remove('batch-mode');
  const bt = document.getElementById('batchToolbar');
  if (bt) bt.style.display = 'none';
  const tg = document.getElementById('batchToggle');
  if (tg) tg.classList.remove('active');
  cacheIdMap.clear();
  offscreenCache.clear();
  pendingHashes.clear();
  autoCentered = false;
  for (const id of [...paramAnims.keys()]) stopParamAnim(id);
  updateDisplayValues();
  renderItemCards();
  updateItemCount();
  fullRender();
  markSaved();
}

// ---- 分享：先保存到云端，再复制一份到仓库共享文件夹 ----
function menuShare() {
  closeAppMenu();
  if (!window.UserAuth) return;
  if (!UserAuth.isLoggedIn()) { UserAuth.showToast('请先登录后再分享'); UserAuth.requireLogin().then(function (ok) { if (ok) shareStep1(); }); return; }
  shareStep1();
}
function shareStep1() {
  if (isProjectDirty() || !cloudProjectId) {
    openSaveCloudModal({
      onSaved: function (data) { shareStep2(data._id); },
      onCancel: function () { if (UserAuth.showToast) UserAuth.showToast('已取消分享'); }
    });
  } else {
    shareStep2(cloudProjectId);
  }
}
async function shareStep2(id) {
  try {
    const r = await UserAuth.shareCloudProject(id);
    if (UserAuth.showToast) UserAuth.showToast('分享成功');
    showConfirm('分享成功', '项目「' + escapeHtml(r.name) + '」已保存到云端，并复制一份到仓库的共享文件夹（' + escapeHtml(r.path) + '）。\nraw 链接：' + escapeHtml(r.rawUrl), '知道了', function () { closeConfirm(); });
  } catch (e) {
    if (UserAuth.showToast) UserAuth.showToast(e.message || '分享失败');
  }
}

// ==================== 初始化 ====================
function init(){
  resizeCanvas();
  updateDisplayValues();
  initWorker();
  const importFileEl = document.getElementById('importFile');
  if (importFileEl) importFileEl.addEventListener('change', importProject);
  // 云端项目弹窗与确认弹窗绑定
  initSaveCloudModal();
  initOpenCloudModal();
  initConfirmModal();
  // 绑定右侧设置面板的控件，使修改生效
  function bindSettingsControls() {
    // 显示网格
    var showGridSetting = document.getElementById('showGridSetting');
    if (showGridSetting) {
      showGridSetting.addEventListener('change', function() {
        document.getElementById('showGrid').checked = this.checked;
        toggleGrid();
      });
    }
    // 显示小网格
    var showMinorGridSetting = document.getElementById('showMinorGridSetting');
    if (showMinorGridSetting) {
      showMinorGridSetting.addEventListener('change', function() {
        document.getElementById('showMinorGrid').checked = this.checked;
        toggleMinorGrid();
      });
    }
    // 坐标点样式
    var ptStyleSelectSetting = document.getElementById('ptStyleSelectSetting');
    if (ptStyleSelectSetting) {
      ptStyleSelectSetting.addEventListener('change', function() {
        document.getElementById('ptStyleSelect').value = this.value;
        updatePointStyle();
      });
    }
    // 隐藏X轴
    var hideXAxisSetting = document.getElementById('hideXAxisSetting');
    if (hideXAxisSetting) {
      hideXAxisSetting.addEventListener('change', function() {
        document.getElementById('hideXAxis').checked = this.checked;
        toggleAxis();
      });
    }
    // 隐藏Y轴
    var hideYAxisSetting = document.getElementById('hideYAxisSetting');
    if (hideYAxisSetting) {
      hideYAxisSetting.addEventListener('change', function() {
        document.getElementById('hideYAxis').checked = this.checked;
        toggleAxis();
      });
    }

    // 初始化同步右侧值与左侧一致
    var leftGrid = document.getElementById('showGrid');
    var rightGrid = document.getElementById('showGridSetting');
    if (rightGrid) rightGrid.checked = leftGrid.checked;

    var leftMinor = document.getElementById('showMinorGrid');
    var rightMinor = document.getElementById('showMinorGridSetting');
    if (rightMinor) rightMinor.checked = leftMinor.checked;

    var leftPt = document.getElementById('ptStyleSelect');
    var rightPt = document.getElementById('ptStyleSelectSetting');
    if (rightPt) rightPt.value = leftPt.value;

    var leftHideX = document.getElementById('hideXAxis');
    var rightHideX = document.getElementById('hideXAxisSetting');
    if (rightHideX) rightHideX.checked = leftHideX.checked;

    var leftHideY = document.getElementById('hideYAxis');
    var rightHideY = document.getElementById('hideYAxisSetting');
    if (rightHideY) rightHideY.checked = leftHideY.checked;
  }

  addFuncItem();
  if(items.length>0){selectItem(items[0].id);renderItemCards();updateItemCount();}
  setTimeout(()=>fullRender(),100);
  bindSettingsControls();  // 新增这一行
}
init();
// ==================== AI 系统（完整版） ====================
(function() {
  // ---------- 全局配置 ----------
  // 付费模型清单（严格大小写，保留为预设、锁定不可删除）
  const PAID_MODEL_NAMES = [
    'DeepSeek-V3.2','Qwen-3.5-Plus','Step-3.5-Flash','Ling-2.0-1T','DouBao-Seed-1.5',
    'DeepSeek-V4-pro','GLM-Z1-0414','Qwen-3.5-Flash','Hunyuan-2.0-Instruct','Qwen-3.6-Flash',
    'MiniMax-M2.5','Qwen-3.5-ABI','GLM-5.2-Max','Kimi-K3-Max','Gemini-3.6-Flash',
    'GPT-5.4-Medium','Gemini-3.1-Pro','Claude-Haiku-4.5','Grok-4.3-Expert','GPT-5.5-Codex',
    'DouBao-Seed-2.0','GPT-OSS-120B','Claude-Sonnet-5','Claude-Opus-5','DeepSeek-V4-Flash'
  ];
  const FREE_MODEL_URL = 'https://www.cunyuapi.top/deepseek';
  // 顶部标签栏高度：可移动模态框不允许覆盖标签栏
  const NAVBAR_H = 48;
  // ==================== 两类模型内置预设 ====================
  // 类别2：旧版兼容AI模型（强制默认 GET，拼接 URL 参数调用）
  const DEFAULT_LEGACY_MODELS = [
    { id: 'legacy-deepseek-v4-pro', name: 'DeepSeek-V4-Pro', displayName: 'DeepSeek-V4-Pro', category: 'legacy', preset: true,
      url: FREE_MODEL_URL, method: 'GET', billing: 'free', stream: false,
      memoryParamKey: 'conversation_id', contentParamKey: 'content', tokenParamKey: '', extraParams: '', memoryMode: 'auto', replyPath: '', memoryIdReplyPath: '',
    }
  ];
  // 类别1：主流AI大模型（OpenAI/标准格式，支持 POST 标准 tool call）
  const DEFAULT_MAINSTREAM_MODELS = PAID_MODEL_NAMES.map((n, i) => ({
    id: 'mainstream-' + (i + 1),
    name: n,
    category: 'mainstream',
    preset: true,
    url: 'https://yunzhiapi.cn/v1/chat/completions',
    method: 'POST',
    billing: 'paid',
    stream: true,
    systemSupport: true,
    memoryMode: 'none'
  }));
  // 已退役的旧预设模型 id（旧存储迁移时过滤）
  const RETIRED_PRESET_IDS = ['deepseek', 'openai-gpt4', 'claude-3'];
  // 模型配置存储 key（{ mainstream:[], legacy:[] }）
  const MODELS_STORAGE_KEY = 'ai_models_v2';
  const DEFAULT_MEMORY_MODEL_KEY = 'ai_default_memory_model';
  const MEMORY_ID_KEY = 'ai_memory_id';
  // 外部链接导入列表存储 key（[{ key: 指令集字样, url: 外部链接 }]）
  const LINK_SET_STORAGE_KEY = 'ai_link_import_list';
  let linkSetList = [];

  function loadLinkSetList() {
    try {
      const stored = localStorage.getItem(LINK_SET_STORAGE_KEY);
      linkSetList = stored ? JSON.parse(stored) : [];
      if (!Array.isArray(linkSetList)) linkSetList = [];
    } catch(e) { linkSetList = []; }
  }

  function saveLinkSetList() {
    localStorage.setItem(LINK_SET_STORAGE_KEY, JSON.stringify(linkSetList));
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 替换文本中的 {指令集字样}：匹配外部链接导入列表，抓取链接内容后用双引号包裹替换
  async function resolveDirectiveSets(text) {
    if (!text || typeof text !== 'string') return text;
    const map = {};
    linkSetList.forEach(item => {
      const k = (item && item.key ? String(item.key).trim() : '');
      const u = (item && item.url ? String(item.url).trim() : '');
      if (k && u && /^https?:\/\//i.test(u)) map[k] = u;
    });
    const keys = Object.keys(map);
    if (!keys.length) return text;
    const cache = {};
    let result = text;
    for (const key of keys) {
      const re = new RegExp('\\{' + escapeRegExp(key) + '\\}', 'g');
      if (!re.test(result)) continue;
      if (!(key in cache)) {
        let content = null;
        try {
          content = await fetchLinkContent(map[key]);
        } catch(e) { content = null; }
        if (content !== null && content.trim()) {
          cache[key] = '"' + content.trim().slice(0, 4000) + '"';
          pushAILog('response', '指令集「{' + key + '}」获取成功', {
            字样: '{' + key + '}',
            链接: map[key],
            内容长度: content.trim().length
          }, '链接获取');
        } else {
          // 获取失败：原字样前加感叹号，供 AI 明确识别该指令集内容不可用
          cache[key] = '!{' + key + '}';
          addSystemMessage('! 指令集「{' + key + '}」链接获取失败：' + map[key]);
          pushAILog('error', '指令集「{' + key + '}」获取失败', {
            字样: '{' + key + '}',
            链接: map[key],
            结果: '已替换为 !{' + key + '}，AI 将看到感叹号标记'
          }, '链接获取');
        }
      }
      result = result.replace(re, cache[key]);
    }
    return result;
  }

  // ---------- 需求3/4.4：终端代码块工具列表 ----------
  // 内置工具列表（标准 OpenAI function tools 格式），与 executeCommand 指令一一对应。
  // 工具名与参数名严格对齐远程 JSON（https://fastly.jsdelivr.net/gh/wkh321/abc@main/AI-chat/miaoda-code_20260802_194438.json），
  // 仅在远程列表不可用时作为离线回退，保证映射行为一致。
  const BUILTIN_TOOL_LIST = [
    { type: 'function', function: { name: 'set_unit', description: '设置数轴单位长度（每个大格代表的数值），示例：set_unit 2', parameters: { type: 'object', required: ['value'], properties: { value: { type: 'number', description: '数轴单位长度数值' } } } } },
    { type: 'function', function: { name: 'set_grid', description: '设置网格密度（像素/单位长度），示例：set_grid 5', parameters: { type: 'object', required: ['value'], properties: { value: { type: 'number', description: '网格密度数值' } } } } },
    { type: 'function', function: { name: 'set_minor', description: '设置每个大格内的小网格细分数，限定整数2~10，示例：set_minor 4', parameters: { type: 'object', required: ['num'], properties: { num: { type: 'integer', minimum: 2, maximum: 10, description: '细分数量，2到10之间整数' } } } } },
    { type: 'function', function: { name: 'set_pointsize', description: '设置坐标点显示的半径大小，限定整数1~20，示例：set_pointsize 6', parameters: { type: 'object', required: ['size'], properties: { size: { type: 'integer', minimum: 1, maximum: 20, description: '坐标点半径大小' } } } } },
    { type: 'function', function: { name: 'set_precision', description: '设置函数曲线采样步长，范围0.001~0.1，数值越小曲线越精细，示例：set_precision 0.005', parameters: { type: 'object', required: ['step'], properties: { step: { type: 'number', minimum: 0.001, maximum: 0.1, description: '曲线采样步长' } } } } },
    { type: 'function', function: { name: 'set_decimals', description: '设置坐标轴标签、坐标值显示小数位数，整数0~13，示例：set_decimals 3', parameters: { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 0, maximum: 13, description: '保留小数位数' } } } } },
    { type: 'function', function: { name: 'set_majorcolor', description: '设置主网格线颜色，传入十六进制色值#RRGGBB，示例：set_majorcolor #ff0000', parameters: { type: 'object', required: ['color'], properties: { color: { type: 'string', description: '十六进制颜色代码，格式#xxxxxx' } } } } },
    { type: 'function', function: { name: 'set_minorcolor', description: '设置细分网格线颜色，传入十六进制色值#RRGGBB，示例：set_minorcolor #00ff00', parameters: { type: 'object', required: ['color'], properties: { color: { type: 'string', description: '十六进制颜色代码，格式#xxxxxx' } } } } },
    { type: 'function', function: { name: 'show_grid', description: '显示或隐藏主网格，参数仅支持on/off，示例：show_grid off', parameters: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['on', 'off'], description: 'on开启主网格，off关闭主网格' } } } } },
    { type: 'function', function: { name: 'show_minor', description: '显示或隐藏细分小网格，参数仅支持on/off，示例：show_minor on', parameters: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['on', 'off'], description: 'on开启细分网格，off关闭细分网格' } } } } },
    { type: 'function', function: { name: 'show_xaxis', description: '显示或隐藏X坐标轴，参数仅支持on/off，示例：show_xaxis off', parameters: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['on', 'off'], description: 'on显示X轴，off隐藏X轴' } } } } },
    { type: 'function', function: { name: 'show_yaxis', description: '显示或隐藏Y坐标轴，参数仅支持on/off，示例：show_yaxis on', parameters: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['on', 'off'], description: 'on显示Y轴，off隐藏Y轴' } } } } },
    { type: 'function', function: { name: 'reset_view', description: '将画布视图重置为系统默认状态，无入参', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'add_function', description: '添加函数曲线，支持显式y=f(x)、隐式二元方程，支持+-*/^括号，示例：add_function y=sin(x)、add_function x^2+y^2=1', parameters: { type: 'object', required: ['expr'], properties: { expr: { type: 'string', description: '完整数学函数表达式' } } } } },
    { type: 'function', function: { name: 'add_point', description: '添加坐标点。x、y 支持四种写法，自动识别：① 纯数值（如 3 或 -2.5，固定坐标）；② 不含参数的代数式（如 1+sqrt(2)，直接计算后存为固定值）；③ 含参数的代数式（如 2*a+1，引用已创建的参数，参数变化时坐标自动重算）；④ y 还可直接填函数 ID（如 function_1，坐标点 Y 绑定该函数，随函数计算）。x 不支持函数 ID。label 可选大写单个字母标签。示例：add_point 3 2、add_point "2*a+1" "b-1" P、add_point 0 function_1 O', parameters: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'string', description: 'X 坐标：纯数值 / 代数式（含参数或不含参数）' }, y: { type: 'string', description: 'Y 坐标：纯数值 / 代数式（含参数或不含参数）/ 函数 ID（绑定函数模式）' }, label: { type: 'string', description: '可选，单个大写字母坐标点标签' } } } } },
    { type: 'function', function: { name: 'add_param', description: '创建可拖动调节参数滑块，参数名小写字母，配置最小值、最大值、步长、初始值，示例：add_param a -5 5 0.1 1', parameters: { type: 'object', required: ['name', 'min', 'max', 'step', 'init'], properties: { name: { type: 'string', description: '参数名称，小写单个字母' }, min: { type: 'number', description: '取值下限' }, max: { type: 'number', description: '取值上限' }, step: { type: 'number', description: '滑动调节步长' }, init: { type: 'number', description: '初始默认数值' } } } } },
    { type: 'function', function: { name: 'add_segment', description: '连接两个已有坐标点绘制线段，传入两点大写标签，示例：add_segment A B', parameters: { type: 'object', required: ['pointA', 'pointB'], properties: { pointA: { type: 'string', description: '起点大写标签' }, pointB: { type: 'string', description: '终点大写标签' } } } } },
    { type: 'function', function: { name: 'add_line', description: '绘制经过两个坐标点的无限直线，传入两点大写标签，示例：add_line A B', parameters: { type: 'object', required: ['pointA', 'pointB'], properties: { pointA: { type: 'string', description: '参考点A大写标签' }, pointB: { type: 'string', description: '参考点B大写标签' } } } } },
    { type: 'function', function: { name: 'add_ray', description: '绘制射线，从pointA出发经过pointB无限延伸，传入两点大写标签，示例：add_ray A B', parameters: { type: 'object', required: ['pointA', 'pointB'], properties: { pointA: { type: 'string', description: '射线起点大写标签' }, pointB: { type: 'string', description: '射线途经点大写标签' } } } } },
    { type: 'function', function: { name: 'delete_item', description: '删除画布内指定项目，自动处理依赖，传入项目唯一ID，示例：delete fx_1', parameters: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string', description: '目标项目唯一ID' } } } } },
    { type: 'function', function: { name: 'hide_item', description: '隐藏指定项目，项目保留在数据列表仅画布不渲染，示例：hide xy_1', parameters: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string', description: '目标项目唯一ID' } } } } },
    { type: 'function', function: { name: 'showitem_item', description: '恢复显示被隐藏的项目，传入项目ID，示例：showitem xy_1', parameters: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string', description: '已隐藏项目唯一ID' } } } } },
    { type: 'function', function: { name: 'setcolor_item', description: '修改指定项目的绘制颜色，项目ID+十六进制色值，示例：setcolor fx_1 #00aaff', parameters: { type: 'object', required: ['itemId', 'color'], properties: { itemId: { type: 'string', description: '目标项目唯一ID' }, color: { type: 'string', description: '十六进制颜色代码#xxxxxx' } } } } },
    { type: 'function', function: { name: 'setlabel_item', description: '修改坐标点、连线的展示标签，单个大写字母，示例：setlabel xy_1 C', parameters: { type: 'object', required: ['itemId', 'newLabel'], properties: { itemId: { type: 'string', description: '目标项目唯一ID' }, newLabel: { type: 'string', description: '新标签，单个大写英文字母' } } } } },
    { type: 'function', function: { name: 'clear_all', description: '一键清空画布内所有绘制项目，无二次确认，谨慎调用，无入参', parameters: { type: 'object', properties: {}, required: [] } } }
  ];

  // 追加在总工具数组末尾的只读数据工具（AI 执行步骤时可调用获取项目数据/知识库）
  // 获取知识库工具：当前仅提供占位框架，具体知识库获取逻辑后续接入
  const APPENDED_TOOL_LIST = [
    { type: 'function', function: { name: 'get_project_data', description: '获取函数绘制器当前全部项目数据（所有函数表达式、坐标点、参数滑块、线段/直线/射线及其数值与隐藏状态），以 JSON 文本形式返回，用于 AI 判断当前画布内容', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'get_knowledge_base', description: '获取函数绘制器知识库内容（使用说明与绘图技巧）。注意：知识库功能尚在建设中，当前返回内容可能为空', parameters: { type: 'object', properties: {}, required: [] } } }
  ];

  // 总工具数组：远程/内置工具列表 + 末尾追加的两个只读数据工具（get_project_data、get_knowledge_base）
  function getFullToolList() {
    const base = aiToolList.length ? aiToolList : BUILTIN_TOOL_LIST;
    const list = cloneToolList(base);
    const names = new Set(list.map(t => (t.function && t.function.name) || t.name).filter(Boolean));
    for (const t of APPENDED_TOOL_LIST) {
      const nm = (t.function && t.function.name) || t.name;
      if (!names.has(nm)) {
        list.push(JSON.parse(JSON.stringify(t)));
        names.add(nm);
      }
    }
    return list;
  }

  // 工具名 → 终端指令构造器（用于第5步 tool_call 转指令）
  // 工具名与参数名严格对齐远程 JSON（set_unit:value、set_minor:num、set_pointsize:size、
  // set_precision:step、set_decimals:count、show_*:mode、add_function:expr、
  // add_param:init、delete/hide/showitem_item:itemId、setlabel_item:newLabel 等）
  function buildToolCommand(name, args) {
    const a = args || {};
    const onOff = v => (v === true || String(v).toLowerCase() === 'on' ? 'on' : 'off');
    const q = s => `"${String(s).replace(/"/g, '\\"')}"`;
    const map = {
      set_unit: () => `set_unit ${a.value}`,
      set_grid: () => `set_grid ${a.value}`,
      set_minor: () => `set_minor ${a.num}`,
      set_pointsize: () => `set_pointsize ${a.size}`,
      set_precision: () => `set_precision ${a.step}`,
      set_decimals: () => `set_decimals ${a.count}`,
      set_majorcolor: () => `set_majorcolor ${q(a.color)}`,
      set_minorcolor: () => `set_minorcolor ${q(a.color)}`,
      show_grid: () => `show_grid ${onOff(a.mode)}`,
      show_minor: () => `show_minor ${onOff(a.mode)}`,
      show_xaxis: () => `show_xaxis ${onOff(a.mode)}`,
      show_yaxis: () => `show_yaxis ${onOff(a.mode)}`,
      reset_view: () => `reset_view`,
      add_function: () => `add_function ${a.expr}`,
      add_point: () => `add_point ${q(String(a.x))} ${q(String(a.y))}${a.label != null && a.label !== '' ? ' ' + q(a.label) : ''}`,
      add_param: () => `add_param ${a.name} ${a.min} ${a.max} ${a.step}${a.init != null ? ' ' + a.init : ''}`,
      add_segment: () => `add_segment ${q(a.pointA)} ${q(a.pointB)}`,
      add_line: () => `add_line ${q(a.pointA)} ${q(a.pointB)}`,
      add_ray: () => `add_ray ${q(a.pointA)} ${q(a.pointB)}`,
      delete_item: () => `delete ${a.itemId}`,
      hide_item: () => `hide ${a.itemId}`,
      showitem_item: () => `showitem ${a.itemId}`,
      setcolor_item: () => `setcolor ${a.itemId} ${q(a.color)}`,
      setlabel_item: () => `setlabel ${a.itemId} ${q(a.newLabel)}`,
      clear_all: () => `clear_all`
    };
    // 工具名归一化：AI 可能把 name 写成 description 里的空格写法（如 "add param"、"add point"）
    // 或连字符写法，统一转成下划线形式再匹配，避免误报「未知工具」
    const normalizedName = String(name == null ? '' : name).trim().replace(/[\s\u3000-]+/g, '_');
    const builder = map[normalizedName];
    if (!builder) return null;
    return builder();
  }

  // 当前生效的工具列表（远程优先，本地缓存，失败回退内置）
  let aiToolList = [];
  let aiToolListCacheTime = 0;
  const TOOL_LIST_CACHE_KEY = 'ai_tool_list';
  const TOOL_LIST_CACHE_TIME_KEY = 'ai_tool_list_time';
  const TOOL_LIST_URL_KEY = 'ai_tool_list_url';
  const TOOL_LIST_TTL = 24 * 60 * 60 * 1000;
  const DEFAULT_TOOL_LIST_URL = 'https://fastly.jsdelivr.net/gh/wkh321/abc@main/AI-chat/miaoda-code_20260802_194438.json';

  // 简易工具列表（带序号+说明，仅用于发给记忆模型规划 tool_idx，不含工具执行内容）
  // 远程格式兼容：[{"index":0,"tool":{name,description,...}}] / [{"index":0,name,description,...}] / 纯工具数组
  let aiSimpleToolList = [];
  const SIMPLE_TOOL_LIST_KEY = 'ai_simple_tool_list';
  const SIMPLE_TOOL_LIST_TIME_KEY = 'ai_simple_tool_list_time';
  const SIMPLE_TOOL_LIST_URL_KEY = 'ai_simple_tool_list_url';
  const DEFAULT_SIMPLE_TOOL_LIST_URL = 'https://fastly.jsdelivr.net/gh/wkh321/abc@main/AI-chat/doubao_json_20260805_003112_20260805_003206.json';

  function cloneToolList(list) {
    try { return JSON.parse(JSON.stringify(Array.isArray(list) ? list : [])); } catch(e) { return []; }
  }

  // 将任意工具定义归一化为标准 OpenAI function tool 格式
  // 兼容两种输入：标准嵌套 {type:'function', function:{name,description,parameters}}，
  // 以及扁平格式 {type:'function', name, description, parameters}（远程 JSON 中存在）。
  // 归一是为了让传入云智API的 tools 数组严格符合 OpenAI Chat 标准，并确保扁平格式工具不被步骤过滤器丢弃。
  function normalizeToolList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      let fn;
      if (t.function && typeof t.function === 'object' && t.function.name) {
        fn = t.function;
      } else if (t.name) {
        fn = t;
      }
      if (!fn || !fn.name) continue;
      out.push({
        type: 'function',
        function: {
          name: fn.name,
          description: fn.description || '',
          parameters: (fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : { type: 'object', properties: {}, required: [] }
        }
      });
    }
    return out;
  }

  // 从 localStorage 读取工具列表（仅当天有效，过期后自动重新获取）
  function loadCachedToolList() {
    try {
      const time = parseInt(localStorage.getItem(TOOL_LIST_CACHE_TIME_KEY) || '0', 10);
      if (Date.now() - time < TOOL_LIST_TTL) {
        const raw = localStorage.getItem(TOOL_LIST_CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length) return parsed;
        }
      }
    } catch(e) {}
    return null;
  }

  function saveCachedToolList(list) {
    try {
      localStorage.setItem(TOOL_LIST_CACHE_KEY, JSON.stringify(list));
      localStorage.setItem(TOOL_LIST_CACHE_TIME_KEY, String(Date.now()));
    } catch(e) {}
  }

  // 从远程解析结果中提取工具数组，兼容三种格式：
  // 1) 纯工具数组 [{type:'function',...}]
  // 2) 嵌套序号格式 [{"index":0,"tool":{...工具}}]（每项含 tool 子对象，无 function/name）
  // 3) 包裹对象 {tools:[...]}
  function extractToolArrayFromParsed(parsed) {
    if (Array.isArray(parsed)) {
      if (parsed.length && parsed[0] && typeof parsed[0] === 'object' && parsed[0].tool && !parsed[0].function && !parsed[0].name) {
        return parsed.map(t => (t && t.tool) || null).filter(Boolean);
      }
      return parsed;
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tools)) return parsed.tools;
    return null;
  }

  // 从远程地址获取工具列表（带超时）
  async function fetchRemoteToolList(url) {
    const { response, cleanup } = await performFetch(url, { method: 'GET' }, 15000, '工具列表获取');
    try {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const text = await response.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch(e) { throw new Error('返回内容不是合法 JSON'); }
      const list = extractToolArrayFromParsed(parsed);
      if (!list || !list.length) throw new Error('未获取到工具数据');
      return normalizeToolList(list);
    } finally {
      cleanup();
    }
  }

  // 解析简易工具列表为 [{name, description}]（忽略远程 index，序号以完整工具数组顺序为准）
  function parseSimpleToolList(parsed) {
    const list = extractToolArrayFromParsed(parsed);
    if (!Array.isArray(list) || !list.length) return [];
    const out = [];
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      const holder = (t.tool && typeof t.tool === 'object') ? t.tool : t;
      const name = holder.name || holder.function?.name || '';
      if (!name) continue;
      const description = holder.description || holder.desc || holder['说明'] || holder.title || '';
      out.push({ name: String(name), description: String(description || '') });
    }
    return out;
  }

  function loadCachedSimpleToolList() {
    try {
      const time = parseInt(localStorage.getItem(SIMPLE_TOOL_LIST_TIME_KEY) || '0', 10);
      if (Date.now() - time < TOOL_LIST_TTL) {
        const raw = localStorage.getItem(SIMPLE_TOOL_LIST_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length) return parsed;
        }
      }
    } catch(e) {}
    return null;
  }

  function saveCachedSimpleToolList(list) {
    try {
      localStorage.setItem(SIMPLE_TOOL_LIST_KEY, JSON.stringify(list));
      localStorage.setItem(SIMPLE_TOOL_LIST_TIME_KEY, String(Date.now()));
    } catch(e) {}
  }

  // 初始化简易工具列表（缓存 → 远程）；无地址时保持空数组
  async function initSimpleToolList(forceRefresh) {
    const url = (localStorage.getItem(SIMPLE_TOOL_LIST_URL_KEY) || '').trim();
    if (!forceRefresh && aiSimpleToolList.length) return;
    if (!forceRefresh) {
      const cached = loadCachedSimpleToolList();
      if (cached) { aiSimpleToolList = cached; return; }
    }
    if (!url) return;
    try {
      const { response, cleanup } = await performFetch(url, { method: 'GET' }, 15000, '简易工具列表获取');
      try {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const text = await response.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch(e) { throw new Error('返回内容不是合法 JSON'); }
        const list = parseSimpleToolList(parsed);
        if (!list.length) throw new Error('未获取到工具说明数据');
        aiSimpleToolList = list;
        saveCachedSimpleToolList(list);
      } finally {
        cleanup();
      }
    } catch(e) {
      pushAILog('error', '简易工具列表获取失败', { 地址: url, 错误: e.message });
    }
  }

  // 获取带序号+说明的简易工具列表（发给记忆模型规划 tool_idx 用）。
  // 序号与完整工具数组顺序一一对应（0 起始），说明优先取简易远程列表，否则用完整工具描述。
  function getSimpleToolList() {
    const full = getFullToolList();
    const descMap = {};
    for (const s of aiSimpleToolList) {
      if (s && s.name && !(s.name in descMap)) descMap[s.name] = s.description || '';
    }
    return full.map((t, i) => {
      const name = (t.function && t.function.name) || t.name || '';
      return {
        index: i,
        tool: {
          name: name,
          description: (name in descMap ? descMap[name] : ((t.function && t.function.description) || t.description || ''))
        }
      };
    });
  }

  // 初始化工具列表：缓存 → 远程 → 内置
  async function initToolList(forceRefresh) {
    const url = (localStorage.getItem(TOOL_LIST_URL_KEY) || '').trim();
    // 无地址时优先使用内置，无需远程
    if (!url) {
      if (aiToolList.length === 0) aiToolList = cloneToolList(BUILTIN_TOOL_LIST);
      renderToolList();
      return;
    }
    if (!forceRefresh && aiToolList.length) {
      renderToolList();
      return;
    }
    // 尝试缓存（老缓存可能含扁平格式工具，统一归一化）
    if (!forceRefresh) {
      const cached = loadCachedToolList();
      if (cached) {
        aiToolList = normalizeToolList(cloneToolList(cached));
        renderToolList();
        return;
      }
    }
    try {
      const list = await fetchRemoteToolList(url);
      aiToolList = cloneToolList(list);
      saveCachedToolList(aiToolList);
    } catch(e) {
      if (aiToolList.length === 0) aiToolList = cloneToolList(BUILTIN_TOOL_LIST);
      addSystemMessage('? [步骤: 工具列表] 远程工具列表获取失败（' + e.message + '），已回退到内置列表');
    }
    renderToolList();
  }

  // 需求4.4：设置面板工具列表只读展示
  function renderToolList() {
    if (!toolListContainer) return;
    toolListContainer.innerHTML = '';
    const list = getFullToolList();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'ai-tool-list-empty';
      empty.textContent = '暂无工具数据';
      toolListContainer.appendChild(empty);
      return;
    }
    list.forEach(tool => {
      const fn = tool && tool.function ? tool.function : tool;
      const name = fn.name || '未命名';
      const desc = fn.description || '（无说明）';
      const props = (fn.parameters && fn.parameters.properties) || {};
      const required = (fn.parameters && fn.parameters.required) || [];
      const item = document.createElement('div');
      item.className = 'ai-tool-list-item';
      const nameRow = document.createElement('div');
      nameRow.innerHTML = '<span class="ai-tool-name">' + escHtml(name) + '</span> <span style="color:#94a3b8;font-size:11px;">（作用说明）</span>';
      const descEl = document.createElement('div');
      descEl.className = 'ai-tool-desc';
      descEl.textContent = desc;
      const paramsEl = document.createElement('div');
      paramsEl.className = 'ai-tool-params';
      const pKeys = Object.keys(props);
      if (pKeys.length) {
        paramsEl.textContent = '参数属性: ' + pKeys.map(k => {
          const p = props[k];
          const type = p.type || 'any';
          const req = required.includes(k) ? '必填' : '可选';
          return k + ' (' + type + ', ' + req + (p.description ? ', ' + p.description : '') + ')';
        }).join('; ');
      } else {
        paramsEl.textContent = '参数属性: 无';
      }
      item.appendChild(nameRow);
      item.appendChild(descEl);
      item.appendChild(paramsEl);
      toolListContainer.appendChild(item);
    });
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // AI 设置
  // 三守则默认值（仅在 localStorage 无已保存守则时回退，不覆盖用户已保存内容）
  const DEFAULT_SYSTEM = '你是一个专业的函数绘制器助手，你可以通过终端指令操作项目。请严格按照用户的需求生成指令，并在回答中附上执行结果。';
  const DEFAULT_STEPS_FORMAT = [
    '{system_rule}你是函数绘制器的执行规划器。请针对用户请求，规划分步执行方案。',
    '输出分为三部分，用 //#//&// 分割，前置先输出标准 Markdown 表格。',
    '禁止输出额外文字、注释、解释。',
    '',
    '第一部分（开头）：标准 Markdown 表格，表头固定为：步骤序号 | 步骤内容 | 工具名',
    '表格每行对应一个执行步骤，步骤内容需完整说明该步要做什么、期望达成什么结果。',
    '',
    '//#//&//',
    '',
    '第二段（步骤数据 JSON 数组），结构：',
    '[{"step":数字序号,"note":"简短步骤说明，描述需要调用工具完成的操作"}]',
    '',
    '//#//&//',
    '',
    '第三段（工具数据 JSON 数组），结构：',
    '[{"step":数字序号,"tool_idx":[数字序号数组]}]',
    '',
    '约束：',
    '1. 仅使用下方可用工具列表内的原生工具，禁止自定义虚构工具；tool_idx 为数字序号数组，直接引用下方工具列表每项的 index 序号，与工具一一对应。',
    '2. 依赖步骤按先后顺序排序。',
    '3. 工具列表末尾始终包含两个只读数据工具：get_project_data（获取项目全部数据）与 get_knowledge_base（获取知识库内容）；当某步需要了解当前画布已有内容或依赖前序步骤结果时，必须把 get_project_data 加入该步的 tool_idx，不要凭空猜测当前项目状态。',
    '4. 无参数工具 parameters 传空对象 {}。',
    '',
    '可用工具列表（每项含 index 序号与工具说明，从中挑选工具序号）：',
    '{tools_json}',
    '',
    '【用户请求】',
    '{user_query}',
    ''
  ].join('\n');
  const DEFAULT_EXECUTE_STEPS = [
    '你正在执行函数绘制器的分步操作任务。请严格遵守以下守则：',
    '1. 当前为本任务第 N 步，只针对本步骤执行，不要越步执行后续步骤的操作。',
    '2. 先明确本步目标并输出简短的思考过程，再规划本步需要调用的工具与参数；思考过程精炼即可，随后只通过 tool_call 调用工具完成本步，不要输出多余解释文本。',
    '3. 调用工具前核对本步工具列表（tools 数组）中的必需参数是否完整、数值是否合理；参数无法确定时，输出清晰的思考说明并调用最接近的工具，绝不编造数值。',
    '4. 每步只允许调用本步 tools 数组中提供的工具；需要的工具不存在时，不要臆造工具名，改为输出说明文字。',
    '5. 工具调用完成后，用简短文字汇报本步执行结果，供下一步参考。',
    '    6. 本步 tools 数组末尾始终包含两个只读数据工具：get_project_data（获取当前项目全部数据）、get_knowledge_base（获取知识库内容）。当本步需要了解当前画布已有内容或依赖前序步骤的结果时，先调用 get_project_data 获取数据后再决定具体操作，不要凭空猜测当前项目状态。',
    ''
  ].join('\n');
  // 第4项守则：AI 判定守则（记忆模型先判定用户输入是「继续执行」「指令执行」还是「普通问答」）
  const DEFAULT_CLASSIFY_RULE = [
    '你是函数绘制器 AI 的分类器。请判断以下用户请求的类型，只回复一个词（「继续执行」「指令执行」或「普通问答」），不要输出任何其他内容。',
    '',
    '类别定义：',
    '1. 「继续执行」：当{has_saved_steps}，且用户输入是要求继续执行任务的指令（例如「继续执行任务」「继续执行」「继续」「从上次中断处继续」等），希望从上次中断处继续执行已保存的执行步骤时，判定为「继续执行」。',
    '2. 「指令执行」：需要操作项目数据的「终端指令」（例如添加/删除/修改函数、坐标点、参数、连线，或修改网格/视图设置）。',
    '3. 「普通问答」：提问、解释、闲聊等无需操作项目的请求。',
    '',
    '用户请求：{user_query}'
  ].join('\n');
  let aiSettings = {
    systemPrompt: '',
    autoContext: true,
    snapshotCount: 20,
    streaming: true,
    requestFormat: 'openai',
    apiKey: '',
    timeoutMs: 300000,
    stepsFormat: '',   // 新增
    executeStepsPrompt: '',
    classifyPrompt: '',
    deepseekDisableThinking: true,
    stepRetryEnabled: true,
    stepRetryCount: 2
  };

  // 模型列表（主流 + 旧版 两个类别，各自包含预设 + 用户自定义）
  let aiMainstreamModels = [];
  let aiLegacyModels = [];
  let currentModelId = 'legacy-deepseek-v4-pro';
  let defaultMemoryModelId = '';

  // 记忆 ID（6位数字，取代 conversation_id）+ 记忆托管状态
  let memoryId = '';
  let serverConvId = '';
  let freeContextPrompt = '';
  let freeDataDirty = false;
  let freeInitInProgress = false;
  let freeSyncInProgress = false;
  let isFirstMessage = true; // 是否是新对话的首次消息
  // 已保存的执行步骤（仅内存，刷新/清空对话时清除）：用于用户取消后「继续执行任务」
  let continueStepsData = null;

  // AI 响应计时秒表
  let stopwatchTimer = null;
  let stopwatchStart = 0;

  // 历史快照
  let snapshots = [];
  let snapshotMax = 20;
  let isRestoring = false;

  // DOM 引用
  let dialog;
  let titleBar;
  let closeBtn;
  let chatArea;
  let input;
  let sendBtn;
  let statusText;
  let statusDot;
  let resizeHandle;
  let modelSelect;
  let modelTag;
  let rollbackBtn;
  let syncBtn;
  let viewSyncBtn;
  let responseTimeEl;

  // 设置面板元素
  let systemPromptInput;
  let autoContextCheck;
  let snapshotCountInput;
  let streamingCheck;
  let requestFormatSelect;
  let apiKeyInput;
  let timeoutInput;
  let deepseekThinkingCheck;
  let stepRetryCheck;
  let stepRetryCountInput;
  let toolListContainer;
  let toolListUrlInput;
  let simpleToolListUrlInput;
  let toolReloadBtn;
  let inputBar;
  let aiStepsBar;
  let titleTextEl;
  // 模型管理弹窗
  let modelManagerOverlay, modelCloseBtn, mainstreamTbody, legacyTbody;
  let addMainstreamBtn, addLegacyBtn, addCustomBtn, restoreDefaultBtn, modelManagerTitle;
  // 默认记忆模型下拉
  let defaultMemorySelect;
  // 聊天功能区容器与其上边缘拖拽手柄
  let chatDock, dockHandle;

  // 状态
  let isVisible = false;
  let isDragging = false, dragOffX = 0, dragOffY = 0;
  let isResizing = false, resStartX, resStartY, resStartW, resStartH;
  // AI 请求中断状态机（发送 ⇄ 取消）
  let aiBusy = false;
  let aiCancelled = false;
  let aiAbortController = null;
  let aiSleepCanceller = null;
  // 进行中的 fetch 控制器集合（取消时强制清空 pending 队列）
  let aiPendingFetches = new Set();
  const AI_ABORT_NAME = 'AIAbortError';
  function AIAbortError() { const e = new Error('已取消'); e.name = AI_ABORT_NAME; return e; }

  // ---------- AI 全链路日志（需求二：统一分类标记 + 模态框查看） ----------
  // 同时输出到控制台并写入 aiLogEntries（供 AI 日志模态框展示，保留最近 300 条）
  // cat 为日志分类（AI请求/AI回复/AI异常/工具数组解析/链接获取/模拟终端/其他），
  // 未传时按 type 映射默认分类；模态框顶部多选框可按分类过滤查看。
  let aiLogEntries = [];
  let aiLogSeq = 0;
  const AI_LOG_MAX = 300;
  const AI_LOG_CATS = ['AI请求', 'AI回复', 'AI异常', '工具数组解析', 'token统计', '链接获取', '模拟终端', '其他'];
  let aiLogCatFilter = {};
  function defaultCatOfType(type) {
    return type === 'request' ? 'AI请求' : type === 'response' ? 'AI回复' : type === 'error' ? 'AI异常' : '其他';
  }
  function pushAILog(type, label, data, cat) {
    aiLogSeq++;
    const entryCat = cat || defaultCatOfType(type);
    aiLogEntries.push({ id: aiLogSeq, time: new Date(), type: type, cat: entryCat, label: label, data: data });
    if (aiLogEntries.length > AI_LOG_MAX) aiLogEntries.splice(0, aiLogEntries.length - AI_LOG_MAX);
    renderAILogIfOpen();
  }
  function logAIRequest(label, url, method, headers, body, note) {
    console.log('%c[AI请求日志] ' + label, 'color:#16a34a;font-weight:bold;', {
      请求地址: url || '',
      请求方式: method || 'GET',
      请求头: headers || {},
      入参: body == null ? '' : (typeof body === 'string' ? body : body),
      ...(note || {})
    });
    pushAILog('request', label, {
      请求地址: url || '',
      请求方式: method || 'GET',
      请求头: headers || {},
      入参: body == null ? '' : (typeof body === 'string' ? body : body),
      ...(note || {})
    });
  }
  function logAIResponse(label, raw) {
    console.log('%c[AI返回日志] ' + label, 'color:#2563eb;font-weight:bold;', {
      原始返回: (raw == null ? '' : String(raw).slice(0, 12000))
    });
    pushAILog('response', label, {
      原始返回: (raw == null ? '' : String(raw).slice(0, 12000))
    });
  }
  function logAIError(label, err, extra) {
    console.error('%c[AI异常日志] ' + label, 'color:#dc2626;font-weight:bold;', {
      错误: err && err.message ? err.message : String(err),
      错误码: err && err.status ? err.status : (err && err.name || ''),
      堆栈: err && err.stack ? err.stack : '',
      ...(extra || {})
    });
    pushAILog('error', label, {
      错误: err && err.message ? err.message : String(err),
      错误码: err && err.status ? err.status : (err && err.name || ''),
      堆栈: err && err.stack ? err.stack : '',
      ...(extra || {})
    });
  }

  // ---------- AI 日志模态框（需求：替代控制台，可视化查看全链路日志） ----------
  function openAILogModal() {
    const overlay = document.getElementById('aiLogOverlay');
    if (!overlay) return;
    overlay.classList.add('visible');
    renderAILogFilterBar();
    renderAILog();
  }
  function closeAILogModal() {
    const overlay = document.getElementById('aiLogOverlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
  }
  function renderAILogIfOpen() {
    const overlay = document.getElementById('aiLogOverlay');
    if (!overlay || !overlay.classList.contains('visible')) return;
    renderAILog();
  }
  function clearAILog() {
    aiLogEntries = [];
    renderAILog();
  }
  function renderAILog() {
    const body = document.getElementById('aiLogBody');
    const countEl = document.getElementById('aiLogCount');
    if (!body) return;
    // 分类过滤：未在 aiLogCatFilter 中显式关闭的分类视为可见
    const visible = aiLogEntries.filter(function(e) { return aiLogCatFilter[e.cat] !== false; });
    if (countEl) {
      countEl.textContent = visible.length
        ? ('显示 ' + visible.length + ' / 共 ' + aiLogEntries.length + ' 条')
        : (aiLogEntries.length ? '已按分类全部隐藏' : '');
    }
    if (!visible.length) {
      body.innerHTML = aiLogEntries.length
        ? '<div class="ai-log-empty">当前分类下暂无日志。请在顶部选择要查看的分类。</div>'
        : '<div class="ai-log-empty">暂无 AI 日志。向 AI 发起一次请求后，这里会展示完整的请求 / 返回 / 异常记录。</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    const list = visible.slice().reverse();
    list.forEach(function(entry) {
      const row = document.createElement('div');
      row.className = 'ai-log-entry' + (entry.expanded ? ' expanded' : '');
      row.dataset.id = entry.id;
      const typeLabel = entry.type === 'request' ? '请求' : entry.type === 'response' ? '返回' : '异常';
      const d = entry.time || new Date();
      const timeStr = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
      const catLabel = entry.cat || '其他';
      row.innerHTML =
        '<div class="ai-log-entry-head">' +
          '<span class="ai-log-badge ' + entry.type + '">' + typeLabel + '</span>' +
          '<span class="ai-log-cat">' + escHtml(catLabel) + '</span>' +
          '<span class="ai-log-label" title="' + escHtml(String(entry.label)) + '">' + escHtml(String(entry.label)) + '</span>' +
          '<span class="ai-log-time">' + timeStr + '</span>' +
          '<button class="ai-log-copy" title="复制本条日志内容">复制</button>' +
          '<button class="ai-log-toggle">' + (entry.expanded ? '收起' : '展开') + '</button>' +
        '</div>' +
        '<div class="ai-log-entry-body"><div class="ai-log-json">' + formatLogValue(entry.data) + '</div></div>';
      frag.appendChild(row);
    });
    body.innerHTML = '';
    body.appendChild(frag);
  }

  // 渲染日志分类过滤条（多选框：AI请求/AI回复/AI异常/工具数组解析/链接获取/模拟终端/其他 + 全选）
  function renderAILogFilterBar() {
    const bar = document.getElementById('aiLogFilterBar');
    if (!bar) return;
    bar.innerHTML = '';
    const title = document.createElement('span');
    title.className = 'ai-log-filter-title';
    title.textContent = '分类：';
    bar.appendChild(title);
    const allChecked = AI_LOG_CATS.every(function(c) { return aiLogCatFilter[c] !== false; });
    const allLabel = document.createElement('label');
    allLabel.className = 'ai-log-filter-chip' + (allChecked ? ' on' : '');
    const allBox = document.createElement('input');
    allBox.type = 'checkbox';
    allBox.checked = allChecked;
    allBox.addEventListener('change', function() {
      const val = allBox.checked;
      AI_LOG_CATS.forEach(function(c) { aiLogCatFilter[c] = val; });
      renderAILogFilterBar();
      renderAILog();
    });
    allLabel.appendChild(allBox);
    allLabel.appendChild(document.createTextNode('全选'));
    bar.appendChild(allLabel);
    AI_LOG_CATS.forEach(function(c) {
      const on = aiLogCatFilter[c] !== false;
      const label = document.createElement('label');
      label.className = 'ai-log-filter-chip' + (on ? ' on' : '');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = on;
      box.dataset.cat = c;
      box.addEventListener('change', function() {
        aiLogCatFilter[c] = box.checked;
        renderAILogFilterBar();
        renderAILog();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(c));
      bar.appendChild(label);
    });
  }
  // 将日志对象美观递归格式化为 HTML（键值着色、逐层缩进）
  function formatLogValue(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return '<span class="ai-log-null">' + (v === null ? 'null' : 'undefined') + '</span>';
    if (typeof v === 'string') return '<span class="ai-log-str">"' + escHtml(v) + '"</span>';
    if (typeof v === 'number') return '<span class="ai-log-num">' + v + '</span>';
    if (typeof v === 'boolean') return '<span class="ai-log-bool">' + v + '</span>';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      let html = '[<div class="ai-log-indent">';
      for (let i = 0; i < v.length; i++) html += '<div>' + formatLogValue(v[i], depth + 1) + '</div>';
      html += '</div>]';
      return html;
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) return '{}';
      let html = '{<div class="ai-log-indent">';
      keys.forEach(function(k) {
        html += '<div><span class="ai-log-key">' + escHtml(String(k)) + '</span>: ' + formatLogValue(v[k], depth + 1) + '</div>';
      });
      html += '</div>}';
      return html;
    }
    return escHtml(String(v));
  }
  // 单条日志内容转纯文本（供复制）
  function aiLogEntryToText(data) {
    return JSON.stringify(data, null, 2);
  }
  // 绑定日志模态框：打开/关闭/清空 + 列表交互（展开、复制）+ 拖拽缩放
  function initAILogDialog() {
    const overlay = document.getElementById('aiLogOverlay');
    const dialog = document.getElementById('aiLogDialog');
    const body = document.getElementById('aiLogBody');
    const openBtn = document.getElementById('aiLogBtn');
    const closeBtn = document.getElementById('aiLogCloseBtn');
    const clearBtn = document.getElementById('aiLogClearBtn');
    const handle = document.getElementById('aiLogDragHandle');
    const resize = document.getElementById('aiLogResizeHandle');
    if (openBtn) openBtn.addEventListener('click', openAILogModal);
    if (closeBtn) closeBtn.addEventListener('click', closeAILogModal);
    if (clearBtn) clearBtn.addEventListener('click', clearAILog);
    renderAILogFilterBar();
    if (overlay) {
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeAILogModal();
      });
    }
    if (body) {
      body.addEventListener('click', function(e) {
        const toggle = e.target.closest('.ai-log-toggle');
        if (toggle) {
          const row = toggle.closest('.ai-log-entry');
          if (!row) return;
          const id = Number(row.dataset.id);
          const entry = aiLogEntries.find(x => x.id === id);
          if (entry) entry.expanded = !entry.expanded;
          renderAILog();
          return;
        }
        const copyBtn = e.target.closest('.ai-log-copy');
        if (copyBtn) {
          const row = copyBtn.closest('.ai-log-entry');
          if (!row) return;
          const id = Number(row.dataset.id);
          const entry = aiLogEntries.find(x => x.id === id);
          if (!entry) return;
          const text = aiLogEntryToText(entry.data);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
              copyBtn.textContent = '已复制';
              setTimeout(function() { copyBtn.textContent = '复制'; }, 1200);
            }).catch(function() { fallbackCopy(text, copyBtn); });
          } else {
            fallbackCopy(text, copyBtn);
          }
          return;
        }
        const head = e.target.closest('.ai-log-entry-head');
        if (head) {
          const row = head.closest('.ai-log-entry');
          if (row) {
            const id = Number(row.dataset.id);
            const entry = aiLogEntries.find(x => x.id === id);
            if (entry) entry.expanded = !entry.expanded;
            renderAILog();
          }
        }
      });
    }
    if (!dialog) return;
    let dragging = false, offX = 0, offY = 0;
    let resizing = false, rsX = 0, rsY = 0, rsW = 0, rsH = 0;
    function onAILogMove(e) {
      if (dragging) {
        const left = e.clientX - offX;
        const top = e.clientY - offY;
        dialog.style.left = Math.max(0, Math.min(window.innerWidth - dialog.offsetWidth, left)) + 'px';
        dialog.style.top = Math.max(NAVBAR_H, Math.min(window.innerHeight - dialog.offsetHeight, top)) + 'px';
      } else if (resizing) {
        const minW = 420, minH = 300;
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = Math.max(minW, Math.min(vw - 8, rsW + (e.clientX - rsX)));
        const h = Math.max(minH, Math.min(vh - 8, rsH + (e.clientY - rsY)));
        dialog.style.width = w + 'px';
        dialog.style.height = h + 'px';
        const rect = dialog.getBoundingClientRect();
        if (rect.right > vw) dialog.style.left = Math.max(0, vw - w) + 'px';
        if (rect.bottom > vh) dialog.style.top = Math.max(NAVBAR_H, vh - h) + 'px';
      }
    }
    function onAILogUp() {
      dragging = false;
      resizing = false;
      document.body.style.userSelect = '';
    }
    if (handle) {
      handle.addEventListener('mousedown', function(e) {
        if (e.target.closest('button')) return;
        dragging = true;
        const rect = dialog.getBoundingClientRect();
        offX = e.clientX - rect.left;
        offY = e.clientY - rect.top;
        dialog.dataset.moved = '1';
        dialog.classList.add('moved');
        dialog.style.transform = 'none';
        e.preventDefault();
      });
    }
    if (resize) {
      resize.addEventListener('mousedown', function(e) {
        resizing = true;
        const rect = dialog.getBoundingClientRect();
        rsX = e.clientX; rsY = e.clientY; rsW = rect.width; rsH = rect.height;
        dialog.dataset.moved = '1';
        dialog.classList.add('moved');
        dialog.style.transform = 'none';
        e.preventDefault();
        e.stopPropagation();
      });
    }
    document.addEventListener('mousemove', onAILogMove);
    document.addEventListener('mouseup', onAILogUp);
  }
  function fallbackCopy(text, btn) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (btn) {
        btn.textContent = '已复制';
        setTimeout(function() { btn.textContent = '复制'; }, 1200);
      }
    } catch (err) { /* 复制失败忽略 */ }
  }

  // ---------- 工具函数 ----------
  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch(e) {}
  }

  // ---------- 终端指令弹窗（非模态，样式同 AI 日志） ----------
  let terminalHistory = [];
  let terminalHistoryIdx = 0;
  function terminalEchoLine(text, cls) {
    const body = document.getElementById('aiTerminalBody');
    if (!body) return;
    const line = document.createElement('div');
    line.className = 'ai-terminal-line' + (cls ? ' ' + cls : '');
    line.textContent = text;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
  }
  function openTerminalModal() {
    const overlay = document.getElementById('aiTerminalOverlay');
    if (overlay) overlay.classList.add('visible');
    if (!terminalHistory._greeted) {
      terminalHistory._greeted = true;
      terminalEchoLine('函数绘制器终端指令：输入指令回车执行。示例：add_function y=x^2、add_point 1 2、add_param a 0 10 0.5 5、add_segment a b、set_unit 5、show_grid on、reset_view、clear_all、help', 'info');
      terminalEchoLine('可用指令：add_function / add_point / add_param / add_segment / add_line / add_ray / set_unit / set_grid / set_minor / set_pointsize / set_precision / set_decimals / set_majorcolor / set_minorcolor / show_grid / show_minor / show_xaxis / show_yaxis / reset_view / clear_all', 'info');
    }
    const input = document.getElementById('aiTerminalInput');
    if (input) input.focus();
  }
  function closeTerminalModal() {
    const overlay = document.getElementById('aiTerminalOverlay');
    if (overlay) overlay.classList.remove('visible');
  }
  function clearTerminal() {
    const body = document.getElementById('aiTerminalBody');
    if (body) body.innerHTML = '';
  }
  function runTerminalCommand(cmd) {
    if (!cmd.trim()) return;
    terminalEchoLine('>>> ' + cmd, 'cmd');
    terminalHistory.push(cmd);
    terminalHistoryIdx = terminalHistory.length;
    const parsed = parseCommand(cmd);
    if (!parsed) {
      terminalEchoLine('>false>> 指令解析失败', 'err');
      return;
    }
    let result;
    try {
      result = executeCommand(parsed.action, parsed.params);
    } catch (e) {
      result = { success: false, message: '执行异常: ' + e.message };
    }
    if (result && result.success) {
      terminalEchoLine('>true>> ' + (result.message || '执行成功'), 'ok');
    } else {
      terminalEchoLine('>false>> ' + ((result && result.message) || '执行失败'), 'err');
    }
    const input = document.getElementById('aiTerminalInput');
    if (input) input.value = '';
  }
  function initTerminalDialog() {
    const openBtn = document.getElementById('aiTerminalBtn');
    const closeBtn = document.getElementById('aiTerminalCloseBtn');
    const clearBtn = document.getElementById('aiTerminalClearBtn');
    const input = document.getElementById('aiTerminalInput');
    const overlay = document.getElementById('aiTerminalOverlay');
    const dialog = document.getElementById('aiTerminalDialog');
    const handle = document.getElementById('aiTerminalDragHandle');
    const resize = document.getElementById('aiTerminalResizeHandle');
    if (openBtn) openBtn.addEventListener('click', openTerminalModal);
    if (closeBtn) closeBtn.addEventListener('click', closeTerminalModal);
    if (clearBtn) clearBtn.addEventListener('click', clearTerminal);
    if (input) {
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          runTerminalCommand(input.value);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (terminalHistoryIdx > 0) {
            terminalHistoryIdx--;
            input.value = terminalHistory[terminalHistoryIdx];
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (terminalHistoryIdx < terminalHistory.length - 1) {
            terminalHistoryIdx++;
            input.value = terminalHistory[terminalHistoryIdx];
          } else {
            terminalHistoryIdx = terminalHistory.length;
            input.value = '';
          }
        }
      });
    }
    if (overlay) {
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeTerminalModal();
      });
    }
    if (!dialog) return;
    let dragging = false, offX = 0, offY = 0;
    let resizing = false, rsX = 0, rsY = 0, rsW = 0, rsH = 0;
    function onTerminalMove(e) {
      if (dragging) {
        const left = e.clientX - offX;
        const top = e.clientY - offY;
        dialog.style.left = Math.max(0, Math.min(window.innerWidth - dialog.offsetWidth, left)) + 'px';
        dialog.style.top = Math.max(NAVBAR_H, Math.min(window.innerHeight - dialog.offsetHeight, top)) + 'px';
      } else if (resizing) {
        const minW = 320, minH = 220;
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = Math.max(minW, Math.min(vw - 8, rsW + (e.clientX - rsX)));
        const h = Math.max(minH, Math.min(vh - 8, rsH + (e.clientY - rsY)));
        dialog.style.width = w + 'px';
        dialog.style.height = h + 'px';
        const rect = dialog.getBoundingClientRect();
        if (rect.right > vw) dialog.style.left = Math.max(0, vw - w) + 'px';
        if (rect.bottom > vh) dialog.style.top = Math.max(NAVBAR_H, vh - h) + 'px';
      }
    }
    function onTerminalUp() {
      dragging = false;
      resizing = false;
      document.body.style.userSelect = '';
    }
    if (handle) {
      handle.addEventListener('mousedown', function(e) {
        if (e.target.closest('button')) return;
        dragging = true;
        const rect = dialog.getBoundingClientRect();
        offX = e.clientX - rect.left;
        offY = e.clientY - rect.top;
        dialog.dataset.moved = '1';
        dialog.classList.add('moved');
        dialog.style.transform = 'none';
        e.preventDefault();
      });
    }
    if (resize) {
      resize.addEventListener('mousedown', function(e) {
        resizing = true;
        const rect = dialog.getBoundingClientRect();
        rsX = e.clientX; rsY = e.clientY; rsW = rect.width; rsH = rect.height;
        dialog.dataset.moved = '1';
        dialog.classList.add('moved');
        dialog.style.transform = 'none';
        e.preventDefault();
        e.stopPropagation();
      });
    }
    document.addEventListener('mousemove', onTerminalMove);
    document.addEventListener('mouseup', onTerminalUp);
  }

  // ---------- 快照管理 ----------
  function saveSnapshot() {
    if (isRestoring) return;
    const snapshot = {
      items: deepClone(items),
      view: deepClone(view),
      time: Date.now()
    };
    snapshots.push(snapshot);
    if (snapshots.length > snapshotMax) snapshots.shift();
    // 保存到 localStorage
    try {
      localStorage.setItem('ai_snapshots', JSON.stringify(snapshots));
    } catch(e) {}
  }

  function restoreSnapshot(index) {
    if (index < 0 || index >= snapshots.length) return;
    isRestoring = true;
    const sn = snapshots[index];
    // 恢复数据
    items = sn.items;
    Object.assign(view, sn.view);
    // 清空缓存
    cacheIdMap.clear();
    offscreenCache.clear();
    pendingHashes.clear();
    autoCentered = false;
    // 重新初始化一些状态
    selectedItemId = null;
    batchMode = false;
    batchSelected.clear();
    // 刷新 UI
    renderItemCards();
    updateItemCount();
    fullRender();
    // 刷新对话框（可选）
    addSystemMessage('? 已回退到 ' + new Date(sn.time).toLocaleString() + ' 的快照');
    isRestoring = false;
  }

  function showHistory() {
    if (snapshots.length === 0) {
      alert('暂无历史快照');
      return;
    }
    let msg = '选择要恢复的快照：\n';
    snapshots.forEach((s, i) => {
      msg += `${i}: ${new Date(s.time).toLocaleString()} (${s.items.length} 个项目)\n`;
    });
    const choice = prompt(msg + '\n输入序号 (0~' + (snapshots.length-1) + ')');
    if (choice !== null) {
      const idx = parseInt(choice);
      if (!isNaN(idx) && idx >= 0 && idx < snapshots.length) {
        restoreSnapshot(idx);
      } else {
        alert('无效序号');
      }
    }
  }

  // ---------- 状态指示器 ----------
  function setStatus(state, text) {
    const colors = {
      idle: '#22c55e',
      loading: '#f59e0b',
      requesting: '#3b82f6',
      thinking: '#8b5cf6',
      executing: '#8b5cf6',
      error: '#ef4444'
    };
    statusDot.style.background = colors[state] || '#22c55e';
    statusText.textContent = text || '空闲';
  }

  // 需求7：更新 AI 响应时间（秒）
  function updateResponseTime(startTime) {
    if (!responseTimeEl) return;
    const elapsed = (performance.now() - startTime) / 1000;
    responseTimeEl.textContent = (elapsed >= 1 ? elapsed.toFixed(1) : elapsed.toFixed(2)) + 's';
    responseTimeEl.classList.add('ready');
    responseTimeEl.title = '本次 AI 响应耗时 ' + (elapsed >= 1 ? elapsed.toFixed(1) : elapsed.toFixed(2)) + ' 秒';
  }

  // 高精度秒表：请求发起瞬间启动，实时动态刷新；请求结束立即停止并冻结
  function startStopwatch(startTime) {
    resetResponseTime();
    stopwatchStart = startTime;
    if (stopwatchTimer) clearInterval(stopwatchTimer);
    updateResponseTime(stopwatchStart);
    stopwatchTimer = setInterval(() => {
      if (stopwatchStart) updateResponseTime(stopwatchStart);
    }, 100);
  }

  function stopStopwatch() {
    if (stopwatchTimer) {
      clearInterval(stopwatchTimer);
      stopwatchTimer = null;
    }
    if (stopwatchStart) updateResponseTime(stopwatchStart);
  }

  function resetResponseTime() {
    if (stopwatchTimer) {
      clearInterval(stopwatchTimer);
      stopwatchTimer = null;
    }
    stopwatchStart = 0;
    if (!responseTimeEl) return;
    responseTimeEl.textContent = '';
    responseTimeEl.classList.remove('ready');
    responseTimeEl.classList.remove('error');
    responseTimeEl.removeAttribute('title');
  }

  // 需求三：异常/取消时响应计时文字改为红色（保留冻结时间）
  function markResponseTimeError() {
    if (!responseTimeEl) return;
    responseTimeEl.classList.add('error');
    responseTimeEl.classList.remove('ready');
    if (!responseTimeEl.textContent) responseTimeEl.textContent = '已失败';
  }

  // 需求三：AI 请求结算（统一状态切换：异常/取消 → 空闲 + 计时停止红标）
  function settleAIRequest(error, cancelled) {
    const isCancel = cancelled != null ? cancelled : aiCancelled;
    setStatus('idle', isCancel ? '已取消' : (error ? '请求失败' : '空闲'));
    clearChatStatus();
    if (isCancel || error) {
      stopStopwatch();
      markResponseTimeError();
    } else {
      stopStopwatch();
    }
  }

  // 需求8：在对话框左侧 AI 回复区域实时更新请求状态（获取上下文中 / 请求中 / 思考中）
  let chatStatusEl = null;
  function updateChatStatus(text) {
    if (!chatArea) return;
    if (!chatStatusEl || !chatStatusEl.isConnected) {
      chatStatusEl = document.createElement('div');
      chatStatusEl.style.cssText = 'align-self:flex-start;background:#f1f5f9;padding:4px 12px;border-radius:12px 12px 12px 4px;font-size:12px;color:#64748b;border:1px dashed #cbd5e1;';
      chatArea.appendChild(chatStatusEl);
    }
    chatStatusEl.textContent = text;
    chatArea.scrollTop = chatArea.scrollHeight;
  }
  function clearChatStatus() {
    if (chatStatusEl && chatStatusEl.isConnected) {
      chatStatusEl.remove();
    }
    chatStatusEl = null;
  }
  function setRequestStatus(state, text) {
    setStatus(state, text);
    updateChatStatus(text);
  }

  // ---------- 添加消息到对话区 ----------
  // Markdown 渲染：marked 未加载（CDN 失败）时降级为纯文本（转义 HTML）
  function renderMarkdown(text) {
    if (typeof text !== 'string') return '';
    if (window.marked && typeof window.marked.parse === 'function') {
      try {
        return window.marked.parse(text);
      } catch(e) {
        // 渲染异常时降级为纯文本
      }
    }
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function addMessage(role, content) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg-wrap ' + (role === 'user' ? 'user-wrap' : 'assistant-wrap');
    wrap.setAttribute('data-role', role);
    const bubble = document.createElement('div');
    bubble.className = role === 'user' ? 'ai-msg-user' : 'ai-msg-assistant';
    if (role === 'assistant') {
      // 使用 marked 渲染 Markdown（CDN 失败时降级纯文本）
      bubble.innerHTML = renderMarkdown(content);
    } else {
      bubble.textContent = content;
    }
    // 操作栏：用户右侧(时间/复制/修改)，AI左侧(复制/时分时间，无修改)
    const actions = document.createElement('div');
    actions.className = 'ai-msg-actions';
    const now = new Date();
    const time = document.createElement('span');
    time.className = 'ai-msg-time';
    time.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const copyBtn = document.createElement('button');
    copyBtn.className = 'ai-msg-action-btn';
    copyBtn.dataset.act = 'copy';
    copyBtn.textContent = '复制';
    if (role === 'user') {
      // 用户消息：右侧（时间 复制 修改）
      actions.appendChild(time);
      actions.appendChild(copyBtn);
      const editBtn = document.createElement('button');
      editBtn.className = 'ai-msg-action-btn';
      editBtn.dataset.act = 'edit';
      editBtn.textContent = '修改';
      actions.appendChild(editBtn);
    } else {
      // AI 消息：左侧（复制 时间），无修改按钮
      actions.appendChild(copyBtn);
      actions.appendChild(time);
    }
    wrap.appendChild(bubble);
    wrap.appendChild(actions);
    chatArea.appendChild(wrap);
    chatArea.scrollTop = chatArea.scrollHeight;
    return wrap;
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.style.cssText = 'background:#f1f5f9; padding:4px 10px; border-radius:4px; align-self:center; font-size:12px; color:#555; max-width:90%;';
    div.textContent = text;
    chatArea.appendChild(div);
    chatArea.scrollTop = chatArea.scrollHeight;
    return div;
  }

  // ---------- 工具卡片 ----------
  function addToolCard(command, statusText, resultText, state) {
    const card = document.createElement('div');
    card.className = `ai-tool-card ${state}`;
    const statusIcon = state === 'running' ? '?' : (state === 'success' ? '?' : '?');
    card.innerHTML = `
      <div class="status">
        <span class="status-icon">${statusIcon}</span>
        <span>${statusText}</span>
      </div>
      <div class="command">${command}</div>
      ${resultText ? `<div class="result">${resultText}</div>` : ''}
      <span class="ai-card-time"></span>
    `;
    card.querySelector('.ai-card-time').textContent = formatCardTime();
    chatArea.appendChild(card);
    chatArea.scrollTop = chatArea.scrollHeight;
    return card;
  }

  function updateToolCard(card, state, resultText) {
    const icon = state === 'running' ? '?' : (state === 'success' ? '?' : '?');
    const statusText = state === 'running' ? '执行中...' : (state === 'success' ? '执行成功' : '执行失败');
    card.className = `ai-tool-card ${state}`;
    const statusDiv = card.querySelector('.status');
    if (statusDiv) {
      statusDiv.querySelector('.status-icon').textContent = icon;
      statusDiv.querySelector('span:last-child').textContent = statusText;
    }
    if (resultText) {
      let resultDiv = card.querySelector('.result');
      if (!resultDiv) {
        resultDiv = document.createElement('div');
        resultDiv.className = 'result';
        card.appendChild(resultDiv);
      }
      resultDiv.textContent = resultText;
    }
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  // ---------- 指令解析器 ----------
  // 双词动词对（命令动词统一使用下划线形式，如 add_point、set_unit）。
  // 解析时同时兼容旧空格写法（add point）与连字符写法，统一归一为下划线。
  const TERMINAL_VERB_PAIRS = new Set([
    'set_unit', 'set_grid', 'set_minor', 'set_pointsize', 'set_precision', 'set_decimals',
    'set_majorcolor', 'set_minorcolor',
    'show_grid', 'show_minor', 'show_minorgrid', 'show_xaxis', 'show_yaxis',
    'reset_view',
    'add_function', 'add_point', 'add_param', 'add_segment', 'add_line', 'add_ray',
    'clear_all'
  ]);
  function parseCommand(cmd) {
    cmd = cmd.trim();
    // 简单分词：按空格拆分，但保留引号内的内容
    const args = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      if (ch === '"' || ch === "'") {
        inQuotes = !inQuotes;
        continue;
      }
      if (ch === ' ' && !inQuotes) {
        if (current) { args.push(current); current = ''; }
        continue;
      }
      current += ch;
    }
    if (current) args.push(current);
    if (args.length === 0) return null;
    let action = args[0].toLowerCase();
    let params = args.slice(1);
    // 双词动词归一化：add point / add-point / add_point 统一为 add_point
    if (params.length) {
      const pair = action + '_' + params[0].toLowerCase();
      if (TERMINAL_VERB_PAIRS.has(pair)) {
        action = pair;
        params = params.slice(1);
      }
    }
    return { action, params };
  }

  // ---------- 指令执行器 ----------
  // 解析 add_point 命令中的单个坐标文本（X 或 Y），自动判断类型：
  //  1. 纯数值            → fixed（固定值）
  //  2. Y 坐标匹配函数 ID  → func（函数绑定模式，仅 Y 支持）
  //  3. 代数式含参数       → param（参数表达式，参数变化时动态重算）
  //  4. 代数式不含参数     → 用 mathjs 直接求值存为固定值
  function parsePointCoordText(raw, axis, funcIdByText) {
    const text = String(raw == null ? '' : raw).trim();
    const axisName = axis === 'y' ? 'Y' : 'X';
    if (!text) return { error: axisName + ' 坐标不能为空' };
    // 1. 纯数值
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return { mode: 'fixed', value: parseFloat(text) };
    }
    // 2. Y 坐标可嵌入函数 ID（绑定函数模式）
    if (axis === 'y' && funcIdByText && funcIdByText(text)) {
      return { mode: 'func', funcId: funcIdByText(text) };
    }
    // 3/4. 代数式
    const params = detectParams(text);
    if (params.length) {
      const paramVals = getParamValues();
      const missing = params.filter(p => !(p in paramVals));
      if (missing.length) {
        return { error: axisName + ' 坐标代数式引用了不存在的参数：' + missing.join(', ') };
      }
      return { mode: 'param', expr: text };
    }
    const r = evalParamExpr(text, {});
    if (r.error) return { error: axisName + ' 坐标表达式无法计算：' + r.error };
    return { mode: 'fixed', value: r.value };
  }

  function executeCommand(action, params) {
    let result = { success: false, message: '未知指令' };
    try {
      switch (action) {
        // ---------- 视图设置（动词下划线形式：set_unit、set_grid ...） ----------
        case 'set_unit': {
          if (params.length < 1) { result.message = '用法: set_unit <值>'; break; }
          view.gridUnitLength = parseFloat(params[0]) || 5;
          updateDisplayValues();
          fullRender();
          result = { success: true, message: `单位长度已设置为 ${view.gridUnitLength}` };
          break;
        }
        case 'set_grid': {
          if (params.length < 1) { result.message = '用法: set_grid <值>'; break; }
          view.gridPixelSize = parseFloat(params[0]) || 3;
          updateDisplayValues();
          fullRender();
          result = { success: true, message: `网格大小已设置为 ${view.gridPixelSize}` };
          break;
        }
        case 'set_minor': {
          if (params.length < 1) { result.message = '用法: set_minor <值>'; break; }
          view.minorGridSteps = parseInt(params[0]) || 5;
          updateDisplayValues();
          fullRender();
          result = { success: true, message: `小网格边长已设置为 ${view.minorGridSteps}` };
          break;
        }
        case 'set_pointsize': {
          if (params.length < 1) { result.message = '用法: set_pointsize <值>'; break; }
          view.pointSize = parseFloat(params[0]) || 4;
          fullRender();
          result = { success: true, message: `点大小已设置为 ${view.pointSize}` };
          break;
        }
        case 'set_precision': {
          if (params.length < 1) { result.message = '用法: set_precision <值>'; break; }
          view.renderPrecision = parseFloat(params[0]) || 0.01;
          fullRender();
          result = { success: true, message: `渲染精度已设置为 ${view.renderPrecision}` };
          break;
        }
        case 'set_decimals': {
          if (params.length < 1) { result.message = '用法: set_decimals <值>'; break; }
          view.decimalPlaces = parseInt(params[0]) || 2;
          updateCoordDisplay();
          fullRender();
          result = { success: true, message: `小数位数已设置为 ${view.decimalPlaces}` };
          break;
        }
        case 'set_majorcolor': {
          if (params.length < 1) { result.message = '用法: set_majorcolor <颜色>'; break; }
          // 设置主网格颜色，需要更新DOM和重绘
          document.getElementById('majorGridColor').value = params[0];
          fullRender();
          result = { success: true, message: `主网格颜色已设置为 ${params[0]}` };
          break;
        }
        case 'set_minorcolor': {
          if (params.length < 1) { result.message = '用法: set_minorcolor <颜色>'; break; }
          document.getElementById('minorGridColor').value = params[0];
          fullRender();
          result = { success: true, message: `细分网格颜色已设置为 ${params[0]}` };
          break;
        }

        case 'show_grid': {
          if (params.length < 1) { result.message = '用法: show_grid on|off'; break; }
          const bool = params[0].toLowerCase() === 'on' || params[0].toLowerCase() === 'true' || params[0] === '1';
          document.getElementById('showGrid').checked = bool;
          document.getElementById('showGridSetting').checked = bool;
          toggleGrid();
          result = { success: true, message: `网格已${bool ? '显示' : '隐藏'}` };
          break;
        }
        case 'show_minor':
        case 'show_minorgrid': {
          if (params.length < 1) { result.message = '用法: show_minor on|off'; break; }
          const bool = params[0].toLowerCase() === 'on' || params[0].toLowerCase() === 'true' || params[0] === '1';
          document.getElementById('showMinorGrid').checked = bool;
          document.getElementById('showMinorGridSetting').checked = bool;
          toggleMinorGrid();
          result = { success: true, message: `小网格已${bool ? '显示' : '隐藏'}` };
          break;
        }
        case 'show_xaxis': {
          if (params.length < 1) { result.message = '用法: show_xaxis on|off'; break; }
          const bool = params[0].toLowerCase() === 'on' || params[0].toLowerCase() === 'true' || params[0] === '1';
          document.getElementById('hideXAxis').checked = !bool;
          document.getElementById('hideXAxisSetting').checked = !bool;
          toggleAxis();
          result = { success: true, message: `X轴已${bool ? '显示' : '隐藏'}` };
          break;
        }
        case 'show_yaxis': {
          if (params.length < 1) { result.message = '用法: show_yaxis on|off'; break; }
          const bool = params[0].toLowerCase() === 'on' || params[0].toLowerCase() === 'true' || params[0] === '1';
          document.getElementById('hideYAxis').checked = !bool;
          document.getElementById('hideYAxisSetting').checked = !bool;
          toggleAxis();
          result = { success: true, message: `Y轴已${bool ? '显示' : '隐藏'}` };
          break;
        }

        case 'reset_view':
          resetView();
          result = { success: true, message: '视图已重置' };
          break;

        // ---------- 项目操作 ----------
        case 'add_function': {
          const expr = params.join(' ');
          if (!expr) { result.message = '用法: add_function <表达式>'; break; }
          const color = nextColor(['#6366f1','#22c55e','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#f97316']);
          const item = { id: nextItemId('function'), type: 'function', expr: expr, color, hidden: false };
          items.push(item);
          selectItem(item.id);
          renderItemCards();
          updateItemCount();
          fullRender();
          result = { success: true, message: `已添加函数: ${expr}` };
          break;
        }
        case 'add_point': {
          if (params.length < 2) { result.message = '用法: add_point <x> <y> [label]'; break; }
          const funcIdByText = t => { const f = items.find(i => i.type === 'function' && i.id === t); return f ? f.id : null; };
          const rx = parsePointCoordText(params[0], 'x');
          const ry = params.length > 1 ? parsePointCoordText(params[1], 'y', funcIdByText) : null;
          if (rx.error || (ry && ry.error)) { result.message = '添加坐标点失败：' + (rx.error || ry.error); break; }
          const label = params[2] || nextPointLabel();
          const color = nextColor(['#ef4444','#22c55e','#3b82f6','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#f97316']);
          const item = { id: nextItemId('point'), type: 'point', label, color, hidden: false };
          // X 轴：fixed（数值/无参代数式求值）或 param（含参代数式）
          if (rx.mode === 'param') { item.xMode = 'param'; item.xParamExpr = rx.expr; }
          else { item.xMode = 'fixed'; item.xFixed = rx.value; item.x = rx.value; }
          // Y 轴：fixed / param / func（函数绑定）
          if (ry.mode === 'func') { item.yMode = 'func'; item.yFuncId = ry.funcId; }
          else if (ry.mode === 'param') { item.yMode = 'param'; item.yParamExpr = ry.expr; }
          else { item.yMode = 'fixed'; item.yFixed = ry.value; item.y = ry.value; }
          items.push(item);
          selectItem(item.id);
          renderItemCards();
          updateItemCount();
          fullRender();
          const fmtMode = m => m === 'fixed' ? '固定数值' : m === 'param' ? '参数表达式' : '函数绑定';
          result = { success: true, message: `已添加坐标点 ${label}（X:${rx.mode === 'param' ? rx.expr : rx.value}·${fmtMode(rx.mode)}，Y:${ry.mode === 'func' ? ry.funcId : ry.mode === 'param' ? ry.expr : ry.value}·${fmtMode(ry.mode)}）` };
          break;
        }
        case 'add_param': {
          if (params.length < 4) { result.message = '用法: add_param <名称> <min> <max> <step> [初始值]'; break; }
          const name = params[0];
          const min = parseFloat(params[1]);
          const max = parseFloat(params[2]);
          const step = parseFloat(params[3]);
          const value = params.length > 4 ? parseFloat(params[4]) : min;
          if (isNaN(min) || isNaN(max) || isNaN(step) || isNaN(value)) { result.message = '参数值必须为数字'; break; }
          const item = { id: nextItemId('param'), type: 'param', name, min, max, step, value, hidden: false };
          items.push(item);
          selectItem(item.id);
          renderItemCards();
          updateItemCount();
          fullRender();
          result = { success: true, message: `已添加参数 ${name}` };
          break;
        }
        case 'add_segment':
        case 'add_line':
        case 'add_ray': {
          const type = action.substring(4);
          if (params.length < 2) { result.message = `用法: ${action} <点A标签> <点B标签>`; break; }
          const labelA = params[0];
          const labelB = params[1];
          const pA = items.find(p => p.type === 'point' && p.label === labelA);
          const pB = items.find(p => p.type === 'point' && p.label === labelB);
          if (!pA || !pB) { result.message = '找不到对应的坐标点，请确保标签正确'; break; }
          const color = ['#16a34a','#dc2626','#ca8a04'][['segment','line','ray'].indexOf(type)];
          const label = nextSegmentLabel();
          const item = {
            id: nextItemId(type),
            type: type,
            pointA: pA,
            pointB: pB,
            color: color,
            hidden: false,
            label: label,
            midX: (pA.x+pB.x)/2,
            midY: (pA.y+pB.y)/2,
            length: Math.hypot(pB.x-pA.x, pB.y-pA.y)
          };
          items.push(item);
          selectItem(item.id);
          renderItemCards();
          updateItemCount();
          fullRender();
          result = { success: true, message: `已添加${type} ${label} (${labelA}→${labelB})` };
          break;
        }

        case 'delete': {
          if (params.length < 1) { result.message = '用法: delete <ID>'; break; }
          const id = params[0];
          const targetItem = items.find(it => it.id === id);
          if (!targetItem) { result.message = `找不到项目 ID: ${id}`; break; }
          // 调用删除函数（会处理依赖）
          removeItem(id);
          result = { success: true, message: `已删除项目 ${id}` };
          break;
        }

        case 'hide': {
          if (params.length < 1) { result.message = '用法: hide <ID>'; break; }
          const hideId = params[0];
          const hideItem = items.find(it => it.id === hideId);
          if (!hideItem) { result.message = `找不到项目 ID: ${hideId}`; break; }
          hideItem.hidden = true;
          renderItemCards();
          fullRender();
          result = { success: true, message: `已隐藏项目 ${hideId}` };
          break;
        }

        case 'showitem': {
          if (params.length < 1) { result.message = '用法: showitem <ID>'; break; }
          const showId = params[0];
          const showItem = items.find(it => it.id === showId);
          if (!showItem) { result.message = `找不到项目 ID: ${showId}`; break; }
          showItem.hidden = false;
          renderItemCards();
          fullRender();
          result = { success: true, message: `已显示项目 ${showId}` };
          break;
        }

        case 'setcolor': {
          if (params.length < 2) { result.message = '用法: setcolor <ID> <颜色>'; break; }
          const colorId = params[0];
          const colorVal = params[1];
          const colorItem = items.find(it => it.id === colorId);
          if (!colorItem) { result.message = `找不到项目 ID: ${colorId}`; break; }
          colorItem.color = colorVal;
          fullRender();
          result = { success: true, message: `已更新项目 ${colorId} 的颜色` };
          break;
        }

        case 'setlabel': {
          if (params.length < 2) { result.message = '用法: setlabel <ID> <新标签>'; break; }
          const labelId = params[0];
          const newLabel = params[1];
          const labelItem = items.find(it => it.id === labelId);
          if (!labelItem) { result.message = `找不到项目 ID: ${labelId}`; break; }
          if (labelItem.type === 'point') {
            labelItem.label = newLabel;
          } else if (labelItem.type === 'segment' || labelItem.type === 'line' || labelItem.type === 'ray') {
            labelItem.label = newLabel;
          } else {
            result.message = '该项目不支持修改标签';
            break;
          }
          renderItemCards();
          fullRender();
          result = { success: true, message: `已更新项目 ${labelId} 的标签为 ${newLabel}` };
          break;
        }

        case 'clear_all':
          items = [];
          selectedItemId = null;
          renderItemCards();
          updateItemCount();
          fullRender();
          result = { success: true, message: '已清空所有项目' };
          break;

        default:
          result.message = `未知指令: ${action}`;
      }
    } catch (e) {
      result.message = '执行错误: ' + e.message;
    }
    return result;
  }

  // ---------- 处理 AI 回复 ----------
  function handleAIResponse(text, skipTextRender) {
    // 提取命令块 (```command ... ```)
    const commandRegex = /```command\s*([\s\S]*?)```/g;
    let match;
    let lastIndex = 0;
    const promises = [];

    // 先分割文本，保留非命令部分
    const parts = [];
    let cmdMatch;
    while ((cmdMatch = commandRegex.exec(text)) !== null) {
      const before = text.substring(lastIndex, cmdMatch.index);
      if (before.trim()) parts.push({ type: 'text', content: before });
      const cmd = cmdMatch[1].trim();
      if (cmd) parts.push({ type: 'command', content: cmd });
      lastIndex = cmdMatch.index + cmdMatch[0].length;
    }
    if (lastIndex < text.length) {
      const remaining = text.substring(lastIndex);
      if (remaining.trim()) parts.push({ type: 'text', content: remaining });
    }

    // 如果没有命令，直接渲染文本
    if (!parts.some(p => p.type === 'command')) {
      if (!skipTextRender) addMessage('assistant', text);
      return;
    }

    // 有命令：按顺序处理，每个命令生成卡片
    let currentCard = null;
    let executeIndex = 0;

    function processNext() {
      if (executeIndex >= parts.length) {
        // 所有部分处理完毕
        return;
      }
      const part = parts[executeIndex];
      if (part.type === 'text') {
        // 流式已渲染时跳过文本，避免重复
        if (!skipTextRender) addMessage('assistant', part.content);
        executeIndex++;
        processNext();
        return;
      }
      // 命令部分
      const cmd = part.content;
      // 保存快照
      saveSnapshot();
      // 创建卡片（执行中）
      const card = addToolCard(cmd, '执行中...', '', 'running');
      // 执行命令
      try {
        const parsed = parseCommand(cmd);
        let result;
        if (!parsed) {
          result = { success: false, message: '指令解析失败' };
        } else {
          result = executeCommand(parsed.action, parsed.params);
        }
        // 更新卡片
        const state = result.success ? 'success' : 'error';
        updateToolCard(card, state, result.message);
      } catch (e) {
        updateToolCard(card, 'error', '执行异常: ' + e.message);
      }
      executeIndex++;
      // 继续处理下一个
      processNext();
    }

    processNext();
  }

  // ==================== 需求：五步分步执行架构 ====================

  function sleep(ms) {
    return new Promise((resolve, reject) => {
      if (aiCancelled) { reject(new AIAbortError()); return; }
      const t = setTimeout(() => { aiSleepCanceller = null; resolve(); }, ms);
      aiSleepCanceller = () => { clearTimeout(t); aiSleepCanceller = null; reject(new AIAbortError()); };
    });
  }

  // ---------- 第1步：免费模型分类（不带 conversation_id） ----------
  // 返回 '指令执行' | '普通问答' | null(失败)
  async function classifyRequest(userMessage) {
    // 使用第4项「AI判定守则」（可自定义，占位符 {user_query} 用户请求、{has_saved_steps} 是否已有可继续执行的保存步骤）
    const classifyRule = (aiSettings.classifyPrompt && aiSettings.classifyPrompt.trim()) ? aiSettings.classifyPrompt : DEFAULT_CLASSIFY_RULE;
    const hasSaved = !!(continueStepsData && continueStepsData.plan && Array.isArray(continueStepsData.plan.steps) && continueStepsData.plan.steps.length);
    const promptText = classifyRule
      .replace(/\{user_query\}/g, userMessage)
      .replace(/\{has_saved_steps\}/g, hasSaved ? '存在未完成的已保存执行步骤' : '不存在已保存的执行步骤');
    try {
      // 不带记忆，产生独立会话
      const result = await callMemoryHost(promptText, '');
      if (!result || !result.context) return null;
      const text = String(result.context).trim();
      if (hasSaved && text.includes('继续执行')) return '继续执行';
      if (text.includes('指令执行')) return '指令执行';
      if (text.includes('普通问答')) return '普通问答';
      return null;
    } catch (e) {
      // 需求三：取消请求必须透传，不能吞掉中断信号
      if (e && (e.name === AI_ABORT_NAME || (e.name === 'AbortError' && aiCancelled))) throw e;
      return null;
    }
  }

  // ---------- 第2步：免费模型输出执行计划（表格 + //#//&// + 两段 JSON） ----------
  // 新建独立执行会话 ID；格式不合法自动重试（最多3次）
  function extractJsonArrayFromSegment(seg) {
    // 尝试直接解析，或从代码块中提取
    let s = seg.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    // 找到第一个 [ 和最后一个 ] 之间的内容
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(s.substring(start, end + 1)); } catch(e) { return null; }
  }

  function parseExecutionPlan(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    // 分隔符 //#//&//
    const sep = '//#//&//';
    let idx = text.indexOf(sep);
    if (idx < 0) return null;
    const tableText = text.substring(0, idx).trim();
    let rest = text.substring(idx + sep.length);
    idx = rest.indexOf(sep);
    if (idx < 0) return null;
    const json1Text = rest.substring(0, idx).trim();
    const json2Text = rest.substring(idx + sep.length).trim();
    // 提取表格（Markdown 表格部分，表头固定：步骤序号 | 步骤内容 | 工具名）
    let tableHtml = '';
    const tableMatch = tableText.match(/\|[\s\S]*\|/);
    if (tableMatch) tableHtml = renderMarkdown(tableMatch[0].trim());
    // 需求四第2步：第一段 = 步骤数据 [{"step":序号,"note":"说明"}]，第二段 = 工具数据 [{"step":序号,"tool":[OpenAI function 对象]}]
    const stepData = extractJsonArrayFromSegment(json1Text);
    const toolData = extractJsonArrayFromSegment(json2Text);
    if (!Array.isArray(stepData) || !Array.isArray(toolData)) return null;
    // 校验步骤结构：必须含 step 序号
    const validSteps = stepData.filter(s => s && typeof s === 'object' && s.step != null && (s.note != null || s.step !== undefined));
    if (!validSteps.length) return null;
    // 校验工具结构：每项含 step 序号，tool 为标准 OpenAI function 对象数组 或 tool_idx 为数字序号数组
    const validTools = toolData.filter(t => t && typeof t === 'object' && t.step != null && (Array.isArray(t.tool) || Array.isArray(t.tool_idx)));
    if (!validTools.length) return null;
    // 归一化 step 为数字序号（记忆模型可能输出字符串序号，统一转数字避免类型不匹配导致工具查找失败）
    validSteps.forEach(s => { s.step = Number(s.step); });
    validTools.forEach(t => { t.step = Number(t.step); });
    validSteps.sort((a,b) => a.step - b.step);
    validTools.sort((a,b) => a.step - b.step);
    return { tableHtml: tableHtml || '', tableText: tableText || '', tools: validTools, steps: validSteps };
  }

  async function createExecutionPlan(userMessage) {
    const system = aiSettings.systemPrompt || '';
    // 发给记忆模型的工具列表 = 带序号+说明的简易列表（不含工具执行内容），记忆模型据此输出 tool_idx
    const toolJson = JSON.stringify(getSimpleToolList());
    let promptText = '';
    if (aiSettings.stepsFormat && aiSettings.stepsFormat.trim()) {
      // 用户自定义守则：替换占位符
      promptText = aiSettings.stepsFormat
        .replace(/\{tools_json\}/g, toolJson)
        .replace(/\{user_query\}/g, userMessage);
    } else {
      // 默认守则：替换占位符（含可选系统守则）
      const systemRule = system ? '【系统守则】\n' + system + '\n' : '';
      promptText = DEFAULT_STEPS_FORMAT
        .replace(/\{system_rule\}/g, systemRule)
        .replace(/\{tools_json\}/g, toolJson)
        .replace(/\{user_query\}/g, userMessage);
    }
    pushAILog('request', '规划：发送工具列表给记忆模型', {
      简易工具列表数量: getSimpleToolList().length,
      完整工具数组数量: getFullToolList().length,
      工具序号范围: '0 ~ ' + (getSimpleToolList().length - 1),
      已用简易列表: (aiSimpleToolList && aiSimpleToolList.length) > 0
    }, '工具数组解析');
    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
      const result = await callMemoryHost(promptText, '');
        if (!result || !result.context) { lastErr = '无返回内容'; continue; }
        const parsed = parseExecutionPlan(result.context);
        if (parsed) {
          pushAILog('response', '规划：记忆模型步骤解析成功', {
            步骤数: parsed.steps.length,
            工具条目数: parsed.tools.length,
            工具条目: parsed.tools.map(t => ({ step: t.step, tool_idx: t.tool_idx || null, tool字段条数: (Array.isArray(t.tool) ? t.tool.length : 0) }))
          }, '工具数组解析');
          return { convId: result.convId || '', tableHtml: parsed.tableHtml, tableText: parsed.tableText, tools: parsed.tools, steps: parsed.steps, raw: result.context };
        }
        lastErr = '输出格式不合法';
        pushAILog('error', '规划：记忆模型输出解析失败(尝试' + attempt + '/3)', { 错误: '输出格式不合法', 原文: String(result.context).slice(0, 800) }, '工具数组解析');
      } catch (e) {
        // 需求三：取消请求必须透传，中断重试循环
        if (e && (e.name === AI_ABORT_NAME || (e.name === 'AbortError' && aiCancelled))) throw e;
        lastErr = e.message;
        pushAILog('error', '规划：记忆模型请求失败(尝试' + attempt + '/3)', { 错误: e.message }, '工具数组解析');
      }
    }
    return { error: lastErr, convId: '', tableHtml: '', tools: [], steps: [] };
  }

  // ---------- 第3步：免费模型带执行会话 ID 发送用户原始需求 ----------
  async function sendPlanContext(convId, userMessage) {
    if (!convId) return;
    const content = '请记录以下用户需求，作为本次执行会话的上下文。之后若被问到请基于它回答：\n' + userMessage;
    try {
      await callMemoryHost(content, convId);
    } catch (e) {
      // 需求三：取消请求必须透传
      if (e && (e.name === AI_ABORT_NAME || (e.name === 'AbortError' && aiCancelled))) throw e;
    }
  }

  // ---------- 步骤卡片渲染 ----------
  function addStepCard(title, container) {
    const card = document.createElement('div');
    card.className = 'ai-step-card pending';
    card.innerHTML = `
      <div class="ai-step-head">
        <span class="ai-step-icon">&#9675;</span>
        <span class="ai-step-title"></span>
        <span class="ai-step-status">待执行</span>
        <button class="ai-card-toggle" type="button">展开</button>
      </div>
      <div class="ai-step-body" style="display:none;"></div>
      <span class="ai-card-time"></span>`;
    card.querySelector('.ai-step-title').textContent = title || '执行步骤';
    card.querySelector('.ai-card-time').textContent = formatCardTime();
    (container || chatArea).appendChild(card);
    chatArea.scrollTop = chatArea.scrollHeight;
    bindCardToggle(card);
    return card;
  }

  function formatCardTime() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
  }

  // ---------- 需求一.3.4：顶部步骤状态卡（对话区下方/输入框上方，横向） ----------
  function showStepsBar(steps) {
    if (!aiStepsBar) return;
    aiStepsBar.innerHTML = '';
    if (!Array.isArray(steps) || !steps.length) {
      aiStepsBar.classList.remove('show');
      return;
    }
    steps.forEach(s => {
      const no = (s && typeof s.step === 'number' && !isNaN(s.step)) ? s.step : (aiStepsBar.children.length + 1);
      const note = (s && typeof s.note === 'string' && s.note) ? s.note : ('步骤 ' + no);
      const card = document.createElement('div');
      card.className = 'ai-step-status-card pending';
      card.dataset.step = String(no);
      const idx = document.createElement('span');
      idx.className = 'ssc-idx';
      idx.textContent = String(no);
      const noteEl = document.createElement('span');
      noteEl.className = 'ssc-note';
      noteEl.textContent = note;
      noteEl.title = note;
      const stateEl = document.createElement('span');
      stateEl.className = 'ssc-state';
      stateEl.textContent = '待执行';
      card.appendChild(idx);
      card.appendChild(noteEl);
      card.appendChild(stateEl);
      aiStepsBar.appendChild(card);
    });
    aiStepsBar.classList.add('show');
  }

  function updateStepsBarState(stepNo, state) {
    if (!aiStepsBar) return;
    const card = aiStepsBar.querySelector('.ai-step-status-card[data-step="' + stepNo + '"]');
    if (!card) return;
    card.className = 'ai-step-status-card ' + state;
    const st = card.querySelector('.ssc-state');
    if (st) {
      st.textContent = state === 'pending' ? '待执行' : state === 'running' ? '执行中...' : state === 'success' ? '完成' : '失败';
    }
  }

  function hideStepsBar() {
    if (aiStepsBar) aiStepsBar.classList.remove('show');
  }

  function updateStepCard(card, state, statusText) {
    if (!card) return;
    card.className = 'ai-step-card ' + state;
    const iconMap = { pending: '○', running: '●', success: '✓', error: '✕' };
    card.querySelector('.ai-step-icon').textContent = iconMap[state] || '○';
    const st = card.querySelector('.ai-step-status');
    if (statusText) {
      // 收起时统一展示执行情况（执行中 / 执行失败 / 执行完成），详细内容在展开区
      let t = statusText;
      if (t === '执行中...') t = '执行中';
      else if (t === '完成' || t === '完成（普通回复）') t = '执行完成';
      else if (/失败|中止|无有效|未收到|无工具/.test(t)) t = '执行失败';
      st.textContent = t;
    }
    else st.textContent = state === 'pending' ? '待执行' : state === 'running' ? '执行中' : state === 'success' ? '执行完成' : '执行失败';
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function appendStepCommand(card, command) {
    if (!card) return;
    const body = card.querySelector('.ai-step-body');
    if (!body) return;
    const div = document.createElement('div');
    div.className = 'ai-step-command';
    div.textContent = command;
    body.appendChild(div);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function appendStepResult(card, resultText, ok) {
    if (!card) return;
    const body = card.querySelector('.ai-step-body');
    if (!body) return;
    const div = document.createElement('div');
    div.className = 'ai-step-result';
    div.style.color = ok === false ? '#dc2626' : '#16a34a';
    div.textContent = (ok === false ? '✕ ' : '✓ ') + resultText;
    body.appendChild(div);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  // ---------- 第5步：tool_call / 代码块 → 终端指令，按 ; 切分，单段延迟 2~3s ----------
  // 执行一组指令文本（多条用 ; 分隔），逐段延迟 2~3s
  async function executeSegmentedCommand(card, cmdText) {
    const segments = String(cmdText).split(';').map(s => s.trim()).filter(Boolean);
    if (!segments.length) {
      appendStepResult(card, '指令为空', false);
      pushAILog('error', '模拟终端：指令为空', { 指令: String(cmdText) }, '模拟终端');
      return false;
    }
    for (const seg of segments) {
      updateStepCard(card, 'running', '执行中...');
      appendStepCommand(card, seg);
      pushAILog('request', '模拟终端：执行指令', { 指令: seg }, '模拟终端');
      // 强制延迟 2~3s 模拟程序运行时序
      const delay = 2000 + Math.floor(Math.random() * 1000);
      await sleep(delay);
      let result;
      try {
        const parsed = parseCommand(seg);
        result = parsed ? executeCommand(parsed.action, parsed.params) : { success: false, message: '指令解析失败' };
      } catch (e) {
        result = { success: false, message: '执行异常: ' + e.message };
      }
      appendStepResult(card, result.message, result.success);
      pushAILog(result.success ? 'response' : 'error', '模拟终端：指令执行' + (result.success ? '成功' : '失败'), {
        指令: seg,
        成功: result.success,
        结果: result.message
      }, '模拟终端');
      if (!result.success) {
        updateStepCard(card, 'error', '执行失败，已中止');
        return false;
      }
    }
    updateStepCard(card, 'success', '完成');
    return true;
  }

  // ---------- 需求：步骤工具数组解析（AI 返回工具序号 → 从总工具数组截取） ----------
  // 兼容两种格式：tool_idx 数字序号数组（0起始，新守则）；tool 完整工具对象数组（旧守则）。
  // 序号无效/越界/未提供时回退为全部总工具数组；最后强制附加两个只读数据工具。
  // 解析过程记录到 AI 日志（分类：工具数组解析），便于诊断工具嵌入错误。
  function resolveStepTools(plan, stepNo) {
    const fullList = getFullToolList();
    const fullNames = fullList.map(t => (t.function && t.function.name) || t.name || '');
    let tools = null;
    let pickInfo = '';
    let fallbackReason = '';
    const target = Number(stepNo);
    if (plan && Array.isArray(plan.tools)) {
      const entry = plan.tools.find(t => t && Number(t.step) === target);
      if (entry) {
        if (Array.isArray(entry.tool_idx) && entry.tool_idx.length) {
          // 新格式：数字序号数组（0起始），兼容数字字符串
          const picked = [];
          let valid = false;
          const invalidIdx = [];
          for (const idx of entry.tool_idx) {
            const num = Number(idx);
            if (!isNaN(num) && num >= 0 && num < fullList.length) {
              picked.push(fullList[num]);
              valid = true;
            } else {
              invalidIdx.push(idx);
            }
          }
          tools = valid ? picked : null;
          pickInfo = 'tool_idx=[' + entry.tool_idx.join(',') + ']';
          if (invalidIdx.length) fallbackReason = '存在无效序号[' + invalidIdx.join(',') + ']';
          if (!valid) fallbackReason = 'tool_idx 全部无效，回退为全部工具';
        } else if (Array.isArray(entry.tool) && entry.tool.length) {
          if (entry.tool.every(t => !isNaN(Number(t)) && typeof t !== 'object')) {
            // 兼容：tool 字段内容为数字序号数组
            const picked = [];
            let valid = false;
            const invalidIdx = [];
            for (const idx of entry.tool) {
              const num = Number(idx);
              if (!isNaN(num) && num >= 0 && num < fullList.length) {
                picked.push(fullList[num]);
                valid = true;
              } else {
                invalidIdx.push(idx);
              }
            }
            tools = valid ? picked : null;
            pickInfo = 'tool(数字序号)=[' + entry.tool.join(',') + ']';
            if (!valid) fallbackReason = 'tool 序号全部无效，回退为全部工具';
            else if (invalidIdx.length) fallbackReason = '存在无效序号[' + invalidIdx.join(',') + ']';
          } else {
            // 旧格式：完整工具对象数组
            tools = normalizeToolList(entry.tool).filter(t => t && t.function && t.function.name);
            pickInfo = 'tool(完整对象)=' + tools.length + ' 个';
            if (!tools.length) { tools = null; fallbackReason = 'tool 完整对象解析为空，回退为全部工具'; }
          }
        } else {
          fallbackReason = '步骤 ' + target + ' 的 tool_idx/tool 为空';
        }
      } else {
        fallbackReason = '未找到步骤 ' + target + ' 的工具条目';
      }
    } else {
      fallbackReason = '无工具数据';
    }
    if (!tools || !tools.length) tools = cloneToolList(fullList);
    // 强制附加两个只读数据工具（去重，保证每个步骤都可获取项目数据/知识库）
    const names = new Set(tools.map(t => (t.function && t.function.name) || t.name).filter(Boolean));
    for (const t of APPENDED_TOOL_LIST) {
      const nm = (t.function && t.function.name) || t.name;
      if (!names.has(nm)) {
        tools.push(JSON.parse(JSON.stringify(t)));
        names.add(nm);
      }
    }
    const resultNames = tools.map(t => (t.function && t.function.name) || t.name || '');
    const fellBack = !pickInfo || /回退为全部/.test(fallbackReason);
    pushAILog('response', '步骤' + target + '：工具数组解析完成', {
      步骤: target,
      来源: pickInfo || '（无条目）',
      回退原因: fallbackReason || '（无）',
      是否回退全部: fellBack,
      工具数量: resultNames.length,
      取到的工具: resultNames
    }, '工具数组解析');
    return tools;
  }

  // 归一化 tool_call（补齐 id/type，供多轮工具回传使用）
  function normalizeToolCall(call, index) {
    return {
      id: call.id || ('call_' + index),
      type: call.type || 'function',
      function: {
        name: (call.function && call.function.name) || call.name || '',
        arguments: (call.function && call.function.arguments) || call.arguments || '{}'
      }
    };
  }

  // 从模型回复文本中解析 DeepSeek 自研的 DSML 工具调用格式
  // 示例：
  //   <｜DSML｜function_calls>
  //   <｜DSML｜invoke name="clear_all">
  //   {"expr":"..."}
  //   </｜DSML｜invoke>
  //   </｜DSML｜function_calls>
  // 兼容全角竖线 ｜ 与半角竖线 |；无参数时 arguments 留空。返回标准 tool_call 数组，无匹配返回 null。
  function extractDSMLToolCalls(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const calls = [];
    const blockRe = /<[｜|]DSML[｜|]function_calls>([\s\S]*?)<\/[｜|]DSML[｜|]function_calls>/gi;
    let bm;
    while ((bm = blockRe.exec(text)) !== null) {
      const inner = bm[1];
      const invokeRe = /<[｜|]DSML[｜|]invoke name="([^"]*)"[^>]*>([\s\S]*?)<\/[｜|]DSML[｜|]invoke>/gi;
      let im;
      while ((im = invokeRe.exec(inner)) !== null) {
        const name = (im[1] || '').trim();
        if (!name) continue;
        let argsRaw = (im[2] || '').trim();
        const fence = argsRaw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) argsRaw = fence[1].trim();
        let argsStr = argsRaw || '{}';
        try {
          const parsed = JSON.parse(argsRaw);
          argsStr = parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : argsRaw;
        } catch (e) {}
        calls.push({
          id: 'dsml_call_' + calls.length,
          type: 'function',
          function: { name: name, arguments: argsStr }
        });
      }
    }
    return calls.length ? calls : null;
  }

  // 从 SSE 流式 chunk 的 usage 字段中提取 token 统计（DeepSeek 通常在流末尾的 usage chunk）
  function extractUsage(obj) {
    if (obj && obj.usage && typeof obj.usage === 'object') {
      return {
        prompt_tokens: obj.usage.prompt_tokens,
        completion_tokens: obj.usage.completion_tokens,
        total_tokens: obj.usage.total_tokens
      };
    }
    return null;
  }

  // 是否为只读数据工具（不执行终端命令，直接返回数据文本并回传给 AI）
  function isDataToolName(name) {
    return name === 'get_project_data' || name === 'get_knowledge_base';
  }

  // 数据工具返回内容
  function getDataToolResult(name) {
    if (name === 'get_project_data') return buildProjectDataText();
    if (name === 'get_knowledge_base') return '（知识库功能正在建设中，当前暂无内容可返回。如需了解画布内容，请调用 get_project_data 获取项目数据。）';
    return '（未知数据工具）';
  }

  // ---------- 需求：步骤历史上下文（已完成 / 当前 / 未完成） ----------
  // 每一步请求对话模型时，把整个执行计划进度作为上下文嵌套进提示
  function buildStepsContext(completed, currentStep, remaining) {
    const lines = [];
    lines.push('【当前执行任务进度】');
    if (completed.length) {
      lines.push('已完成步骤：');
      completed.forEach((c, i) => {
        const st = c.step;
        const no = (typeof st.step === 'number' && !isNaN(st.step)) ? st.step : (i + 1);
        const note = (typeof st.note === 'string' && st.note) ? st.note : ('步骤 ' + no);
        const toolInfo = (c.tools && c.tools.length) ? '（使用工具：' + c.tools.join('、') + '）' : '';
        lines.push((i + 1) + '. ' + note + toolInfo + ' —— ' + (c.ok ? '执行成功' : '执行失败'));
      });
    } else {
      lines.push('已完成步骤：无');
    }
    const curNo = (typeof currentStep.step === 'number' && !isNaN(currentStep.step)) ? currentStep.step : (completed.length + 1);
    const curNote = (typeof currentStep.note === 'string' && currentStep.note) ? currentStep.note : ('步骤 ' + curNo);
    lines.push('当前步骤：' + curNote);
    if (remaining.length) {
      lines.push('未完成步骤：');
      remaining.forEach((st, i) => {
        const no = (typeof st.step === 'number' && !isNaN(st.step)) ? st.step : (completed.length + 2 + i);
        const note = (typeof st.note === 'string' && st.note) ? st.note : ('步骤 ' + no);
        lines.push((i + 1) + '. ' + note);
      });
    } else {
      lines.push('未完成步骤：无');
    }
    return lines.join('\n');
  }

  // 需求：每一步执行完成后写入记忆模型（步骤内容 + 执行结果），供后续对话延续记忆
  async function persistStepMemory(step, ok) {
    try {
      const host = getMemoryHostModel();
      if (!host || host.memoryMode === 'none') return;
      if (!memoryId) {
        await ensureMemoryId();
        if (!memoryId) return;
      }
      const stepNo = (typeof step.step === 'number' && !isNaN(step.step)) ? step.step : 0;
      const note = (typeof step.note === 'string' && step.note) ? step.note : ('步骤 ' + stepNo);
      const text = '【函数绘制器 AI 执行步骤记录】\n步骤 ' + stepNo + '：' + note + '\n执行结果：' + (ok ? '成功' : '失败');
      await callMemoryHost(text, 'auto');
    } catch (e) {
      // 记忆写入失败不影响步骤执行
    }
  }

  // 执行付费模型返回的 tool_calls（标准 OpenAI tool call）
  // 执行期间工具卡保持收起、标签显示 busy，执行完毕收起时标签显示完整命令文本
  async function executeToolCalls(card, toolCalls) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) {
      updateStepCard(card, 'error', '未收到工具调用');
      pushAILog('error', '模拟终端：未收到工具调用', { 步骤卡: !!card }, '模拟终端');
      return false;
    }
    pushAILog('request', '模拟终端：收到 ' + toolCalls.length + ' 个工具调用', {
      工具: toolCalls.map(c => (c.function && c.function.name) || c.name || '')
    }, '模拟终端');
    setStepCardLabel(card, 'busy');
    const cmds = [];
    for (const call of toolCalls) {
      const name = (call.function && call.function.name) || (call.name) || '';
      let args = {};
      try {
        args = JSON.parse((call.function && call.function.arguments) || call.arguments || '{}');
      } catch (e) { args = {}; }
      const cmd = buildToolCommand(name, args);
      if (cmd === null) {
        appendStepResult(card, '未知工具: ' + name, false);
        updateStepCard(card, 'error', '执行失败，已中止');
        pushAILog('error', '模拟终端：未知工具', { 工具: name, 参数: args }, '模拟终端');
        return false;
      }
      cmds.push(cmd);
      pushAILog('response', '模拟终端：工具 → 指令映射', { 工具: name, 参数: args, 指令: cmd }, '模拟终端');
      const ok = await executeSegmentedCommand(card, cmd);
      if (!ok) {
        setStepCardLabel(card, cmds.length === 1 ? cmds[0] : cmds[0] + ' 等 ' + cmds.length + ' 个工具');
        return false;
      }
    }
    setStepCardLabel(card, cmds.length === 1 ? cmds[0] : cmds[0] + ' 等 ' + cmds.length + ' 个工具');
    return true;
  }

  // 降级：解析文本中的 ```command 代码块执行（同样维护工具卡 busy → 完整命令文本标签）
  async function executeTextCommands(card, text) {
    const commandRegex = /```command\s*([\s\S]*?)```/g;
    let match;
    let executed = false;
    const cmds = [];
    setStepCardLabel(card, 'busy');
    while ((match = commandRegex.exec(text)) !== null) {
      executed = true;
      const cmd = match[1].trim();
      if (cmd) {
        cmds.push(cmd);
        const ok = await executeSegmentedCommand(card, cmd);
        if (!ok) {
          setStepCardLabel(card, cmds.length === 1 ? cmds[0] : cmds[0] + ' 等 ' + cmds.length + ' 段');
          return false;
        }
      }
    }
    if (!executed) {
      appendStepResult(card, text ? '模型未返回工具调用，输出说明文字' : '模型未返回有效内容', false);
      updateStepCard(card, 'error', '无工具调用');
      return false;
    }
    setStepCardLabel(card, cmds.length === 1 ? cmds[0] : cmds[0] + ' 等 ' + cmds.length + ' 段');
    return true;
  }

  // ---------- 第4步：付费模型分步执行（tools = 当前步骤专属工具子集） ----------
  // 思考过程标记解析：AI 输出形如「思考过程：</*思考内容*/>正常内容」，
  // 把标记内的思考内容分离出来放入思考卡片，其余正常内容放入对话气泡。
  function splitThinkContent(text) {
    const s = String(text || '');
    let m = s.match(/思考过程[：:]\s*<\/*\s*\*([\s\S]*?)\*\s*\/*\s*>/);
    if (m) {
      const normal = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/^[\r\n\s]+|[\r\n\s]+$/g, '');
      return { think: m[1].trim(), normal: normal };
    }
    m = s.match(/<\/*\s*\*([\s\S]*?)\*\s*\/*\s*>/);
    if (m) {
      const normal = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/^[\r\n\s]+|[\r\n\s]+$/g, '');
      return { think: m[1].trim(), normal: normal };
    }
    return { think: '', normal: s };
  }

  // 流式读取，同时收集文本内容与 tool_calls；onDelta 可选回调，实时推送已收到的文本内容
  async function readStreamingChat(response, onDelta) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let content = '';
    let usage = null;
    const toolCalls = [];
    const tcMap = {};
    let order = 0;
    try {
      while (true) {
        // 需求一报错2：监听请求中断/连接关闭，主动销毁读取 Promise，防止消息通道残留报错
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.name === 'NetworkError')) break;
          throw e;
        }
        const { value, done } = chunk;
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        const lines = fullText.split('\n');
        fullText = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.substring(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const obj = JSON.parse(jsonStr);
            if (!obj.choices || !obj.choices[0]) {
              // DeepSeek 等模型在流末尾输出 usage chunk（choices 为空数组）
              const u = extractUsage(obj);
              if (u && (u.total_tokens != null)) usage = u;
              continue;
            }
            const delta = obj.choices[0].delta || {};
            if (delta.content) {
              content += delta.content;
              if (onDelta) onDelta(content);
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index != null ? tc.index : order++;
                if (!tcMap[idx]) tcMap[idx] = { id: 'call_' + idx, type: 'function', function: { name: '', arguments: '' } };
                if (tc.function) {
                  if (tc.function.name) tcMap[idx].function.name += tc.function.name;
                  if (tc.function.arguments) tcMap[idx].function.arguments += tc.function.arguments;
                }
              }
            }
          } catch(e) {}
        }
      }
      // 处理残留
      if (fullText.trim() && fullText.startsWith('data: ')) {
        const jsonStr = fullText.substring(6).trim();
        if (jsonStr !== '[DONE]') {
          try {
            const obj = JSON.parse(jsonStr);
            const u = extractUsage(obj);
            if (u && (u.total_tokens != null)) usage = u;
            const delta = (obj.choices && obj.choices[0] && obj.choices[0].delta) || {};
            if (delta.content) {
              content += delta.content;
              if (onDelta) onDelta(content);
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index != null ? tc.index : order++;
                if (!tcMap[idx]) tcMap[idx] = { id: 'call_' + idx, type: 'function', function: { name: '', arguments: '' } };
                if (tc.function) {
                  if (tc.function.name) tcMap[idx].function.name += tc.function.name;
                  if (tc.function.arguments) tcMap[idx].function.arguments += tc.function.arguments;
                }
              }
            }
          } catch(e) {}
        }
      }
    } finally {
      reader.cancel && reader.cancel().catch(() => {});
    }
    const indexes = Object.keys(tcMap).map(Number).sort((a, b) => a - b);
    for (const i of indexes) toolCalls.push(tcMap[i]);
    return { content, toolCalls, usage };
  }

  async function runStep(model, step, plan, userMessage, thinkCard, outEl, stepHolder, stepsContext) {
    const key = (aiSettings.apiKey || '').trim();
    const system = aiSettings.systemPrompt || '';
    // 重置本步渲染状态（重试时复用同一批卡片容器，清空多轮内容重新渲染）
    resetThinkCard(thinkCard);
    resetStepOutput(outEl);
    if (stepHolder) stepHolder.card = null;
    const stepsBoxOf = (card) => (card && card.parentElement) ? card.parentElement : chatArea;
    // 工具卡片延迟创建：仅当本步实际调用工具时才创建（无工具调用不显示工具卡）
    const ensureStepCard = () => {
      if (!stepHolder) return null;
      if (!stepHolder.card) {
        stepHolder.card = addStepCard('工具执行', stepsBoxOf(thinkCard));
      }
      return stepHolder.card;
    };
    // 在工具卡存在时把执行结果写入工具卡；无工具调用（无工具卡）时改为对话内系统提示，保证用户有反馈
    const noteResult = (msg, ok) => {
      if (stepHolder && stepHolder.card) appendStepResult(stepHolder.card, msg, ok);
      else addSystemMessage((ok === false ? '? [步骤 ' + stepNo + '] ' : '? ') + msg);
    };
    // 当前步骤专属工具子集（优先按 AI 返回的工具序号 tool_idx 从总工具数组截取，
    // 兼容旧格式完整工具对象；每个步骤自动附加两个只读数据工具）
    const stepNo = (typeof step.step === 'number' && !isNaN(step.step)) ? step.step : 0;
    const stepTools = resolveStepTools(plan, stepNo);
    const stepNote = (typeof step.note === 'string' && step.note) ? step.note : '';
    // 嵌套「AI 执行步骤守则」到每一步执行的 system 提示中，指导 AI 先思考再调用工具
    const executeStepsRule = aiSettings.executeStepsPrompt || '';
    const stepSystem = (executeStepsRule ? executeStepsRule + '\n\n' : '') +
      '当前为第 ' + stepNo + ' 步，仅输出思考过程 + 标准 tool_call，无多余文本。' +
      (stepNote ? '本步任务说明：' + stepNote : '');
    const messages = [];
    if (system) messages.push({ role: 'system', content: system + '\n\n' + stepSystem });
    else messages.push({ role: 'system', content: stepSystem });
    const ctxParts = [];
    ctxParts.push('【用户需求】\n' + userMessage);
    // 需求：把整个步骤计划进度（已完成/当前/未完成）嵌套进提示，保证 AI 延续上下文
    if (stepsContext) ctxParts.push(stepsContext);
    if (freeContextPrompt) ctxParts.push('【项目数据上下文】\n' + freeContextPrompt);
    else if (aiSettings.autoContext) ctxParts.push('【当前项目摘要】\n' + generateContextSummary());
    messages.push({ role: 'user', content: ctxParts.join('\n\n') });

    const headers = {
      ...(model.headers || {}),
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    };
    // 需求：多轮工具循环 —— 允许 AI 先调用 get_project_data/get_knowledge_base 读取数据，
    // 网页把数据作为 tool 消息回传，AI 基于数据继续决策；最多循环 MAX_ROUNDS 轮
    let round = 0;
    const MAX_ROUNDS = 4;
    // 本步骤执行进展概要（命令工具结果、数据工具返回内容、AI 输出），第二轮起随请求注入
    const stepProgress = [];
    while (round < MAX_ROUNDS) {
      round++;
      // 多轮上下文概要：第二轮起，把本步骤已执行进展（含数据工具返回内容）注入请求，供 AI 决策
      if (round > 1 && stepProgress.length) {
        messages.push({ role: 'user', content: '【本步骤执行进展概要】\n' + stepProgress.join('\n') });
      }
      const bodyObj = {
        model: model.bodyTemplate?.model || model.name,
        messages: messages,
        tools: stepTools,
        tool_choice: 'auto',
        stream: !!(aiSettings.streaming && model.stream)
      };
      // DeepSeek 禁用思考：附加 extra_body.thinking=disabled，强制输出标准 tool_call
      if (aiSettings.deepseekDisableThinking) {
        bodyObj.extra_body = { thinking: { type: 'disabled' } };
      }
      // 需求二：发起请求时打印完整拼接链接 + 请求头 + 入参 JSON（含步骤专属工具子集）
      logAIRequest('步骤执行(第' + stepNo + '步,轮次' + round + ')', model.url, 'POST', { ...headers, Authorization: 'Bearer ' + key.slice(0, 6) + '...' }, bodyObj, { 步骤: stepNo, note: stepNote, 轮次: round, 工具子集: stepTools.map(t => (t.function && t.function.name) || t.name) });
      let response, cleanup;
      try {
        const res = await performFetch(model.url, { method: 'POST', headers, body: JSON.stringify(bodyObj) }, aiSettings.timeoutMs, '步骤执行');
        response = res.response;
        cleanup = res.cleanup;
      } catch (e) {
        logAIError('步骤执行', e, { 步骤: stepNo, 轮次: round, 模型: modelDisplayName(model) });
        if (e && (e.name === AI_ABORT_NAME || (e.name === 'AbortError' && aiCancelled))) throw e;
        failThinkCard(thinkCard);
        updateStepCard(stepHolder.card, 'error', '请求失败，已中止');
        noteResult(e.message, false);
        return false;
      }
      try {
        if (!response.ok) throwErrorByStatus(response, '步骤执行');
        updateStepCard(stepHolder.card, 'running', '执行中...');
        let content = '', toolCalls = [], usage = null;
        if (model.stream && aiSettings.streaming) {
          // 流式读取时实时把思考内容与正常内容分离：思考内容写入思考卡片当前轮区块（自动展开），正常内容写入对话气泡当前轮区块（markdown 渲染）
          const r = await readStreamingChat(response, (txt) => {
            const sp = splitThinkContent(txt);
            updateThinkCard(thinkCard, sp.think, round);
            setOutputRoundContent(outEl, round, sp.normal);
          });
          content = r.content;
          toolCalls = r.toolCalls;
          usage = r.usage;
        } else {
          const data = await response.text();
          // 需求二：接收返回数据时打印原始完整返回 JSON 原文
          logAIResponse('步骤执行(第' + stepNo + '步,轮次' + round + ')', data);
          const extracted = extractPaidText(data);
          // 非流式：尝试从 JSON 提取 tool_calls 与 usage
          try {
            const json = JSON.parse(data);
            const msg = json.choices && json.choices[0] && json.choices[0].message;
            if (msg && msg.tool_calls) toolCalls = msg.tool_calls;
            if (json.usage && json.usage.total_tokens != null) {
              usage = { prompt_tokens: json.usage.prompt_tokens, completion_tokens: json.usage.completion_tokens, total_tokens: json.usage.total_tokens };
            }
          } catch(e) {}
          content = extracted;
          // 非流式：同样分离思考内容与正常内容后分别渲染
          const sp = splitThinkContent(content);
          if (sp.think && sp.think.trim()) updateThinkCard(thinkCard, sp.think, round);
          if (sp.normal && sp.normal.trim()) setOutputRoundContent(outEl, round, sp.normal);
        }
        // token 消耗统计（AI 日志 + 工具卡片；仅当工具卡存在时展示，无工具调用不创建工具卡）
        if (usage && usage.total_tokens != null) {
          pushAILog('response', '步骤' + stepNo + '：token 消耗统计', { 轮次: round, ...usage }, 'token统计');
          if (stepHolder && stepHolder.card) appendStepResult(stepHolder.card, 'token 消耗：' + usage.total_tokens + '（prompt ' + usage.prompt_tokens + ' / completion ' + usage.completion_tokens + '）', true);
        } else {
          pushAILog('response', '步骤' + stepNo + '：未返回 token 统计', { 轮次: round }, 'token统计');
        }
        // 思考过程完成标记（按分离后的思考内容判断；思考完毕自动收起思考卡片）
        const thinkPart = splitThinkContent(content).think;
        markThinkDone(thinkCard, !!(thinkPart && thinkPart.trim()));
        // 归一化 tool_calls（补齐 id/type，供回传匹配）
        let calls = (toolCalls || []).map((c, i) => normalizeToolCall(c, i));
        // DeepSeek 思考模式兜底：无标准 tool_calls 时，自动识别 DSML 自研工具格式并解析执行
        if (!calls.length && content && /<[｜|]DSML[｜|]/.test(content)) {
          const dsmlCalls = extractDSMLToolCalls(content);
          if (dsmlCalls) {
            pushAILog('response', '步骤' + stepNo + '：识别到 DeepSeek DSML 工具格式', {
              轮次: round,
              工具: dsmlCalls.map(c => (c.function && c.function.name) || '')
            }, '工具数组解析');
            calls = dsmlCalls;
          }
        }
        // 步骤完成标记 <//true> / <//false>：AI 在本步输出末尾标注是否完成；未输出默认视为完成
        const flagMatch = (content || '').match(/<[\/\\]\/?\s*(true|false)\s*>/);
        let stepFlag = null;
        if (flagMatch) stepFlag = flagMatch[1].toLowerCase() === 'true';
        const cleanContent = (content || '').replace(/<[\/\\]\/?\s*(true|false)\s*>/gi, '').trim();
        const dataCalls = calls.filter(c => isDataToolName((c.function && c.function.name) || ''));
        const cmdCalls = calls.filter(c => !isDataToolName((c.function && c.function.name) || ''));
        // ① 命令工具先执行（更新项目），失败即中止本步；执行期间工具卡保持收起、标签显示 busy，执行完标签显示完整命令文本
        if (cmdCalls.length) {
          const card = ensureStepCard();
          setStepCardLabel(card, 'busy');
          const ok = await executeToolCalls(card, cmdCalls);
          if (!ok) return false;
          stepProgress.push('已执行命令工具：' + cmdCalls.map(c => (c.function && c.function.name) || '').join('、'));
        }
        // 记录本轮 AI 输出到步骤进展概要（供后续轮次携带上下文）
        if (cleanContent) stepProgress.push('AI 本轮输出：' + cleanContent.slice(0, 500));
        // ② 数据工具：把返回内容作为 tool 消息回传，同时写入进展概要，继续让 AI 决策
        if (dataCalls.length) {
          const dCard = ensureStepCard();
          setStepCardLabel(dCard, 'busy');
          messages.push({ role: 'assistant', content: cleanContent || null, tool_calls: calls });
          // assistant.tool_calls 中的每个调用都必须有对应 tool 消息（命令工具补占位，数据工具返回数据）
          for (const call of calls) {
            const nm = (call.function && call.function.name) || '';
            if (isDataToolName(nm)) {
              const result = getDataToolResult(nm);
              if (dCard) appendStepResult(dCard, '调用数据工具「' + nm + '」返回：' + String(result).slice(0, 300), true);
              messages.push({ role: 'tool', tool_call_id: call.id, name: nm, content: result });
              stepProgress.push('数据工具「' + nm + '」返回内容：' + String(result).slice(0, 600));
            } else {
              messages.push({ role: 'tool', tool_call_id: call.id, name: nm, content: '（命令工具 ' + nm + ' 已执行，执行结果详见步骤卡片）' });
            }
          }
          setStepCardLabel(dCard, dataCalls.map(c => (c.function && c.function.name) || '').join('、'));
          // AI 明确标记 <//true> 表示本步已完成；否则继续请求等待其基于数据完成操作
          if (stepFlag === true) return true;
          continue;
        }
        // ③ 有命令工具调用且已执行成功：标记 <//false> 表示本步未完成 → 继续请求
        if (calls.length) {
          if (stepFlag === false) continue;
          return true;
        }
        // ④ 无 tool_call：代码块降级执行；纯文本按「未调用工具」报错，不判定执行成功
        if (cleanContent) {
          if (/```command/.test(cleanContent)) {
            const ok = await executeTextCommands(ensureStepCard(), cleanContent);
            if (stepFlag === false) { if (ok) continue; return false; }
            return ok;
          }
          if (stepFlag === false) {
            noteResult('AI 本轮仅输出文字（未调用工具），已继续请求', true);
            continue;
          }
          noteResult('模型仅返回文字、未调用任何工具：' + cleanContent.slice(0, 200), false);
          updateStepCard(stepHolder.card, 'error', '未调用工具');
          return false;
        }
        noteResult('模型未返回有效内容', false);
        updateStepCard(stepHolder.card, 'error', '无有效输出');
        return false;
      } catch (e) {
        logAIError('步骤执行', e, { 步骤: stepNo, 轮次: round, 模型: modelDisplayName(model) });
        if (e && (e.name === AI_ABORT_NAME || (e.name === 'AbortError' && aiCancelled))) throw e;
        failThinkCard(thinkCard);
        updateStepCard(stepHolder.card, 'error', '请求失败，已中止');
        noteResult(e.message, false);
        return false;
      } finally {
        if (cleanup) cleanup();
      }
    }
    updateStepCard(stepHolder.card, 'error', '达到最大工具轮次');
    noteResult('AI 连续调用工具超过 ' + MAX_ROUNDS + ' 轮，已停止', false);
    return false;
  }

  // 普通问答：交由上下文处理模型（默认记忆模型）直接回复，按类别分发（旧版GET拼接 / 主流标准格式）
  async function chatWithContextModel(userMessage, system, startTime) {
    const host = getMemoryHostModel();
    if (!host) {
      addSystemMessage('? [步骤: 分类] 未找到上下文处理模型，无法直接回复');
      updateResponseTime(startTime);
      stopStopwatch();
      return;
    }
    if (host.category === 'legacy') {
      await sendToLegacyModel(host, userMessage, system, startTime);
    } else {
      await sendToMainstreamModel(host, userMessage, system, startTime);
    }
  }

  // ---------- 第4步执行计划（首次执行与「继续执行任务」复用） ----------
  // initCompleted：已成功完成的步骤（继续执行时传入上次保存的成功步骤）；返回 { failed, cancelled }
  async function executePlanSteps(model, plan, userMessage, initCompleted, stepsBox) {
    showStepsBar(plan.steps);
    let failed = false;
    let cancelled = false;
    const completedSteps = Array.isArray(initCompleted) ? initCompleted.slice() : [];
    const doneSet = new Set();
    completedSteps.forEach(c => {
      if (c && c.ok) doneSet.add((typeof c.step === 'object' && c.step && c.step.step != null) ? Number(c.step.step) : (c.step != null ? Number(c.step) : -1));
    });
    const firstTodo = plan.steps.findIndex(s => !doneSet.has((s.step != null) ? Number(s.step) : -1));
    const fromIdx = firstTodo < 0 ? 0 : firstTodo;
    for (let i = fromIdx; i < plan.steps.length; i++) {
      // 需求三：步骤间取消检查点（已取消则中止后续步骤，保留已保存步骤供继续执行）
      if (aiCancelled) {
        addSystemMessage('? 已取消执行，后续步骤已中止');
        cancelled = true;
        break;
      }
      const step = plan.steps[i];
      const stepNo = (typeof step.step === 'number' && !isNaN(step.step)) ? step.step : (i + 1);
      // 当前步骤可用工具名（供已完成步骤上下文记录「工具+执行情况」）
      const stepToolNames = resolveStepTools(plan, stepNo).map(t => (t.function && t.function.name) || t.name);
      // 需求：把已完成步骤（含执行状态）、当前步骤、未完成步骤整体嵌套进本次请求上下文
      const stepsContext = buildStepsContext(completedSteps, step, plan.steps.slice(i + 1));
      const thinkCard = addThinkCard(stepsBox);
      const outEl = createStepOutput(stepsBox);
      const stepHolder = { card: null };
      updateStepsBarState(stepNo, 'running');
      // 步骤失败重试：按 AI 设置（默认开启、默认 2 次），重试耗尽后继续后续步骤，不中断流程
      let ok = await runStep(model, step, plan, userMessage, thinkCard, outEl, stepHolder, stepsContext);
      const retryEnabled = aiSettings.stepRetryEnabled !== false;
      const maxRetries = retryEnabled ? (aiSettings.stepRetryCount || 0) : 0;
      if (!ok && maxRetries > 0) {
        for (let r = 1; r <= maxRetries; r++) {
          addSystemMessage('? [步骤 ' + stepNo + '] 执行失败，正在重试（' + r + '/' + maxRetries + '）');
          updateStepCard(stepHolder.card, 'running', '重试(' + r + '/' + maxRetries + ')');
          ok = await runStep(model, step, plan, userMessage, thinkCard, outEl, stepHolder, stepsContext);
          if (ok) break;
        }
      }
      updateStepsBarState(stepNo, ok ? 'success' : 'error');
      completedSteps.push({ step: step, ok: ok, tools: stepToolNames });
      // 保存已执行步骤状态（含工具与执行情况），供「继续执行任务」复用
      if (continueStepsData) {
        continueStepsData.completed = completedSteps.map(c => ({
          step: { step: (c.step && c.step.step != null) ? Number(c.step.step) : 0, note: (c.step && c.step.note) || '' },
          ok: !!c.ok,
          tools: c.tools || []
        }));
      }
      // 需求：每一步执行完成后写入记忆模型，供后续对话延续记忆
      await persistStepMemory(step, ok);
      if (!ok) {
        failed = true;
        addSystemMessage('? [步骤 ' + stepNo + '] 重试耗尽，继续执行后续步骤');
      }
    }
    // 步骤执行完毕或取消后，删除对话区下方的步骤执行状态
    hideStepsBar();
    return { failed: failed, cancelled: cancelled };
  }

  // ---------- 继续执行任务（用户取消后输入「继续执行任务」等指令） ----------
  // 复用上次保存的执行计划与各步骤完成状态：从第一个未完成步骤开始继续执行；
  // 先在上次规划的 AI 回复位置模拟 AI 回复并 markdown 渲染已保存的步骤，再向对话模型发送后续请求。
  async function continueExecution(model, userMessage, startTime) {
    const saved = continueStepsData;
    if (!saved || !saved.plan || !Array.isArray(saved.plan.steps) || !saved.plan.steps.length) {
      addSystemMessage('? [步骤: 继续执行] 没有找到可继续执行的已保存步骤，将按普通问答处理');
      await chatWithContextModel(userMessage, aiSettings.systemPrompt || '', startTime);
      return true;
    }
    const plan = saved.plan;
    const initCompleted = (saved.completed || []).filter(c => c && c.ok);
    // 在对话框左侧模拟 AI 回复，markdown 渲染上次保存的执行步骤
    const planWrap = addMessage('assistant', '继续执行上次未完成的任务（已保存步骤）');
    const bubble = planWrap.querySelector('.ai-msg-assistant');
    if (bubble && plan.tableText) {
      const tmp = document.createElement('div');
      tmp.innerHTML = renderMarkdown(plan.tableText);
      while (tmp.firstChild) bubble.appendChild(tmp.firstChild);
    }
    const stepsBox = document.createElement('div');
    stepsBox.style.cssText = 'width:100%;min-width:320px;margin-top:6px;';
    if (bubble) bubble.appendChild(stepsBox);
    setRequestStatus('executing', '继续执行中...');
    const res = await executePlanSteps(model, plan, userMessage, initCompleted, stepsBox);
    // 保存步骤仅刷新/清空对话时清除：执行完成不自动清空，下次创建新执行计划时覆盖替换
    if (!res.failed) addSystemMessage('? 全部执行步骤完成');
    else addSystemMessage('? 有步骤执行失败，其余步骤已继续执行完成');
    stopStopwatch();
    setStatus('idle', '空闲');
    clearChatStatus();
    return true;
  }

  // ---------- 五步主流程 ----------
  async function runExecutionPipeline(model, userMessage, startTime) {
    // 第1步：分类（免费模型，不带 conversation_id）
    setRequestStatus('loading', '分类中...');
    const cls = await classifyRequest(userMessage);
    // 需求三：取消检查点
    if (aiCancelled) throw new AIAbortError();
    if (cls === null) {
      addSystemMessage('? [步骤: 分类] 分类请求失败，将按普通问答处理');
    }
    // 判定为「继续执行」：复用上次保存的执行步骤，从第一个未完成步骤开始继续执行
    if (cls === '继续执行') {
      addSystemMessage('? 已判定为「继续执行」，从上次未完成步骤继续执行');
      return await continueExecution(model, userMessage, startTime);
    }
    // 规格四.1：问答分支由上下文处理模型（默认记忆模型）直接回复，终止付费链路
    if (cls !== '指令执行') {
      addSystemMessage('? 已判定为「普通问答」，由上下文处理模型直接回复');
      await chatWithContextModel(userMessage, aiSettings.systemPrompt || '', startTime);
      return true;
    }

    // 指令执行：继续五步
    addSystemMessage('? 已判定为「指令执行」，开始规划执行步骤');

    // 第2步：免费模型新建执行会话并输出计划（重试≤3次）
    setRequestStatus('thinking', '规划执行步骤...');
    const plan = await createExecutionPlan(userMessage);
    // 需求三：取消检查点
    if (aiCancelled) throw new AIAbortError();
    if (plan.error || !plan.steps.length) {
      addSystemMessage('? [步骤: 规划] 执行规划失败（' + (plan.error || '未生成步骤') + '），将按普通问答处理');
      return false;
    }
    // 保存本次执行计划（含步骤、工具、表格文本、会话 ID）到网页内存，供取消后「继续执行任务」使用
    continueStepsData = {
      plan: { steps: JSON.parse(JSON.stringify(plan.steps)), tools: JSON.parse(JSON.stringify(plan.tools)), tableText: plan.tableText || '', convId: plan.convId || '' },
      completed: [],
      convId: plan.convId || ''
    };
    // 展示规划表格（内嵌于 AI 输出气泡）
    const planWrap = addMessage('assistant', '已规划 ' + plan.steps.length + ' 个执行步骤');
    if (plan.tableHtml) {
      // 追加表格到气泡内
      const bubble = planWrap.querySelector('.ai-msg-assistant');
      if (bubble) {
        const tmp = document.createElement('div');
        tmp.innerHTML = plan.tableHtml;
        while (tmp.firstChild) bubble.appendChild(tmp.firstChild);
      }
    }
    // 步骤卡容器：min-width 保证执行卡片不被 fit-content 气泡挤压
    const stepsBox = document.createElement('div');
    stepsBox.style.cssText = 'width:100%;min-width:320px;margin-top:6px;';
    const bubble = planWrap.querySelector('.ai-msg-assistant');
    if (bubble) bubble.appendChild(stepsBox);

    // 第3步：免费模型带执行会话 ID 发送原始需求
    setRequestStatus('loading', '发送执行上下文...');
    await sendPlanContext(plan.convId, userMessage);
    // 需求三：取消检查点
    if (aiCancelled) throw new AIAbortError();

    // 第4步：付费模型分步执行（首次执行，无已成功步骤）
    setRequestStatus('executing', '执行中...');
    const res = await executePlanSteps(model, plan, userMessage, [], stepsBox);
    // 保存步骤仅刷新/清空对话时清除：执行完成不自动清空，下次创建新执行计划时覆盖替换
    if (!res.failed) addSystemMessage('? 全部执行步骤完成');
    else addSystemMessage('? 有步骤执行失败，其余步骤已继续执行完成');
    stopStopwatch();
    // 步骤执行完成后，状态从"执行中"改回"空闲"
    setStatus('idle', '空闲');
    clearChatStatus();
    return true;
  }

  // ---------- 需求6：提取用户消息中的文本链接内容 ----------
  function extractUrls(text) {
    const re = /https?:\/\/[^\s<>"'，。；、）】》]/g;
    return text.match(re) || [];
  }

  async function fetchLinkContent(url) {
    const candidates = [
      url,
      'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
      'https://corsproxy.io/?url=' + encodeURIComponent(url)
    ];
    for (const target of candidates) {
      let timer;
      try {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(target, { method: 'GET', signal: controller.signal });
        clearTimeout(timer);
        timer = null;
        if (!resp.ok) continue;
        const text = await resp.text();
        if (!text) continue;
        // 若是 HTML，提取正文纯文本
        if (/<(html|!doctype|body|div|p|article|main)/i.test(text) && text.length < 300000) {
          try {
            const doc = new DOMParser().parseFromString(text, 'text/html');
            doc.querySelectorAll('script,style,noscript,svg,iframe,link,meta').forEach(el => el.remove());
            const bodyText = (doc.body ? doc.body.innerText : '').trim();
            if (bodyText) return bodyText;
          } catch(e) {}
        }
        return text.trim();
      } catch(e) {
        if (timer) clearTimeout(timer);
      }
    }
    return null;
  }

  async function enhanceUserMessageWithLinks(userMessage) {
    const urls = extractUrls(userMessage);
    if (urls.length === 0) return { message: userMessage, added: false };
    addSystemMessage('? 检测到 ' + urls.length + ' 个文本链接，正在获取链接内容...');
    const parts = [];
    let totalLen = 0;
    for (const u of urls) {
      if (totalLen >= 4000) {
        parts.push('!【链接】' + u + '\n【内容】已超出长度限制，未获取');
        pushAILog('response', '链接「' + u.slice(0, 80) + '」超长跳过', { 链接: u, 结果: '超出长度限制，未获取' }, '链接获取');
        continue;
      }
      const content = await fetchLinkContent(u);
      if (content) {
        const clipped = content.slice(0, 1500);
        totalLen += clipped.length + u.length;
        parts.push('【链接】' + u + '\n【内容】' + clipped);
        pushAILog('response', '链接「' + u.slice(0, 80) + '」获取成功', { 链接: u, 内容长度: content.length, 截取长度: clipped.length }, '链接获取');
      } else {
        // 获取失败：链接前加感叹号 + 对话内提示
        parts.push('!【链接】' + u + '\n【内容】获取失败（可能存在跨域访问限制）');
        addSystemMessage('! 链接获取失败：' + u);
        pushAILog('error', '链接「' + u.slice(0, 80) + '」获取失败', { 链接: u, 结果: '跨域/网络失败，已标记感叹号' }, '链接获取');
      }
    }
    const linkBlock = '\n\n【用户消息中链接的获取内容】\n' + parts.join('\n\n---\n\n');
    return { message: userMessage + linkBlock, added: true };
  }

  // ---------- 需求10：带超时的 fetch（可被「取消」按钮中断） ----------
  // 所有 AI 请求统一入口；超时/取消会通过 AbortController 中断，取消时清空 pending 队列
  async function performFetch(url, options, timeoutMs, label) {
    const ms = timeoutMs || aiSettings.timeoutMs || 300000;
    if (!aiAbortController) aiAbortController = new AbortController();
    const controller = aiAbortController;
    aiPendingFetches.add(controller);
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return { response, cleanup: function() { clearTimeout(timer); aiPendingFetches.delete(controller); } };
    } catch (e) {
      clearTimeout(timer);
      aiPendingFetches.delete(controller);
      if (e && e.name === 'AbortError') {
        if (aiCancelled) throw new AIAbortError();
        throw new Error((label ? '[' + label + '] ' : '') + '请求超时（已等待 ' + Math.round(ms / 1000) + ' 秒），请在 AI 设置中调整“请求超时”后重试');
      }
      throw e;
    }
  }

  // 需求9/10：错误状态友好提示（含 HTTP 524）；错误携带 status 供 [AI异常日志] 输出
  function throwErrorByStatus(response, label) {
    let msg = 'HTTP ' + response.status + ' ' + (response.statusText || '');
    if (response.status === 524) {
      msg = 'HTTP 524（源服务器响应超时，网关等待超过 100 秒）。请增大 AI 设置中的“请求超时”后重试，或缩短问题/项目数据内容';
    } else if (response.status === 429) {
      msg = 'HTTP 429 请求过于频繁，请稍后重试（按 Retry-After 响应头等待）';
    } else if (response.status === 401 || response.status === 403) {
      msg = 'HTTP ' + response.status + ' 认证失败，请检查 API Key 是否正确';
    } else if (response.status === 402) {
      msg = 'HTTP 402 余额不足或预扣失败，请检查云智API账户余额';
    } else if (response.status === 404) {
      msg = 'HTTP 404 模型不存在或接口路径错误，请核对模型名称与接口地址';
    } else if (response.status >= 500) {
      msg = 'HTTP ' + response.status + ' 服务端错误，请稍后重试';
    }
    const err = new Error((label ? '[' + label + '] ' : '') + msg);
    err.status = response.status;
    throw err;
  }

  // ---------- 需求3：免费模型请求内容始终携带守则 + 项目数据上下文 ----------
  // enhancedContext：每次发送时由记忆模型对用户消息精简后的上下文（优先级高于项目全量摘要）
  function buildFreeContent(userMessage, system, enhancedContext) {
    const parts = [];
    if (system) parts.push('【系统守则】\n' + system);
    if (enhancedContext) parts.push('【记忆模型上下文处理结果】\n' + enhancedContext);
    if (freeContextPrompt) parts.push('【项目数据上下文】\n' + freeContextPrompt);
    if (aiSettings.autoContext && !freeContextPrompt && !enhancedContext) {
      const summary = generateContextSummary();
      if (summary) parts.push('【当前项目摘要】\n' + summary);
    }
    parts.push('【用户问题】\n' + userMessage);
    return parts.join('\n\n');
  }

  // ---------- 发送消息给 AI（统一入口） ----------
  async function sendToAI(userMessage) {
    // 获取当前模型
    const model = findModel(currentModelId);
    if (!model) {
      addSystemMessage('?? [步骤: 校验模型] 未找到当前模型配置');
      return;
    }
    // 旧版付费模型：Token 参数需填写（请求时直接嵌入）
    if (model.category === 'legacy' && model.billing === 'paid' && !model.tokenParamKey) {
      addSystemMessage('?? [步骤: 校验配置] 付费旧版模型「' + modelDisplayName(model) + '」未配置 Token 参数。请在模型列表「Token参数」列填写（如 token=xxx，请求时直接嵌入），或改用免费模型。');
      return;
    }

    beginAIOperation();
    const startTime = performance.now();
    resetResponseTime();
    startStopwatch(startTime);
    const system = aiSettings.systemPrompt || '';

    try {
      // 指令集替换：将用户消息中的 {指令集字样} 替换为对应外部链接抓取的内容
      let effectiveMsg = await resolveDirectiveSets(userMessage);
      // 需求6：尝试获取用户消息中文本链接的内容
      const enhanced = await enhanceUserMessageWithLinks(effectiveMsg);
      effectiveMsg = enhanced.message;

      // 需求4：每次发送请求时，在控制台打印完整请求数据（用户输入 + AI 守则等）
      console.log('%c[AI 请求] 完整请求数据', 'background:#6366f1;color:#fff;padding:2px 8px;border-radius:4px;font-weight:bold;', {
        时间: new Date().toLocaleTimeString(),
        模型: { 名称: modelDisplayName(model), 类别: model.category === 'legacy' ? '旧版兼容' : '主流', 计费: model.billing === 'free' ? '免费' : '付费', ID: model.id },
        AI守则: system || '(未配置)',
        用户输入: userMessage,
        自动获取的链接内容: enhanced.added ? '(已附加，见下方请求体)' : '(无)',
        自动上下文: aiSettings.autoContext,
        项目数据摘要: generateContextSummary(),
        '记忆模型上下文(同步后的数据)': freeContextPrompt || '(未同步)',
        记忆ID: memoryId || '(未生成)',
        默认记忆模型: findModel(defaultMemoryModelId) ? modelDisplayName(findModel(defaultMemoryModelId)) : '(无)',
        '超时设置(秒)': Math.round(aiSettings.timeoutMs / 1000),
        流式输出: !!(aiSettings.streaming && model.stream)
      });

      // 所有 AI 模型都可以执行步骤指令，不再区分大模型/兼容模型
      // 先经五步分步执行架构分类，普通问答直接回复终止，指令执行走付费链路
      const executed = await runExecutionPipeline(model, effectiveMsg, startTime);
      if (!executed) {
        if (model.category === 'legacy') {
          await sendToLegacyModel(model, effectiveMsg, system, startTime);
        } else if (model.category === 'mainstream') {
          await sendToMainstreamModel(model, effectiveMsg, system, startTime);
        } else {
          addSystemMessage('?? 未知模型类别，请检查模型配置');
        }
      }
    } catch (e) {
      if (e && e.name === AI_ABORT_NAME) {
        addSystemMessage('? 已取消本次 AI 请求');
      } else {
        addSystemMessage('?? AI 请求异常: ' + e.message);
        console.error(e);
      }
    } finally {
      endAIOperation();
    }
  }

  // 记忆 ID：自动生成 6 位数字 / 手动输入校验（本地缓存绑定当前对话）
  // 完全新建对话：清空全部记忆状态（记忆ID/服务端会话/上下文/聊天记录/本地缓存）
  function resetConversation() {
    memoryId = '';
    serverConvId = '';
    freeContextPrompt = '';
    isFirstMessage = true; // 重置对话时，标记为首次消息
    localStorage.removeItem(MEMORY_ID_KEY);
    if (chatArea) {
      while (chatArea.children.length > 1) {
        chatArea.removeChild(chatArea.lastChild);
      }
    }
    // 清空对话时移除步骤状态条
    if (typeof hideStepsBar === 'function') {
      hideStepsBar();
    }
    // 清空对话时清除已保存的执行步骤（继续执行任务仅存于网页内存）
    continueStepsData = null;
    updateDialogTitle();
  }

  // 记忆 ID：auto 提取 / manual 手动输入 / none 不生成（按默认记忆模型的 memoryMode 判定）
  async function ensureMemoryId() {
    // 记忆 ID 模式判定依据 = AI 设置「默认记忆模型」的 memoryMode，而非当前对话模型
    const host = getMemoryHostModel();
    const mode = (host && host.memoryMode) || 'auto';
    // none 模式：不带 ID 直接请求
    if (mode === 'none') {
      memoryId = '';
      serverConvId = '';
      localStorage.removeItem(MEMORY_ID_KEY);
      updateDialogTitle();
      return '';
    }
    // 已有记忆 ID（auto 提取的会话 ID 或 manual 输入的 6 位数字）直接复用
    if (memoryId) return memoryId;
    const cached = localStorage.getItem(MEMORY_ID_KEY);
    if (cached) {
      memoryId = cached;
      updateDialogTitle();
      return memoryId;
    }
    // manual 模式：检查缓存或弹出模态框
    if (mode === 'manual') {
      const id = await showMemoryIdModal();
      if (id) {
        memoryId = id;
        localStorage.setItem(MEMORY_ID_KEY, id);
        updateDialogTitle();
        addSystemMessage('? 已设置记忆ID：' + id);
        return id;
      }
      return '';
    }
    // auto 模式：向记忆模型发送固定消息（内容嵌入 AI 守则，不带对话 ID），从响应中提取本轮 ID
    setRequestStatus('loading', '正在创建记忆ID...');
    try {
      const rule = aiSettings.systemPrompt || '你是一个专业的函数绘制器助手。';
      const promptText = '请阅读系统守则：\n' + rule + '\n\n请为本次对话创建一个新的会话记忆，并返回本次会话的 ID。';
      // memoryKey='' → 独立会话（不带对话 ID），响应中返回新会话 ID
      const result = await callMemoryHost(promptText, '');
      if (result && result.convId) {
        memoryId = result.convId;
        localStorage.setItem(MEMORY_ID_KEY, memoryId);
        updateDialogTitle();
        addSystemMessage('? 已创建记忆ID：' + memoryId + (serverConvId && serverConvId !== memoryId ? '（服务端会话：' + serverConvId + '）' : ''));
        return memoryId;
      }
      addSystemMessage('? [步骤: 记忆ID] 未能从记忆模型响应中提取记忆 ID，请检查记忆模型「记忆ID提取路径」配置');
      return '';
    } catch (e) {
      addSystemMessage('? [步骤: 记忆ID] 创建记忆 ID 失败: ' + e.message);
      return '';
    }
  }

  // 显示调试弹窗（title 标题 + content 内容），供 runModelDebug 即时反馈使用
  function showDebugModal(title, content) {
    const overlay = document.getElementById('debugModalOverlay');
    if (!overlay) return;
    const titleEl = document.getElementById('debugModalTitle');
    const contentEl = document.getElementById('debugModalContent');
    if (titleEl && title) titleEl.textContent = title;
    if (contentEl) contentEl.textContent = content;
    overlay.classList.add('visible');
  }

  // 调试单个模型请求（发送测试消息“Hello”，显示完整请求/响应）
  async function runModelDebug(modelId) {
    const model = findModel(modelId);
    if (!model) {
      alert('模型不存在');
      return;
    }

    // ----- 新增：立即显示调试框，提示“正在请求...” -----
    const title = '调试结果（' + modelDisplayName(model) + '）';
    showDebugModal(title, '正在请求，请稍候...');

    const key = (aiSettings.apiKey || '').trim();
    const testMsg = '请回复 Hello World 作为测试。';
    let resultText = '';

    try {
      if (model.category === 'legacy') {
        const content = buildFreeContent(testMsg, aiSettings.systemPrompt);
        // 调试模式下不发送记忆ID
        const origMemoryMode = model.memoryMode;
        model.memoryMode = 'none';
        const url = buildLegacyUrl(model, content);
        model.memoryMode = origMemoryMode;
        const { response, cleanup } = await performFetch(url, { method: 'GET' }, aiSettings.timeoutMs, '调试');
        try {
          let data;
          try { data = await response.json(); } catch(e) { data = await response.text(); }
          resultText = '【请求地址】\n' + url + '\n\n【响应】\n' + (typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        } finally { cleanup(); }
      } else {
        // 主流模型
        const messages = [{ role: 'system', content: '你是一个测试助手。' }, { role: 'user', content: testMsg }];
        const bodyObj = { model: model.name, messages, stream: false };
        const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
        const { response, cleanup } = await performFetch(model.url, { method: 'POST', headers, body: JSON.stringify(bodyObj) }, aiSettings.timeoutMs, '调试');
        try {
          const data = await response.text();
          resultText = '【请求体】\n' + JSON.stringify(bodyObj, null, 2) + '\n\n【响应】\n' + data;
        } finally { cleanup(); }
      }

      // 请求完成后，更新调试框内容
      document.getElementById('debugModalTitle').textContent = '调试结果（' + modelDisplayName(model) + '）';
      document.getElementById('debugModalContent').textContent = resultText;

    } catch (e) {
      // 异常时更新调试框显示错误
      document.getElementById('debugModalTitle').textContent = '调试异常';
      document.getElementById('debugModalContent').textContent = '错误：' + e.message + '\n' + (e.stack || '');
    }
  }

  function getValueByPath(obj, path) {
    if (obj == null || !path) return undefined;
    const parts = String(path).trim().split('.');
    let cur = obj;
    for (const part of parts) {
      // 返回数据合法性校验：非对象不可继续取属性，避免访问不存在键导致异常
      if (cur == null || typeof cur !== 'object') return undefined;
      const m = part.match(/^(.+?)\[(\d+)\]$/);
      if (m) {
        cur = cur[m[1]];
        if (cur == null || !Array.isArray(cur)) return undefined;
        cur = cur[Number(m[2])];
      } else {
        cur = cur[part];
      }
    }
    return cur;
  }

  // 从响应数据中提取记忆会话 ID：优先按模型配置的「记忆ID提取路径」，未配置或读不到时多级兜底
  function extractMemoryIdFromData(data, model) {
    if (data == null) return '';
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch(e) { return ''; }
    }
    if (typeof data !== 'object') return '';
    const path = model && model.memoryIdReplyPath;
    if (path) {
      const v = getValueByPath(data, path);
      if (v != null) return String(v);
    }
    if (data.data && data.data.conversation_id != null) return String(data.data.conversation_id);
    if (data.conversation_id != null) return String(data.conversation_id);
    if (data.data && data.data.conversationId != null) return String(data.data.conversationId);
    if (data.conversationId != null) return String(data.conversationId);
    if (data.data && data.data.id != null) return String(data.data.id);
    if (data.id != null) return String(data.id);
    return '';
  }

  function extractLegacyText(data, model) {
    if (data == null) return '';
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch(e) { return data; }
    }
    // 返回数据合法性校验：非对象直接按原始文本返回（不再尝试访问 JSON 键）
    if (typeof data !== 'object') return String(data);
    // 配置了「AI回复字段路径」时，严格按该路径检索 AI 输出内容；路径不存在直接抛异常进入异常分支
    const replyPath = model && model.replyPath;
    if (replyPath) {
      window.aiGetValueByPath = getValueByPath;
      const v = getValueByPath(data, replyPath);
      if (v == null) {
        throw new Error('响应中未找到回复字段: ' + replyPath + '，请核对模型列表「AI回复字段路径」配置');
      }
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    }
    // 兜底探测（多层级）：优先主流 OpenAI 标准格式
    if (data.choices && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message && data.choices[0].message.content != null) {
      return String(data.choices[0].message.content);
    }
    if (data.data && typeof data.data === 'object') {
      if (data.data.message != null) return String(data.data.message);
    }
    if (data.message != null) return String(data.message);
    if (data.content != null) return String(data.content);
    if (data.response != null) return String(data.response);
    if (data.result != null) return String(data.result);
    return '';
  }

  // ---------- 旧版模型直接对话（强制 GET，拼接 URL 参数） ----------
  async function sendToLegacyModel(model, userMessage, system, startTime) {
    let aiErr = null;
    try {
      // 记忆模式判定依据 = 默认记忆模型的 memoryMode
      const host = getMemoryHostModel();
      const memMode = (host && host.memoryMode) || 'auto';
      // 记忆 ID（auto 提取 / manual 输入）；none 模式跳过
      if (memMode !== 'none') {
        await ensureMemoryId();
        if (!memoryId) {
          addSystemMessage('? [步骤: 记忆ID] 未生成记忆 ID，已中止旧版模型请求');
          return;
        }
      }
      // 首次调用自动初始化上下文（投喂项目数据 → 记忆模型返回精简上下文）
      // 新对话首次输入时，不用获取上下文，从AI回复第一条开始保存
      if (memMode !== 'none' && !freeContextPrompt && !isFirstMessage) {
        setRequestStatus('loading', '获取上下文中...');
        await initMemoryContext();
      }
      // 每次发送：用户输入交给记忆模型精简，获得本次会话上下文
      let enhancedContext = '';
      if (memMode !== 'none') {
        setRequestStatus('loading', '获取上下文中...');
        try {
          const ctxRes = await callMemoryHost(userMessage, 'auto');
          if (ctxRes && ctxRes.convId) serverConvId = ctxRes.convId;
          enhancedContext = (ctxRes && ctxRes.context) || '';
        } catch (e) {
          addSystemMessage('? [步骤: 获取记忆上下文] ' + e.message + '，将继续直接请求旧版模型');
        }
      }
      // 组装内容（守则 + 精简上下文 + 用户问题）
      setRequestStatus('requesting', '请求中...');
      const content = buildFreeContent(userMessage, system, enhancedContext);
      const url = buildLegacyUrl(model, content);

      // 需求二：发起请求时打印完整拼接链接 + 请求头 + 入参 JSON
      logAIRequest('旧版模型请求', url, 'GET', {}, { 文本内容参数名: model.contentParamKey, 记忆参数key: model.memoryParamKey, 记忆ID: memoryId || '(无)', 服务端会话: serverConvId || '(同记忆ID)' }, { 入参文本: content });

      setRequestStatus('thinking', '思考中...');
      const { response, cleanup } = await performFetch(url, { method: 'GET' }, aiSettings.timeoutMs, '旧版模型请求');
      try {
        if (!response.ok) throwErrorByStatus(response, '旧版模型请求');
        // 兼容纯文本 / 非标准 JSON 响应：JSON 解析失败时回退读取原始文本
        let data;
        try {
          data = await response.json();
        } catch(e) {
          data = await response.text();
        }
        // 需求二：接收返回数据时打印原始完整返回 JSON 原文
        logAIResponse('旧版模型请求', typeof data === 'string' ? data : JSON.stringify(data));
        const aiText = extractLegacyText(data, model);
        if (!aiText) throw new Error('响应格式异常，未获取到回复内容');
        if (data && data.data && data.data.conversation_id) serverConvId = data.data.conversation_id;
        // 从AI回复第一条信息开始，标记为非首次消息
        isFirstMessage = false;
        handleAIResponse(aiText);
        updateResponseTime(startTime);
      } finally {
        cleanup();
      }
    } catch (e) {
      aiErr = e;
      logAIError('旧版模型请求', e, { 模型: modelDisplayName(model), 请求地址: buildLegacyUrl(model, buildFreeContent(userMessage, system)) });
      if (e && (e.name === AI_ABORT_NAME || (e.name === 'AbortError' && aiCancelled))) {
        addSystemMessage('? [步骤: 旧版模型请求] 已取消');
      } else if (e.name === 'AbortError') {
        addSystemMessage('? [步骤: 旧版模型请求] 请求已中止（可能超时），请在 AI 设置中调整“请求超时”后重试');
      } else {
        addSystemMessage('? [步骤: 旧版模型请求] ' + e.message);
      }
    } finally {
      settleAIRequest(aiErr);
    }
  }

  // ---------- 需求8：主流模型经记忆模型处理上下文 ----------
  async function sendToMainstreamModel(model, userMessage, system, startTime) {
    const key = (aiSettings.apiKey || '').trim();
    if (!key) {
      addSystemMessage('?? [步骤: 校验配置] 请先在 AI 设置中配置 API Key（免费模型不需要 Key）');
      return;
    }
    const fmt = aiSettings.requestFormat || 'openai';
    if (fmt !== 'openai') {
      addSystemMessage('「' + fmtLabel(fmt) + '」暂未支持，请切换到 OpenAI 格式后再试');
      return;
    }
    let aiErr = null;

    try {
      // ① 记忆 ID + 记忆上下文初始化（投喂守则 + 项目数据）；none 模式跳过
      const host = getMemoryHostModel();
      const memMode = (host && host.memoryMode) || 'auto';
      if (memMode !== 'none') {
        await ensureMemoryId();
        if (!memoryId) {
          addSystemMessage('?? [步骤: 初始化记忆] 无法获取记忆 ID，已中止主流模型请求');
          return;
        }
        // 新对话首次输入时，不用获取上下文，从AI回复第一条开始保存
        if (!freeContextPrompt && !isFirstMessage) {
          setRequestStatus('loading', '获取上下文中...');
          await initMemoryContext();
        }
      }

      // ② 用户输入交给记忆模型处理，获取精简上下文（none 模式跳过）
      setRequestStatus('loading', '获取上下文中...');
      let enhancedContext = '';
      if (memMode !== 'none') {
        try {
          const ctxRes = await callMemoryHost(userMessage, 'auto');
          if (ctxRes && ctxRes.convId) serverConvId = ctxRes.convId;
          enhancedContext = (ctxRes && ctxRes.context) || '';
        } catch (e) {
          addSystemMessage('? [步骤: 获取记忆上下文] ' + e.message + '，将继续直接请求主流模型');
        }
      }

      // ③ 组装并发送给主流模型
      setRequestStatus('requesting', '请求中...');
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      const ctxParts = [];
      if (enhancedContext) ctxParts.push('【记忆模型上下文处理结果】\n' + enhancedContext);
      else if (freeContextPrompt) ctxParts.push('【项目数据上下文】\n' + freeContextPrompt);
      else if (aiSettings.autoContext) ctxParts.push('【当前项目摘要】\n' + generateContextSummary());
      if (ctxParts.length) messages.push({ role: 'user', content: ctxParts.join('\n\n') });
      messages.push({ role: 'user', content: '【用户问题】\n' + userMessage });

      const bodyObj = {
        model: model.name,
        messages: messages,
        stream: !!(aiSettings.streaming && model.stream)
      };
      // DeepSeek 禁用思考：附加 extra_body.thinking=disabled
      if (aiSettings.deepseekDisableThinking) {
        bodyObj.extra_body = { thinking: { type: 'disabled' } };
      }
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      };

      // 需求二：发起请求时打印完整拼接链接 + 请求头 + 入参 JSON
      logAIRequest('主流模型请求', model.url, model.method || 'POST', { ...headers, Authorization: 'Bearer ' + key.slice(0, 6) + '...' }, bodyObj, { 记忆ID: memoryId });

      setRequestStatus('thinking', '思考中...');
      let response, cleanup;
      if (model.method === 'GET') {
        const params = new URLSearchParams();
        params.set('content', userMessage);
        const getUrl = model.url + (model.url.indexOf('?') >= 0 ? '&' : '?') + params.toString();
        const r = await performFetch(getUrl, { method: 'GET', headers }, aiSettings.timeoutMs, '主流模型请求');
        response = r.response; cleanup = r.cleanup;
      } else {
        const r = await performFetch(model.url, { method: 'POST', headers, body: JSON.stringify(bodyObj) }, aiSettings.timeoutMs, '主流模型请求');
        response = r.response; cleanup = r.cleanup;
      }
      try {
        if (!response.ok) throwErrorByStatus(response, '主流模型请求');

        // 读取回复（流式/非流式）
        let aiText = '';
        let streamed = false;
        let usage = null;
        if (model.stream && aiSettings.streaming) {
          const r = await readStreamingResponse(response);
          aiText = r.aiText;
          usage = r.usage;
          streamed = true;
        } else {
          const data = await response.text();
          // 需求二：接收返回数据时打印原始完整返回 JSON 原文
          logAIResponse('主流模型请求', data);
          aiText = extractPaidText(data);
          try {
            const json = JSON.parse(data);
            if (json.usage && json.usage.total_tokens != null) {
              usage = { prompt_tokens: json.usage.prompt_tokens, completion_tokens: json.usage.completion_tokens, total_tokens: json.usage.total_tokens };
            }
          } catch(e) {}
        }
        if (!aiText) throw new Error('主流模型未返回有效内容');
        if (usage && usage.total_tokens != null) {
          pushAILog('response', '主流模型请求：token 消耗统计', { ...usage }, 'token统计');
        } else {
          pushAILog('response', '主流模型请求：未返回 token 统计', {}, 'token统计');
        }

        // ④ 主流模型输出交给记忆模型记录，保持完整对话记忆
        try {
          await callMemoryHost('【AI 回复记录】\n' + aiText, 'auto');
        } catch (e) {
          addSystemMessage('? [步骤: 记录输出] 记忆模型记录回复失败: ' + e.message);
        }

        // 从AI回复第一条信息开始，标记为非首次消息
        isFirstMessage = false;
        handleAIResponse(aiText, streamed);
        updateResponseTime(startTime);
      } finally {
        cleanup();
      }
    } catch (e) {
      aiErr = e;
      logAIError('主流模型请求', e, { 模型: modelDisplayName(model), 请求地址: model.url });
      if (e && (e.name === AI_ABORT_NAME || (e.name === 'AbortError' && aiCancelled))) {
        addSystemMessage('? [步骤: 主流模型请求] 已取消');
      } else if (e.name === 'AbortError') {
        addSystemMessage('? [步骤: 主流模型请求] 请求已中止（可能超时），请在 AI 设置中调整“请求超时”后重试');
      } else {
        addSystemMessage('? [步骤: 主流模型请求] ' + e.message);
      }
    } finally {
      settleAIRequest(aiErr);
    }
  }

  // 读取流式响应（SSE）并逐块渲染 Markdown（需求1：流式分段输出）
  async function readStreamingResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let pending = '';
    let usage = null;
    // 创建 assistant 气泡，逐块更新内容
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg-wrap assistant-wrap';
    wrap.setAttribute('data-role', 'assistant');
    const bubble = document.createElement('div');
    bubble.className = 'ai-msg-assistant';
    wrap.appendChild(bubble);
    chatArea.appendChild(wrap);
    chatArea.scrollTop = chatArea.scrollHeight;
    const flush = () => {
      const html = renderMarkdown(fullText || '');
      if (bubble.innerHTML !== html) bubble.innerHTML = html;
      chatArea.scrollTop = chatArea.scrollHeight;
    };
    try {
      while (true) {
        // 需求一报错2：监听请求中断/连接关闭，主动销毁读取 Promise，防止消息通道残留报错
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.name === 'NetworkError')) break;
          throw e;
        }
        const { value, done } = chunk;
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.substring(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const obj = JSON.parse(jsonStr);
            const u = extractUsage(obj);
            if (u && (u.total_tokens != null)) usage = u;
            if (obj.choices && obj.choices[0] && obj.choices[0].delta) {
              const delta = obj.choices[0].delta.content || '';
              if (delta) { fullText += delta; }
            }
          } catch(e) {}
        }
        flush();
      }
      if (pending.trim() && pending.startsWith('data: ')) {
        const jsonStr = pending.substring(6).trim();
        if (jsonStr !== '[DONE]') {
          try {
            const obj = JSON.parse(jsonStr);
            const u = extractUsage(obj);
            if (u && (u.total_tokens != null)) usage = u;
            if (obj.choices && obj.choices[0] && obj.choices[0].delta) {
              const delta = obj.choices[0].delta.content || '';
              if (delta) fullText += delta;
            }
          } catch(e) {}
        }
      }
      flush();
      // 追加操作栏（复制 / 时分时间，AI 消息左侧）
      const actions = document.createElement('div');
      actions.className = 'ai-msg-actions';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'ai-msg-action-btn';
      copyBtn.dataset.act = 'copy';
      copyBtn.textContent = '复制';
      const time = document.createElement('span');
      time.className = 'ai-msg-time';
      const now = new Date();
      time.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      actions.appendChild(copyBtn);
      actions.appendChild(time);
      wrap.appendChild(actions);
      chatArea.scrollTop = chatArea.scrollHeight;
    } finally {
      reader.cancel && reader.cancel().catch(() => {});
    }
    if (!fullText) {
      fullText = decoder.decode();
    }
    // 需求二：接收返回数据时打印原始完整返回 JSON 原文（流式结束后汇总打印）
    if (fullText) logAIResponse('主流模型流式返回', fullText);
    return { aiText: fullText, usage };
  }

  // 从付费模型非流式响应中提取文本（兼容 JSON 多字段）
  function extractPaidText(data) {
    let aiText = data;
    try {
      const json = JSON.parse(data);
      if (json.error && json.error.message) {
        throw new Error('API 错误: ' + json.error.message);
      }
      if (json.choices && json.choices[0] && json.choices[0].message) {
        aiText = json.choices[0].message.content;
      } else if (json.data && typeof json.data === 'object' && json.data.message) {
        aiText = json.data.message;
      } else if (json.content) {
        aiText = json.content;
      } else if (json.response) {
        aiText = json.response;
      }
    } catch(e) {
      if (e.message && e.message.startsWith('API 错误')) throw e;
    }
    return typeof aiText === 'string' ? aiText : '';
  }

  // ---------- 免费 AI 预处理与数据同步（需求三/五） ----------
  function fmtLabel(fmt) {
    const map = { openai: 'OpenAI 格式', anthropic: 'Anthropic 格式', google: 'Google', responses: 'RESPONSES 格式' };
    return map[fmt] || fmt;
  }

  function buildProjectDataText() {
    if (items.length === 0) return '（当前没有任何项目）';
    return JSON.stringify(items.map(it => {
      const base = { id: it.id, type: it.type, hidden: !!it.hidden };
      if (it.type === 'function') return { ...base, expr: it.expr };
      if (it.type === 'point') return { ...base, label: it.label, x: it.x, y: it.y };
      if (it.type === 'param') return { ...base, name: it.name, value: it.value, min: it.min, max: it.max, step: it.step };
      if (it.type === 'segment' || it.type === 'line' || it.type === 'ray') {
        return {
          ...base, label: it.label,
          pointA: it.pointA ? { label: it.pointA.label, x: it.pointA.x, y: it.pointA.y } : null,
          pointB: it.pointB ? { label: it.pointB.label, x: it.pointB.x, y: it.pointB.y } : null,
          k: it.k, b: it.b
        };
      }
      return base;
    }), null, 1);
  }

  function appendExtraParams(url, extra) {
    const e = (extra || '').trim();
    if (!e) return url;
    const sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + (e.charAt(0) === '&' ? e.slice(1) : e);
  }

  function buildLegacyUrl(model, content) {
    const params = new URLSearchParams();
    if (model.contentParamKey) params.set(model.contentParamKey, content);

    // 旧版兼容模型：首次请求不携带记忆ID，让AI自己生成，从回复JSON中提取
    // 后续请求使用从响应中提取的 serverConvId
    if (model.memoryMode !== 'none' && !isFirstMessage) {
      const idVal = serverConvId || memoryId || '';
      if (idVal && model.memoryParamKey) {
        params.set(model.memoryParamKey, idVal);
      }
    }
    let url = model.url + (model.url.indexOf('?') >= 0 ? '&' : '?') + params.toString();
    url = appendExtraParams(url, model.tokenParamKey);
    return appendExtraParams(url, model.extraParams);
  }

  // 调用记忆托管模型处理/精简上下文（带超时）
  // memoryKey：'' 不带记忆（独立会话）；'auto' 使用主会话记忆（serverConvId||memoryId）；其他字符串作为独立会话ID
  async function callMemoryHost(text, memoryKey) {
    const host = getMemoryHostModel();
    if (!host) return null;
    let idVal = '';
    if (memoryKey === 'auto') idVal = serverConvId || memoryId || '';
    else if (memoryKey) idVal = memoryKey;

    try {
      if (host.category === 'legacy') {
        const params = new URLSearchParams();
        if (host.contentParamKey) params.set(host.contentParamKey, text);

        // 仅 none 模式不带记忆参数；auto/manual 均携带（auto 首次取 ID 前为空则不带）
        if (host.memoryMode !== 'none') {
          if (idVal && host.memoryParamKey) {
            params.set(host.memoryParamKey, idVal);
          }
        }
        let url = host.url + (host.url.indexOf('?') >= 0 ? '&' : '?') + params.toString();
        // Token 参数直接原样嵌入（如 token=xxx），不做自动计算
        url = appendExtraParams(url, host.tokenParamKey);
        url = appendExtraParams(url, host.extraParams);
        // 需求二：发起请求时打印完整拼接链接
        logAIRequest('记忆模型请求', url, 'GET', {}, { 记忆参数key: host.memoryParamKey, 会话ID: idVal || '(独立会话)' }, { 入参文本: text.slice(0, 800) });
        const { response, cleanup } = await performFetch(url, { method: 'GET' }, aiSettings.timeoutMs, '记忆模型请求');
        try {
          if (!response.ok) throwErrorByStatus(response, '记忆模型请求');
          // 兼容纯文本 / 非标准 JSON 响应：JSON 解析失败时回退读取原始文本
          let data;
          try {
            data = await response.json();
          } catch(e) {
            data = await response.text();
          }
          // 需求二：接收返回数据时打印原始完整返回 JSON 原文
          logAIResponse('记忆模型请求', typeof data === 'string' ? data : JSON.stringify(data));
          const ctx = extractLegacyText(data, host);
          const newId = extractMemoryIdFromData(data, host);
          if (newId && memoryKey === 'auto') serverConvId = newId;
          return { context: ctx, convId: newId || idVal };
        } finally {
          cleanup();
        }
      }

      // 主流模型作为记忆模型：OpenAI 格式（无记忆 ID，返回精简上下文）
      const key = (aiSettings.apiKey || '').trim();
      if (!key) {
        addSystemMessage('? [记忆模型] 当前默认记忆模型需要 API Key，请先在 AI 设置中配置');
        return null;
      }
      const messages = [
        { role: 'system', content: '你是函数绘制器 AI 的上下文处理器。请阅读以下内容并返回精简摘要，不得改变任何原始数据的含义与数值。' },
        { role: 'user', content: text }
      ];
      const bodyObj = { model: host.name, messages, stream: false };
      // 需求二：发起请求时打印完整请求体
      logAIRequest('记忆模型请求', host.url, 'POST', { Authorization: 'Bearer ' + key.slice(0, 6) + '...' }, bodyObj, { 会话ID: idVal || '(独立会话)' });
      const { response, cleanup } = await performFetch(host.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body: JSON.stringify(bodyObj) }, aiSettings.timeoutMs, '记忆模型请求');
      try {
        if (!response.ok) throwErrorByStatus(response, '记忆模型请求');
        const data = await response.text();
        // 需求二：接收返回数据时打印原始完整返回 JSON 原文
        logAIResponse('记忆模型请求', data);
        const ctx = extractPaidText(data);
        return { context: ctx, convId: '' };
      } finally {
        cleanup();
      }
    } catch (e) {
      logAIError('记忆模型请求', e, { 记忆模型: modelDisplayName(host) });
      throw e;
    }
  }

  // 新对话初始化：投喂项目全量数据 + 守则 → 记忆模型返回精简上下文 + 绑定记忆ID
  async function initMemoryContext() {
    if (freeInitInProgress) return null;
    freeInitInProgress = true;
    setRequestStatus('loading', '获取上下文中...');
    try {
      await ensureMemoryId();
      if (!memoryId) return null;
      const raw = buildProjectDataText();
      const rule = aiSettings.systemPrompt || '你是一个专业的函数绘制器助手。';
      const promptText = '请先阅读系统守则：\n' + rule + '\n\n请将以下项目全量数据简化为简洁的摘要文本，要求不改变任何原始数据的含义与数值，保留全部函数表达式、坐标点、参数与连线关系：\n' + raw;
      const result = await callMemoryHost(promptText, 'auto');
      if (result) {
        freeContextPrompt = result.context || '';
        if (result.convId && result.convId !== memoryId) serverConvId = result.convId;
        addSystemMessage('? 已获取记忆ID：' + memoryId + (serverConvId ? '（服务端会话：' + serverConvId + '）' : ''));
        return result;
      }
      return null;
    } catch (e) {
      addSystemMessage('? [步骤: 初始化记忆上下文] 记忆模型初始化失败: ' + e.message);
      return null;
    } finally {
      freeInitInProgress = false;
      setStatus('idle', '空闲');
      clearChatStatus();
    }
  }

  function markDataDirty() {
    freeDataDirty = true;
    updateSyncBtn();
  }

  function updateSyncBtn() {
    if (!syncBtn) return;
    if (freeDataDirty) {
      syncBtn.textContent = '项目数据发生改变';
      syncBtn.classList.add('dirty');
    } else {
      syncBtn.textContent = '数据同步';
      syncBtn.classList.remove('dirty');
    }
  }

  // 需求2：填充并打开同步数据查看框（只读）
  function fillViewSyncData() {
    const body = document.getElementById('aiViewBody');
    if (!body) return;
    if (freeContextPrompt) {
      body.classList.remove('ai-view-empty');
      body.textContent = '记忆ID：' + (memoryId || '无') + (serverConvId ? '\n服务端会话：' + serverConvId : '') + '\n\n' + freeContextPrompt;
    } else {
      body.classList.add('ai-view-empty');
      body.textContent = '暂无同步数据。\n\n点击「数据同步」按钮，将当前项目数据交由记忆模型化简后，即可在此查看结果。';
    }
  }

  function openViewSyncData() {
    const overlay = document.getElementById('aiViewOverlay');
    if (!overlay) return;
    fillViewSyncData();
    overlay.classList.add('visible');
  }

  function closeViewSyncData() {
    const overlay = document.getElementById('aiViewOverlay');
    if (overlay) overlay.classList.remove('visible');
  }

  // 数据同步：重新简化项目数据并更新全局上下文（使用免费接口，不消耗当前模型）
  async function syncProjectData() {
    if (freeSyncInProgress) return;
    freeSyncInProgress = true;
    if (syncBtn) syncBtn.disabled = true;
    setRequestStatus('loading', '获取上下文中...');
    try {
      const raw = buildProjectDataText();
      const rule = aiSettings.systemPrompt || '你是一个专业的函数绘制器助手。';
      const promptText = '请将以下项目全量数据简化为简洁的摘要文本，要求不改变任何原始数据的含义与数值，保留全部函数表达式、坐标点、参数与连线关系：\n' + raw;
      const result = await callMemoryHost(promptText, 'auto');
      if (result && result.context) {
        freeContextPrompt = result.context;
        if (result.convId && result.convId !== memoryId) serverConvId = result.convId;
        freeDataDirty = false;
        addSystemMessage('? 项目数据已同步，记忆模型上下文已更新');
      } else {
        addSystemMessage('? [步骤: 数据同步] 数据同步失败，请稍后重试');
      }
    } catch (e) {
      addSystemMessage('? [步骤: 数据同步] 数据同步失败: ' + e.message);
    } finally {
      freeSyncInProgress = false;
      if (syncBtn) syncBtn.disabled = false;
      updateSyncBtn();
      // 若查看框处于打开状态，同步完成后刷新内容
      const overlay = document.getElementById('aiViewOverlay');
      if (overlay && overlay.classList.contains('visible')) {
        fillViewSyncData();
      }
      setStatus('idle', '空闲');
      clearChatStatus();
    }
  }

  // ---------- 生成上下文摘要 ----------
  function generateContextSummary() {
    if (items.length === 0) return '当前没有项目';
    let summary = `共有 ${items.length} 个项目：\n`;
    const funcs = items.filter(i => i.type === 'function');
    const points = items.filter(i => i.type === 'point');
    const params = items.filter(i => i.type === 'param');
    const segs = items.filter(i => i.type === 'segment' || i.type === 'line' || i.type === 'ray');
    if (funcs.length) summary += `- 函数 ${funcs.length} 个：${funcs.map(f => f.id).join(', ')}\n`;
    if (points.length) summary += `- 坐标点 ${points.length} 个：${points.map(p => p.label || p.id).join(', ')}\n`;
    if (params.length) summary += `- 参数 ${params.length} 个：${params.map(p => p.name).join(', ')}\n`;
    if (segs.length) summary += `- 连线 ${segs.length} 个：${segs.map(s => s.label || s.id).join(', ')}\n`;
    if (selectedItemId) {
      const sel = items.find(i => i.id === selectedItemId);
      if (sel) summary += `当前选中：${sel.id} (${sel.type})`;
    }
    return summary;
  }

  // ---------- 模型列表管理（主流 + 旧版 两类） ----------
  function getAllModels() {
    return [...aiMainstreamModels, ...aiLegacyModels];
  }

  function findModel(id) {
    return aiMainstreamModels.find(m => m.id === id) || aiLegacyModels.find(m => m.id === id) || null;
  }

  // 外部显示名称：优先 displayName（旧版表新增首列），回退到内部 name
  function modelDisplayName(m) {
    if (!m) return '';
    return (m.displayName && String(m.displayName).trim()) || m.name || m.id;
  }

  // 免费 AI（旧版表内计费类型为免费的第一个模型），仅用于当前模型兜底回退
  function getFreeModel() {
    return aiLegacyModels.find(m => m.billing === 'free') || null;
  }

  // 上下文处理 AI 模型（AI 设置 → 默认记忆模型）：记忆托管、分类、规划、普通问答回复统一走它。
  // 不再硬依赖内置旧版 DeepSeek-V4；未设置时回退到当前对话模型。
  function getMemoryHostModel() {
    if (defaultMemoryModelId) {
      const m = findModel(defaultMemoryModelId);
      if (m) return m;
    }
    return findModel(currentModelId) || null;
  }

  function loadModels() {
    // 读取 v2 存储（{ mainstream:[], legacy:[] }）
    const stored = localStorage.getItem(MODELS_STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        aiMainstreamModels = Array.isArray(parsed.mainstream) ? parsed.mainstream : [];
        aiLegacyModels = Array.isArray(parsed.legacy) ? parsed.legacy : [];
      } catch(e) {
        aiMainstreamModels = [];
        aiLegacyModels = [];
      }
    } else {
      aiMainstreamModels = [];
      aiLegacyModels = [];
    }
    // 旧版存储 ai_models 迁移（首次升级）
    if (!aiMainstreamModels.length && !aiLegacyModels.length) {
      const old = localStorage.getItem('ai_models');
      if (old) {
        try {
          const oldArr = JSON.parse(old);
          if (Array.isArray(oldArr)) {
            oldArr.forEach(m => {
              if (m.type === 'free') {
                // 退休旧免费模型（如 id=deepseek）不迁移，保留内置预设 DeepSeek-V4-Pro
                if (RETIRED_PRESET_IDS.includes(m.id)) return;
                aiLegacyModels.push({
                  id: 'legacy-deepseek-v4-pro', name: m.name || 'DeepSeek-V4-Pro', category: 'legacy', preset: true,
                  url: m.url || FREE_MODEL_URL, method: 'GET', billing: 'free', stream: !!m.stream,
    memoryParamKey: 'conversation_id', contentParamKey: 'content', tokenParamKey: '', extraParams: '', memoryMode: 'auto', replyPath: '', memoryIdReplyPath: '',
                  displayName: m.name || 'DeepSeek-V4-Pro'
                });
              } else if (!RETIRED_PRESET_IDS.includes(m.id) && String(m.id).indexOf('paid-') !== 0) {
                aiMainstreamModels.push({
                  id: 'custom-m-' + Date.now() + Math.random().toString(36).slice(2, 6),
                  name: m.name || '自定义模型', category: 'mainstream', preset: false,
                  url: m.url || '', method: (m.method === 'GET') ? 'GET' : 'POST',
                  billing: m.type === 'paid' ? 'paid' : 'free', stream: !!m.stream,
                  systemSupport: !!m.systemSupport, memoryMode: 'auto', memoryIdReplyPath: ''
                });
              }
            });
          }
        } catch(e) {}
      }
    }
    // 确保内置预设都存在（缺失的重新补回）
    DEFAULT_MAINSTREAM_MODELS.forEach(d => {
      if (!aiMainstreamModels.some(m => m.id === d.id)) aiMainstreamModels.push(deepClone(d));
    });
    DEFAULT_LEGACY_MODELS.forEach(d => {
      if (!aiLegacyModels.some(m => m.id === d.id)) aiLegacyModels.push(deepClone(d));
    });
    // 旧版模型字段归一化：补 displayName（旧数据升级）
    aiLegacyModels.forEach(m => {
      if (m.displayName == null || !String(m.displayName).trim()) m.displayName = m.name || m.id;
      if (m.replyPath == null) m.replyPath = '';
    });
    // 加载默认记忆模型设置
    defaultMemoryModelId = localStorage.getItem(DEFAULT_MEMORY_MODEL_KEY) || '';
    // 恢复当前对话的记忆 ID（auto 提取的会话 ID 或 manual 输入的 6 位数字）
    const cachedMem = localStorage.getItem(MEMORY_ID_KEY);
    if (cachedMem) memoryId = cachedMem;
    // 确保当前模型有效
    if (!findModel(currentModelId)) {
      currentModelId = ((getFreeModel() || aiLegacyModels[0] || getAllModels()[0]) || DEFAULT_LEGACY_MODELS[0]).id;
    }
    renderModelSelect();
    updateModelTag();
    updateDialogTitle();
    renderDefaultMemoryModel();
    renderAllModelTables();
  }

  function saveModels() {
    localStorage.setItem(MODELS_STORAGE_KEY, JSON.stringify({ mainstream: aiMainstreamModels, legacy: aiLegacyModels }));
  }

  // 任一模型属性变更后的统一刷新
  function onModelChange() {
    saveModels();
    renderModelSelect();
    updateModelTag();
    updateDialogTitle();
    renderDefaultMemoryModel();
    renderAllModelTables();
  }

  function removeModel(model) {
    if (model.category === 'mainstream') {
      aiMainstreamModels = aiMainstreamModels.filter(m => m.id !== model.id);
    } else {
      aiLegacyModels = aiLegacyModels.filter(m => m.id !== model.id);
    }
    if (currentModelId === model.id) {
      currentModelId = ((getFreeModel() || aiLegacyModels[0] || getAllModels()[0]) || DEFAULT_LEGACY_MODELS[0]).id;
    }
    if (defaultMemoryModelId === model.id) defaultMemoryModelId = '';
    onModelChange();
  }

  function addCustomModel(category) {
    if (category === 'legacy') {
      // 需求四：自定义新增旧模型必须填写「外部显示名称」，否则无法保存条目
      let dname = '';
      while (true) {
        dname = prompt('请输入旧版模型的外部显示名称（必填，用于下拉选择展示）', '');
        if (dname === null) return;
        dname = String(dname).trim();
        if (dname) break;
        alert('外部显示名称不能为空，请重新输入');
      }
      const n = aiLegacyModels.filter(m => !m.preset).length + 1;
      aiLegacyModels.push({
        id: 'custom-l-' + Date.now(), name: 'custom-l-' + Date.now(), displayName: dname, category: 'legacy', preset: false,
        url: '', method: 'GET', billing: 'free', stream: false,
        memoryParamKey: '', contentParamKey: 'content', tokenParamKey: '', extraParams: '', memoryMode: 'auto', replyPath: '', memoryIdReplyPath: '',
      });
      onModelChange();
      return;
    }
    const ts = Date.now();
    aiMainstreamModels.push({
      id: 'custom-m-' + ts, name: '新模型', category: 'mainstream', preset: false,
      url: '', method: 'POST', billing: 'paid', stream: true, systemSupport: true, memoryMode: 'none', memoryIdReplyPath: ''
    });
    onModelChange();
  }

  function restoreDefaultModels() {
    if (!confirm('确定要恢复默认吗？\n将删除所有用户新增的自定义模型，并重置内置预设模型的全部属性为初始默认值。\n（旧版模型的 Token 参数将被保留，不会被清空）')) return;
    // 需求四：重置预设时保留旧模型已配置的 Token 参数与显示名称，不被预设默认值覆盖
    const prevLegacy = new Map(aiLegacyModels.map(m => [m.id, m]));
    aiMainstreamModels = deepClone(DEFAULT_MAINSTREAM_MODELS);
    aiLegacyModels = deepClone(DEFAULT_LEGACY_MODELS).map(m => {
      const p = prevLegacy.get(m.id);
      if (p) {
        m.tokenParamKey = p.tokenParamKey || '';
        m.replyPath = p.replyPath || '';
        m.displayName = p.displayName || m.displayName;
      }
      return m;
    });
    currentModelId = aiLegacyModels[0].id;
    defaultMemoryModelId = '';
    localStorage.setItem(DEFAULT_MEMORY_MODEL_KEY, '');
    onModelChange();
    addSystemMessage('? 模型列表已恢复默认（自定义模型已删除，预设属性已重置，旧模型 Token 参数已保留）');
  }

  function renderModelSelect() {
    if (!modelSelect) return;
    modelSelect.innerHTML = '';
    getAllModels().forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = modelDisplayName(m) + (m.billing === 'free' ? ' (免费)' : ' (付费)');
      if (m.id === currentModelId) opt.selected = true;
      modelSelect.appendChild(opt);
    });
    updateModelTag();
  }

  function updateModelTag() {
    const model = findModel(currentModelId);
    if (model) {
      const tag = model.billing === 'free' ? '免费' : '付费';
      modelTag.textContent = tag;
      modelTag.className = 'model-tag ' + (model.billing === 'free' ? 'free' : 'paid');
    }
  }

  // 对话框标题：AI 助手 | 记忆ID:xxxxxx
  function updateDialogTitle() {
    if (titleTextEl) {
      titleTextEl.textContent = 'AI 助手' + (memoryId ? ' | 记忆ID:' + memoryId : '');
    }
  }

  // 默认记忆模型下拉：无 + 两表全部模型名称
  function renderDefaultMemoryModel() {
    if (!defaultMemorySelect) return;
    defaultMemorySelect.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '无';
    if (!defaultMemoryModelId) noneOpt.selected = true;
    defaultMemorySelect.appendChild(noneOpt);
    getAllModels().forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = modelDisplayName(m) + (m.billing === 'free' ? ' (免费)' : ' (付费)');
      if (m.id === defaultMemoryModelId) opt.selected = true;
      defaultMemorySelect.appendChild(opt);
    });
  }

  // ---------- 模型管理弹窗表格 ----------
  function cellInput(value, onChange, opts) {
    opts = opts || {};
    const td = document.createElement('td');
    const inp = document.createElement('input');
    inp.value = (value == null ? '' : value);
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    if (opts.readonly) inp.readOnly = true;
    if (opts.disabled) inp.disabled = true;
    if (opts.title) inp.title = opts.title;
    if (opts.className) inp.className = opts.className;
    inp.addEventListener('change', () => onChange(inp.value.trim()));
    td.appendChild(inp);
    if (opts.hint) {
      const hint = document.createElement('span');
      hint.className = opts.hintClass || 'token-locked-hint';
      hint.textContent = opts.hint;
      td.appendChild(hint);
    }
    return td;
  }

  function cellSelect(opts, value, onChange, label) {
    const td = document.createElement('td');
    const sel = document.createElement('select');
    opts.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = label ? label(o) : o;
      if (String(value) === o) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => onChange(sel.value));
    td.appendChild(sel);
    return td;
  }

  function cellDelete(model) {
    const td = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'ai-model-del';
    btn.textContent = '删除';
    btn.title = model.preset ? '内置预设，删除后刷新页面会恢复' : '删除该自定义模型';
    btn.addEventListener('click', () => {
      if (confirm('确认删除模型「' + (model.name || model.url || model.id) + '」吗？')) removeModel(model);
    });
    td.appendChild(btn);
    return td;
  }

  // ---------- 需求二：模型表列宽拖拽 ----------
  const MODEL_COL_KEY = 'ai_model_col_widths';
  const COL_MIN = 60, COL_MAX = 420;
  function loadModelColWidths() {
    try { return JSON.parse(localStorage.getItem(MODEL_COL_KEY)) || {}; } catch(e) { return {}; }
  }
  function saveModelColWidths(obj) {
    try { localStorage.setItem(MODEL_COL_KEY, JSON.stringify(obj)); } catch(e) {}
  }
  // 依据 tbody id 区分表（mainstream / legacy）
  function colTableKey(tbody) {
    if (!tbody) return '';
    return tbody.id === 'aiLegacyTbody' ? 'legacy' : 'mainstream';
  }
  function initColumnResize() {
    const tables = document.querySelectorAll('.ai-model-table');
    tables.forEach(function(table) {
      // 动态注入拖拽手柄（每个 th 右侧）
      table.querySelectorAll('thead th').forEach(function(th, i) {
        if (th.querySelector('.th-resizer')) return;
        const rz = document.createElement('div');
        rz.className = 'th-resizer';
        rz.title = '拖拽调整列宽';
        th.appendChild(rz);
      });
      // 恢复已保存列宽（仅设置有过拖拽记录的列，其余保持 auto 均分）
      const tbody = table.querySelector('tbody');
      const key = colTableKey(tbody);
      const saved = loadModelColWidths()[key];
      if (saved && Array.isArray(saved)) {
        table.querySelectorAll('thead th').forEach(function(th, i) {
          const w = saved[i];
          if (w && w >= COL_MIN && w <= COL_MAX) th.style.width = w + 'px';
        });
      }
    });
    bindColumnResize();
  }

  let colResize = null; // { table, key, ths[], idx, startX, startW[], active }
  function bindColumnResize() {
    document.querySelectorAll('.ai-model-table .th-resizer').forEach(function(rz) {
      rz.addEventListener('mousedown', function(e) {
        e.preventDefault(); e.stopPropagation();
        const th = rz.parentElement;
        const table = th.closest('.ai-model-table');
        if (!table) return;
        const tbody = table.querySelector('tbody');
        const key = colTableKey(tbody);
        const ths = Array.prototype.slice.call(table.querySelectorAll('thead th'));
        const idx = ths.indexOf(th);
        if (idx < 0) return;
        const startW = ths.map(function(t) { return t.getBoundingClientRect().width; });
        colResize = { table: table, key: key, ths: ths, idx: idx, startX: e.clientX, startW: startW, active: rz };
        rz.classList.add('active');
        table.classList.add('col-resizing');
        document.body.style.userSelect = 'none';
      });
    });
  }

  document.addEventListener('mousemove', function(e) {
    if (!colResize) return;
    const c = colResize;
    const table = c.table;
    const container = table.closest('.ai-model-table-scroll');
    const containerW = container ? container.clientWidth : 0;
    const saved = loadModelColWidths()[c.key] || [];
    // 其它已固定列保留宽度，未固定列按最小宽度预留，保证总和不溢出容器
    let fixedSum = 0, autoCount = 0;
    c.ths.forEach(function(t, i) {
      if (i === c.idx) return;
      const w = saved[i];
      if (w && w >= COL_MIN && w <= COL_MAX) fixedSum += Math.min(w, COL_MAX);
      else autoCount++;
    });
    const maxW = containerW > 0 ? Math.max(COL_MIN, containerW - fixedSum - autoCount * COL_MIN) : COL_MAX;
    const delta = e.clientX - c.startX;
    const w = Math.max(COL_MIN, Math.min(COL_MAX, Math.min(maxW, c.startW[c.idx] + delta)));
    c.ths[c.idx].style.width = w + 'px';
  });

  document.addEventListener('mouseup', function() {
    if (!colResize) return;
    const c = colResize;
    if (c.active) c.active.classList.remove('active');
    if (c.table) c.table.classList.remove('col-resizing');
    document.body.style.userSelect = '';
    // 只持久化当前被拖拽的列宽（其它列保持 auto，避免总和溢出）
    const store = loadModelColWidths();
    const arr = store[c.key] || [];
    arr[c.idx] = Math.round(c.ths[c.idx].getBoundingClientRect().width);
    store[c.key] = arr;
    saveModelColWidths(store);
    colResize = null;
  });

  function renderMainstreamTable() {
    if (!mainstreamTbody) return;
    mainstreamTbody.innerHTML = '';
    aiMainstreamModels.forEach(m => {
      const tr = document.createElement('tr');
      const nameTd = cellInput(m.name, v => { m.name = v || m.name; onModelChange(); });
      const urlTd = cellInput(m.url, v => { m.url = v; onModelChange(); });
      const methodTd = cellSelect(['POST', 'GET'], m.method, v => { m.method = v; onModelChange(); });
      const billingTd = cellSelect(['paid', 'free'], m.billing, v => { m.billing = v; onModelChange(); }, v => (v === 'paid' ? '付费' : '免费'));
      const streamTd = cellSelect(['true', 'false'], String(m.stream), v => { m.stream = (v === 'true'); onModelChange(); }, v => (v === 'true' ? '是' : '否'));
      const sysTd = cellSelect(['true', 'false'], String(m.systemSupport), v => { m.systemSupport = (v === 'true'); onModelChange(); }, v => (v === 'true' ? '是' : '否'));
      const memTd = cellSelect(['auto', 'manual', 'none'], m.memoryMode, v => { m.memoryMode = v; onModelChange(); }, v => (v === 'auto' ? '模型自动生成ID' : v === 'manual' ? '用户手动输入ID' : '无记忆'));
      const idPathTd = cellInput(m.memoryIdReplyPath, v => { m.memoryIdReplyPath = v; onModelChange(); }, { placeholder: '如 data.conversation_id', title: 'auto 模式下从响应 JSON 提取记忆 ID 的字段路径（未填时多级兜底）' });
      tr.append(nameTd, urlTd, methodTd, billingTd, streamTd, sysTd, memTd, idPathTd);

      // ---- 新增：调试按钮 ----
      const debugTd = document.createElement('td');
      const debugBtn = document.createElement('button');
      debugBtn.className = 'ai-model-debug';
      debugBtn.textContent = '调试';
      debugBtn.title = '调试此模型（发送测试请求）';
      debugBtn.dataset.modelId = m.id;
      debugBtn.style.cssText = 'border:1px solid #6366f1; background:#eef2ff; color:#6366f1; border-radius:4px; cursor:pointer; padding:2px 10px; font-size:12px;';
      debugTd.appendChild(debugBtn);
      tr.appendChild(debugTd);

      // 删除按钮
      const delTd = cellDelete(m);
      tr.appendChild(delTd);

      mainstreamTbody.appendChild(tr);
    });
  }

  function renderLegacyTable() {
    if (!legacyTbody) return;
    legacyTbody.innerHTML = '';
    aiLegacyModels.forEach(m => {
      const tr = document.createElement('tr');
      const nameTd = cellInput(modelDisplayName(m), v => {
        if (!v) { alert('外部显示名称不能为空'); return; }
        m.displayName = v;
        m.name = m.name || v;
        onModelChange();
      }, { placeholder: '必填' });
      const urlTd = cellInput(m.url, v => { m.url = v; onModelChange(); });
      const methodTd = document.createElement('td');
      methodTd.textContent = 'GET';
      methodTd.style.color = '#94a3b8';
      const billingTd = cellSelect(['free', 'paid'], m.billing, v => { m.billing = v; onModelChange(); }, v => (v === 'free' ? '免费' : '付费'));
      const streamTd = cellSelect(['false', 'true'], String(m.stream), v => { m.stream = (v === 'true'); onModelChange(); }, v => (v === 'true' ? '是' : '否'));
      const memKeyTd = cellInput(m.memoryParamKey, v => { m.memoryParamKey = v; onModelChange(); }, { placeholder: '空=无记忆', title: '请求时携带记忆 ID 的参数名' });
      const contentKeyTd = cellInput(m.contentParamKey, v => { m.contentParamKey = v || 'content'; onModelChange(); });
      const replyTd = cellInput(m.replyPath, v => { m.replyPath = v; onModelChange(); }, { placeholder: '如 data.message', title: '按该字段路径从响应 JSON 中提取 AI 回复内容' });
      const idPathTd = cellInput(m.memoryIdReplyPath, v => { m.memoryIdReplyPath = v; onModelChange(); }, { placeholder: '如 data.conversation_id', title: 'auto 模式下从响应 JSON 提取记忆 ID 的字段路径（未填时多级兜底）' });
      const tokenTd = cellInput(m.tokenParamKey, v => {
        m.tokenParamKey = v;
        onModelChange();
      }, { placeholder: '如 token=xxx' });
      const extraTd = cellInput(m.extraParams, v => {
        m.extraParams = v && v.indexOf('&') !== 0 ? '&' + v : v;
        onModelChange();
      }, { placeholder: '&key=value' });
      const memModeTd = cellSelect(['auto', 'manual', 'none'], m.memoryMode, v => { m.memoryMode = v; onModelChange(); }, v => (v === 'auto' ? '模型自动生成ID' : v === 'manual' ? '用户手动输入ID' : '无记忆'));
      if (!m.memoryParamKey) {
        const sel = memModeTd.querySelector('select');
        if (sel) { sel.disabled = true; sel.style.opacity = '0.5'; sel.title = '记忆参数key为空（无记忆功能）时不可修改'; }
      }
      tr.append(nameTd, urlTd, methodTd, billingTd, streamTd, memKeyTd, contentKeyTd, replyTd, idPathTd, tokenTd, extraTd, memModeTd);

      // ---- 新增：调试按钮 ----
      const debugTd = document.createElement('td');
      const debugBtn = document.createElement('button');
      debugBtn.className = 'ai-model-debug';
      debugBtn.textContent = '调试';
      debugBtn.title = '调试此模型（发送测试请求）';
      debugBtn.dataset.modelId = m.id;
      debugBtn.style.cssText = 'border:1px solid #6366f1; background:#eef2ff; color:#6366f1; border-radius:4px; cursor:pointer; padding:2px 10px; font-size:12px;';
      debugTd.appendChild(debugBtn);
      tr.appendChild(debugTd);

      // 删除按钮
      const delTd = cellDelete(m);
      tr.appendChild(delTd);

      legacyTbody.appendChild(tr);
    });
  }

  function renderAllModelTables() {
    renderMainstreamTable();
    renderLegacyTable();
  }

  function openModelManager() {
    if (modelManagerOverlay) modelManagerOverlay.classList.add('visible');
  }

  function closeModelManager() {
    if (modelManagerOverlay) modelManagerOverlay.classList.remove('visible');
  }

  // ---------- 对话框显示/隐藏 ----------
  function toggleAIDialog() {
    // 关闭对话框不需要登录检查
    if (isVisible) { doToggleAIDialog(); return; }
    // 需求：使用 AI 对话需登录（未登录先弹登录窗，登录成功后再打开对话框）
    if (window.UserAuth && !window.UserAuth.isLoggedIn()) {
      if (window.UserAuth && UserAuth.showToast) UserAuth.showToast('请先登录后再使用 AI 对话');
      if (window.UserAuth) UserAuth.requireLogin().then(function(ok){ if(ok) doToggleAIDialog(); });
      return;
    }
    doToggleAIDialog();
  }
  function doToggleAIDialog() {
    if (!dialog) {
      console.warn('AI 对话框尚未初始化');
      return;
    }
    if (isVisible) {
      dialog.classList.remove('visible');
      dialog.style.display = 'none';
      isVisible = false;
    } else {
      dialog.style.display = 'flex';
      dialog.classList.add('visible');
      isVisible = true;
      if (!dialog.dataset.moved) {
        dialog.style.top = '50%';
        dialog.style.left = '50%';
        dialog.style.transform = 'translate(-50%, -50%)';
        dialog.style.width = '620px';
        dialog.style.height = '520px';
      }
    }
  }

  // ---------- AI 请求忙状态与中断（发送 ⇄ 取消） ----------
  function setBusy(busy) {
    aiBusy = !!busy;
    if (!sendBtn) return;
    sendBtn.textContent = busy ? '取消' : '发送';
    sendBtn.classList.toggle('cancel', busy);
    sendBtn.title = busy ? '取消当前 AI 请求' : '发送消息';
  }

  function beginAIOperation() {
    aiCancelled = false;
    aiAbortController = new AbortController();
    aiSleepCanceller = null;
    setBusy(true);
  }

  function endAIOperation() {
    aiSleepCanceller = null;
    aiAbortController = null;
    setBusy(false);
  }

  // 点击「取消」：终止流式监听 + 断开请求链路 + 丢弃未渲染分片 + 计时器清零 + 步骤卡锁定
  function cancelAIOperation() {
    aiCancelled = true;
    if (aiAbortController) aiAbortController.abort();
    if (aiSleepCanceller) { const c = aiSleepCanceller; aiSleepCanceller = null; c(); }
    resetResponseTime();
    // 需求三：将未完成的步骤卡标记为「已取消」，避免停留在「待执行/执行中」
    document.querySelectorAll('.ai-step-card').forEach(function(card) {
      const isPending = card.classList.contains('pending') || card.classList.contains('running');
      if (isPending) {
        updateStepCard(card, 'error', '已取消');
        appendStepResult(card, '用户点击「取消」，本步骤已中止', false);
      }
    });
    // 用户取消后删除对话区下方的步骤执行状态条
    hideStepsBar();
    // 需求三：恢复状态文本
    setRequestStatus('idle', '已取消');
    addSystemMessage('? 已取消本次 AI 请求（流式监听已终止，请求链路已断开，未渲染分片已丢弃）');
  }

  // 发送（空闲 → 请求；请求中 → 取消）
  function handleSend() {
    if (aiBusy) { cancelAIOperation(); return; }
    const text = input.value.trim();
    if (!text) return;
    addMessage('user', text);
    input.value = '';
    sendToAI(text);
  }

  // 事件绑定（技能按钮、模型选择、回退、设置同步、添加模型等）集中到 bindAllEvents()，
  // 在 initAI() 中统一绑定，避免 DOM 元素未就绪时对 null 引用抛错。
  // 对话框拖拽/缩放逻辑在 initAI() 中绑定。

  // 加载保存的设置
  function loadSettings() {

    // loadSettings 中增加：
    /*
    const stepsFmt = localStorage.getItem('ai_steps_format');
    if (stepsFmt !== null) {
      aiSettings.stepsFormat = stepsFmt;
      if (document.getElementById('stepsFormatTextarea')) {
        document.getElementById('stepsFormatTextarea').value = stepsFmt;
      }
    }*/
    const stepsFmt = localStorage.getItem('ai_steps_format');
    if (stepsFmt !== null) {
      aiSettings.stepsFormat = stepsFmt;
      // 注意：stepsFormatTextarea 元素已被移除，不再需要 DOM 赋值
    } else {
      // 无已保存守则时回退默认（不覆盖已保存内容）
      aiSettings.stepsFormat = DEFAULT_STEPS_FORMAT;
    }

    // AI 判定守则（第4项）：首次使用 HTML 默认值，之后以用户保存为准
    const classifyFmt = localStorage.getItem('ai_classify_prompt');
    if (classifyFmt !== null) {
      aiSettings.classifyPrompt = classifyFmt;
    } else if (rulesClassifyPrompt) {
      aiSettings.classifyPrompt = rulesClassifyPrompt.value || DEFAULT_CLASSIFY_RULE;
    } else {
      aiSettings.classifyPrompt = DEFAULT_CLASSIFY_RULE;
    }

    // 版本迁移：老版本曾把「自动上下文」默认关闭并持久化（localStorage 存 ai_auto_context=0），
    // 本次升级后强制恢复为默认开启一次；用户之后在设置面板手动开关仍会正常保存覆盖。
    if (!localStorage.getItem('ai_settings_version')) {
      aiSettings.autoContext = true;
      autoContextCheck.checked = true;
      localStorage.setItem('ai_auto_context', '1');
      localStorage.setItem('ai_settings_version', '1');
    }
    const savedPrompt = localStorage.getItem('ai_system_prompt');
    if (savedPrompt !== null) {
      aiSettings.systemPrompt = savedPrompt;
      if (systemPromptInput) systemPromptInput.value = savedPrompt;
    } else {
      // 无已保存守则时回退默认（不覆盖已保存内容）
      aiSettings.systemPrompt = DEFAULT_SYSTEM;
      if (systemPromptInput) systemPromptInput.value = DEFAULT_SYSTEM;
    }
    // AI 执行步骤守则（第3项）：首次使用 HTML 默认值，之后以用户保存为准
    const savedExecSteps = localStorage.getItem('ai_execute_steps_prompt');
    if (savedExecSteps !== null) {
      aiSettings.executeStepsPrompt = savedExecSteps;
    } else if (rulesExecuteSteps) {
      aiSettings.executeStepsPrompt = rulesExecuteSteps.value || '';
    }
    const autoCtx = localStorage.getItem('ai_auto_context');
    if (autoCtx !== null) {
      aiSettings.autoContext = autoCtx === '1';
      autoContextCheck.checked = aiSettings.autoContext;
    }
    const snapCount = localStorage.getItem('ai_snapshot_count');
    if (snapCount !== null) {
      snapshotMax = parseInt(snapCount) || 20;
      snapshotCountInput.value = snapshotMax;
    }
    const streamSet = localStorage.getItem('ai_streaming');
    if (streamSet !== null) {
      aiSettings.streaming = streamSet === '1';
      streamingCheck.checked = aiSettings.streaming;
    }
    const fmtSet = localStorage.getItem('ai_request_format');
    if (fmtSet !== null && ['openai', 'anthropic', 'google', 'responses'].includes(fmtSet)) {
      aiSettings.requestFormat = fmtSet;
      requestFormatSelect.value = fmtSet;
    }
    const keySet = localStorage.getItem('ai_api_key');
    if (keySet !== null) {
      aiSettings.apiKey = keySet;
      apiKeyInput.value = keySet;
    }
    // DeepSeek 禁用思考开关
    const dsThinking = localStorage.getItem('ai_ds_disable_thinking');
    if (dsThinking !== null) {
      aiSettings.deepseekDisableThinking = dsThinking === '1';
      if (deepseekThinkingCheck) deepseekThinkingCheck.checked = aiSettings.deepseekDisableThinking;
    }
    // 需求10：请求超时（秒）
    const timeoutSet = localStorage.getItem('ai_timeout');
    if (timeoutSet !== null) {
      const t = parseInt(timeoutSet);
      if (!isNaN(t) && t >= 30 && t <= 600) {
        aiSettings.timeoutMs = t * 1000;
        if (timeoutInput) timeoutInput.value = t;
      }
    }
    // 步骤失败重试开关 + 次数
    const retryEnabled = localStorage.getItem('ai_step_retry_enabled');
    if (retryEnabled !== null) {
      aiSettings.stepRetryEnabled = retryEnabled === '1';
      if (stepRetryCheck) stepRetryCheck.checked = aiSettings.stepRetryEnabled;
    }
    const retryCount = localStorage.getItem('ai_step_retry_count');
    if (retryCount !== null) {
      const rc = parseInt(retryCount);
      if (!isNaN(rc) && rc >= 0 && rc <= 10) {
        aiSettings.stepRetryCount = rc;
        if (stepRetryCountInput) stepRetryCountInput.value = rc;
      }
    }
    // 加载历史快照
    try {
      const stored = localStorage.getItem('ai_snapshots');
      if (stored) {
        snapshots = JSON.parse(stored);
        if (!Array.isArray(snapshots)) snapshots = [];
      }
    } catch(e) {}
  }
  let rulesModalOverlay = document.getElementById('rulesModalOverlay');
  let rulesCloseBtn = document.getElementById('rulesModalCloseBtn');
  let rulesSystemPrompt = document.getElementById('rulesSystemPrompt');
  let rulesStepsFormat = document.getElementById('rulesStepsFormat');
  let rulesExecuteSteps = document.getElementById('rulesExecuteSteps');
  let rulesClassifyPrompt = document.getElementById('rulesClassifyPrompt');
  let rulesSaveBtn = document.getElementById('rulesSaveBtn');
  let rulesRestoreDefaultBtn = document.getElementById('rulesRestoreDefaultBtn');
  let rulesCancelBtn = document.getElementById('rulesCancelBtn');
  // 四栏守则的 HTML 默认值（供「恢复默认」一键恢复使用，捕获于首次读取后不再变化）
  let rulesDefaults = { system: '', stepsFormat: '', executeSteps: '', classify: '' };
  let openRulesBtn = document.getElementById('openRulesBtn');
  // 外部链接导入列表（指令集）模态框
  let linkSetOverlay = document.getElementById('linkSetOverlay');
  let linkSetCloseBtn = document.getElementById('linkSetCloseBtn');
  let linkSetCancelBtn = document.getElementById('linkSetCancelBtn');
  let linkSetSaveBtn = document.getElementById('linkSetSaveBtn');
  let linkSetAddBtn = document.getElementById('linkSetAddBtn');
  let linkSetListEl = document.getElementById('linkSetList');
  let linkSetBarBtn = document.getElementById('aiLinkSetBarBtn');
  let openLinkSetBtn = document.getElementById('openLinkSetBtn');
  // 初始化
  function initAI() {
    // ---- 获取所有 DOM 元素 ----
    dialog = document.getElementById('aiDialog');
    if (!dialog) {
      console.error('AI 对话框未找到，请检查 HTML');
      return;
    }
    rulesModalOverlay = document.getElementById('rulesModalOverlay');
    rulesCloseBtn = document.getElementById('rulesModalCloseBtn');
    rulesSystemPrompt = document.getElementById('rulesSystemPrompt');
    rulesStepsFormat = document.getElementById('rulesStepsFormat');
    rulesExecuteSteps = document.getElementById('rulesExecuteSteps');
    rulesClassifyPrompt = document.getElementById('rulesClassifyPrompt');
    rulesSaveBtn = document.getElementById('rulesSaveBtn');
    rulesRestoreDefaultBtn = document.getElementById('rulesRestoreDefaultBtn');
    rulesCancelBtn = document.getElementById('rulesCancelBtn');
    // 捕获四栏守则的 HTML 初始默认值（首次加载后不再变化），供「恢复默认」使用
    rulesDefaults.system = (rulesSystemPrompt && rulesSystemPrompt.value) || '';
    rulesDefaults.stepsFormat = (rulesStepsFormat && rulesStepsFormat.value) || '';
    rulesDefaults.executeSteps = (rulesExecuteSteps && rulesExecuteSteps.value) || '';
    rulesDefaults.classify = (rulesClassifyPrompt && rulesClassifyPrompt.value) || DEFAULT_CLASSIFY_RULE;
    openRulesBtn = document.getElementById('openRulesBtn');
    linkSetOverlay = document.getElementById('linkSetOverlay');
    linkSetCloseBtn = document.getElementById('linkSetCloseBtn');
    linkSetCancelBtn = document.getElementById('linkSetCancelBtn');
    linkSetSaveBtn = document.getElementById('linkSetSaveBtn');
    linkSetAddBtn = document.getElementById('linkSetAddBtn');
    linkSetListEl = document.getElementById('linkSetList');
    linkSetBarBtn = document.getElementById('aiLinkSetBarBtn');
    openLinkSetBtn = document.getElementById('openLinkSetBtn');
    loadLinkSetList();

    titleBar = document.getElementById('aiTitleBar');
    closeBtn = document.getElementById('aiCloseBtn');
    chatArea = document.getElementById('aiChatArea');
    input = document.getElementById('aiInput');
    sendBtn = document.getElementById('aiSendBtn');
    statusText = document.getElementById('aiStatusText');
    statusDot = document.getElementById('aiStatusDot');
    resizeHandle = document.getElementById('aiResizeHandle');
    modelSelect = document.getElementById('aiModelSelect');
    modelTag = document.getElementById('aiModelTag');
    rollbackBtn = document.getElementById('aiRollbackBtn');
    syncBtn = document.getElementById('aiSyncBtn');
    viewSyncBtn = document.getElementById('aiViewSyncBtn');
    responseTimeEl = document.getElementById('aiResponseTime');
    systemPromptInput = document.getElementById('aiSystemPrompt');
    autoContextCheck = document.getElementById('aiAutoContext');
    snapshotCountInput = document.getElementById('aiSnapshotCount');
    streamingCheck = document.getElementById('aiStreaming');
    requestFormatSelect = document.getElementById('aiRequestFormatSelect');
    apiKeyInput = document.getElementById('aiApiKeyInput');
    timeoutInput = document.getElementById('aiTimeout');
    deepseekThinkingCheck = document.getElementById('aiDeepSeekThinking');
    stepRetryCheck = document.getElementById('aiStepRetryEnabled');
    stepRetryCountInput = document.getElementById('aiStepRetryCount');
    toolListContainer = document.getElementById('aiToolListContainer');
    toolListUrlInput = document.getElementById('aiToolListUrl');
    simpleToolListUrlInput = document.getElementById('aiSimpleToolListUrl');
    toolReloadBtn = document.getElementById('aiToolReloadBtn');
    inputBar = document.getElementById('aiInputBar');
    aiStepsBar = document.getElementById('aiStepsBar');
    titleTextEl = document.querySelector('#aiTitleBar .ai-title-text');
    // 模型管理弹窗
    modelManagerOverlay = document.getElementById('aiModelOverlay');
    modelCloseBtn = document.getElementById('aiModelCloseBtn');
    mainstreamTbody = document.getElementById('aiMainstreamTbody');
    legacyTbody = document.getElementById('aiLegacyTbody');
    addMainstreamBtn = document.getElementById('aiAddMainstreamBtn');
    addLegacyBtn = document.getElementById('aiAddLegacyBtn');
    addCustomBtn = document.getElementById('aiAddCustomBtn');
    restoreDefaultBtn = document.getElementById('aiRestoreDefaultBtn');
    modelManagerTitle = document.getElementById('aiModelManagerTitle');
    // 默认记忆模型下拉
    defaultMemorySelect = document.getElementById('aiDefaultMemoryModel');
    // 聊天功能区
    chatDock = document.getElementById('aiChatDock');
    dockHandle = document.getElementById('aiChatDockHandle');

    // ---- 加载数据 ----
    loadModels();
    loadSettings();
    // 需求3：加载工具列表（缓存 → 远程 → 内置）
    if (toolListUrlInput) toolListUrlInput.value = localStorage.getItem(TOOL_LIST_URL_KEY) || '';
    // 需求三：无自定义地址时默认填入指定 URL，并自动拉取一次
    const savedToolUrl = (localStorage.getItem(TOOL_LIST_URL_KEY) || '').trim();
    if (!savedToolUrl && DEFAULT_TOOL_LIST_URL) {
      localStorage.setItem(TOOL_LIST_URL_KEY, DEFAULT_TOOL_LIST_URL);
    }
    if (toolListUrlInput) toolListUrlInput.value = (savedToolUrl || DEFAULT_TOOL_LIST_URL);
    initToolList(false);

    // 简易工具列表（记忆模型规划 tool_idx 用）：无自定义地址时默认填入指定 URL 并拉取一次
    const savedSimpleUrl = (localStorage.getItem(SIMPLE_TOOL_LIST_URL_KEY) || '').trim();
    if (!savedSimpleUrl && DEFAULT_SIMPLE_TOOL_LIST_URL) {
      localStorage.setItem(SIMPLE_TOOL_LIST_URL_KEY, DEFAULT_SIMPLE_TOOL_LIST_URL);
    }
    if (simpleToolListUrlInput) simpleToolListUrlInput.value = (savedSimpleUrl || DEFAULT_SIMPLE_TOOL_LIST_URL);
    initSimpleToolList(false);

    // 确保当前模型有效
    if (!findModel(currentModelId)) {
      currentModelId = ((getFreeModel() || aiLegacyModels[0] || getAllModels()[0]) || DEFAULT_LEGACY_MODELS[0]).id;
    }
    if (modelSelect) modelSelect.value = currentModelId;
    updateModelTag();

    // 默认隐藏对话框
    dialog.style.display = 'none';

    // 渲染模型列表（设置面板默认记忆下拉 + 弹窗双表）
    renderDefaultMemoryModel();
    renderAllModelTables();
    // 需求二：模型表列宽拖拽（动态注入手柄 + 恢复已保存列宽）
    initColumnResize();
    // AI 日志模态框（打开/关闭/清空/展开/复制 + 拖拽缩放）
    initAILogDialog();
    // 终端指令弹窗（打开/关闭/清空 + 回车执行 + 拖拽缩放）
    initTerminalDialog();

    // ---- 绑定所有事件 ----
    bindAllEvents();

    // ---- 对话框拖拽移动 ----
    if (titleBar) {
      titleBar.addEventListener('mousedown', function(e) {
        if (e.target.closest('button')) return;
        isDragging = true;
        const rect = dialog.getBoundingClientRect();
        dragOffX = e.clientX - rect.left;
        dragOffY = e.clientY - rect.top;
        dialog.dataset.moved = '1';
        dialog.style.transform = 'none';
        e.preventDefault();
      });
    }

    // ---- 对话框右下角缩放（需求1：边界锁定视口） ----
    if (resizeHandle) {
      resizeHandle.addEventListener('mousedown', function(e) {
        isResizing = true;
        const rect = dialog.getBoundingClientRect();
        resStartX = e.clientX;
        resStartY = e.clientY;
        resStartW = rect.width;
        resStartH = rect.height;
        dialog.dataset.moved = '1';
        dialog.style.transform = 'none';
        e.preventDefault();
        e.stopPropagation();
      });
    }

    // ---- 需求六：聊天功能区上边缘水平拖拽手柄（容器驱动，输入区自适应） ----
    let isDockResizing = false;
    let dockStartY = 0, dockStartH = 0;
    if (dockHandle) {
      dockHandle.addEventListener('mousedown', function(e) {
        if (!chatDock) return;
        isDockResizing = true;
        dockStartY = e.clientY;
        dockStartH = chatDock.offsetHeight;
        document.body.style.userSelect = 'none';
        e.preventDefault();
        e.stopPropagation();
      });
    }

    document.addEventListener('mousemove', function(e) {
      if (isDragging) {
        const left = e.clientX - dragOffX;
        const top = e.clientY - dragOffY;
        dialog.style.left = Math.max(0, Math.min(window.innerWidth - dialog.offsetWidth, left)) + 'px';
        dialog.style.top = Math.max(NAVBAR_H, Math.min(window.innerHeight - dialog.offsetHeight, top)) + 'px';
      } else if (isResizing) {
        // 边界锁定视口：宽度/高度不超出视口，且保持最小尺寸
        const minW = 360, minH = 280;
        const vw = window.innerWidth, vh = window.innerHeight;
        const maxW = Math.max(minW, vw - 8), maxH = Math.max(minH, vh - 8);
        const w = Math.max(minW, Math.min(maxW, resStartW + (e.clientX - resStartX)));
        const h = Math.max(minH, Math.min(maxH, resStartH + (e.clientY - resStartY)));
        dialog.style.width = w + 'px';
        dialog.style.height = h + 'px';
        // 防止缩放后对话框右/下边缘超出视口
        const rect = dialog.getBoundingClientRect();
        if (rect.right > vw) dialog.style.left = Math.max(0, vw - w) + 'px';
        if (rect.bottom > vh) dialog.style.top = Math.max(NAVBAR_H, vh - h) + 'px';
      } else if (isDockResizing && chatDock) {
        // 聊天功能区高度：最小 78，最大为对话框高度的 60%
        const minH = 78;
        const maxH = Math.max(minH, dialog.offsetHeight * 0.6);
        const h = Math.max(minH, Math.min(maxH, dockStartH + (dockStartY - e.clientY)));
        document.body.style.setProperty('--chat-dock-h', h + 'px');
      }
    });

    document.addEventListener('mouseup', function() {
      isDragging = false;
      isResizing = false;
      isDockResizing = false;
      document.body.style.userSelect = '';
    });
  }

  // ---- 将所有事件绑定集中到独立函数 ----
  function bindAllEvents() {
    // 在 bindAllEvents 中绑定 textarea 事件：
    /*
    const stepsFmtEl = document.getElementById('stepsFormatTextarea');
    if (stepsFmtEl) {
      stepsFmtEl.addEventListener('change', function() {
        aiSettings.stepsFormat = this.value;
        localStorage.setItem('ai_steps_format', this.value);
      });
    }*/
    // 关闭按钮
    if (closeBtn) {
      closeBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        window.toggleAIDialog();
      });
    }

    // 发送按钮
    if (sendBtn && input) {
      sendBtn.addEventListener('click', handleSend);
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });
    }

    // 守则管理模态框事件
    if (openRulesBtn) {
      openRulesBtn.addEventListener('click', () => {
        // 将当前值填入文本框
        rulesSystemPrompt.value = aiSettings.systemPrompt || '';
        rulesStepsFormat.value = aiSettings.stepsFormat || '';
        rulesExecuteSteps.value = aiSettings.executeStepsPrompt || '';
        rulesClassifyPrompt.value = aiSettings.classifyPrompt || DEFAULT_CLASSIFY_RULE;
        rulesModalOverlay.classList.add('visible');
      });
    }
    if (rulesCloseBtn) {
      rulesCloseBtn.addEventListener('click', () => rulesModalOverlay.classList.remove('visible'));
    }
    if (rulesCancelBtn) {
      rulesCancelBtn.addEventListener('click', () => rulesModalOverlay.classList.remove('visible'));
    }
    if (rulesSaveBtn) {
      rulesSaveBtn.addEventListener('click', async () => {
        rulesSaveBtn.disabled = true;
        rulesSaveBtn.textContent = '替换中...';
        try {
          // 保存守则时，将 {指令集字样} 替换为对应外部链接抓取的内容
          const sp = await resolveDirectiveSets(rulesSystemPrompt.value);
          const sf = await resolveDirectiveSets(rulesStepsFormat.value);
          const es = await resolveDirectiveSets(rulesExecuteSteps.value);
          const cl = await resolveDirectiveSets(rulesClassifyPrompt.value);
          aiSettings.systemPrompt = sp;
          aiSettings.stepsFormat = sf;
          aiSettings.executeStepsPrompt = es;
          aiSettings.classifyPrompt = cl;
          localStorage.setItem('ai_system_prompt', aiSettings.systemPrompt);
          localStorage.setItem('ai_steps_format', aiSettings.stepsFormat);
          localStorage.setItem('ai_execute_steps_prompt', aiSettings.executeStepsPrompt);
          localStorage.setItem('ai_classify_prompt', aiSettings.classifyPrompt);
          rulesModalOverlay.classList.remove('visible');
          addSystemMessage('? 守则已保存' + ((sp !== rulesSystemPrompt.value || sf !== rulesStepsFormat.value || es !== rulesExecuteSteps.value || cl !== rulesClassifyPrompt.value) ? '（已替换指令集）' : ''));
        } catch(e) {
          addSystemMessage('? 守则保存失败: ' + e.message);
        } finally {
          rulesSaveBtn.disabled = false;
          rulesSaveBtn.textContent = '保存';
        }
      });
    }
    if (rulesRestoreDefaultBtn) {
      rulesRestoreDefaultBtn.addEventListener('click', () => {
        // 一键恢复四栏系统默认（HTML 初始值），并立即写入当前设置与本地存储
        rulesSystemPrompt.value = rulesDefaults.system;
        rulesStepsFormat.value = rulesDefaults.stepsFormat;
        rulesExecuteSteps.value = rulesDefaults.executeSteps;
        rulesClassifyPrompt.value = rulesDefaults.classify;
        aiSettings.systemPrompt = rulesDefaults.system;
        aiSettings.stepsFormat = rulesDefaults.stepsFormat;
        aiSettings.executeStepsPrompt = rulesDefaults.executeSteps;
        aiSettings.classifyPrompt = rulesDefaults.classify;
        localStorage.setItem('ai_system_prompt', aiSettings.systemPrompt);
        localStorage.setItem('ai_steps_format', aiSettings.stepsFormat);
        localStorage.setItem('ai_execute_steps_prompt', aiSettings.executeStepsPrompt);
        localStorage.setItem('ai_classify_prompt', aiSettings.classifyPrompt);
        addSystemMessage('? 守则已恢复为系统默认');
      });
    }
    if (rulesModalOverlay) {
      rulesModalOverlay.addEventListener('click', (e) => {
        if (e.target === rulesModalOverlay) rulesModalOverlay.classList.remove('visible');
      });
    }

    // 外部链接导入列表（指令集）模态框事件
    if (linkSetBarBtn) {
      linkSetBarBtn.addEventListener('click', openLinkSetModal);
    }
    if (openLinkSetBtn) {
      openLinkSetBtn.addEventListener('click', openLinkSetModal);
    }
    if (linkSetCloseBtn) {
      linkSetCloseBtn.addEventListener('click', closeLinkSetModal);
    }
    if (linkSetCancelBtn) {
      linkSetCancelBtn.addEventListener('click', closeLinkSetModal);
    }
    if (linkSetOverlay) {
      linkSetOverlay.addEventListener('click', (e) => {
        if (e.target === linkSetOverlay) closeLinkSetModal();
      });
    }
    if (linkSetAddBtn) {
      linkSetAddBtn.addEventListener('click', () => {
        linkSetList.push({ key: '', url: '' });
        renderLinkSetList();
      });
    }
    if (linkSetSaveBtn) {
      linkSetSaveBtn.addEventListener('click', () => {
        // 过滤掉无字样或空链接的条目，重复字样只保留最后一条
        const filtered = [];
        const seen = {};
        linkSetList.forEach(item => {
          const k = (item && item.key ? String(item.key).trim() : '');
          const u = (item && item.url ? String(item.url).trim() : '');
          if (!k || !u) return;
          if (seen[k]) {
            const idx = filtered.findIndex(f => f.key === k);
            if (idx >= 0) filtered[idx] = { key: k, url: u };
            return;
          }
          seen[k] = true;
          filtered.push({ key: k, url: u });
        });
        linkSetList = filtered;
        saveLinkSetList();
        closeLinkSetModal();
        addSystemMessage('? 外部链接导入列表已保存（' + linkSetList.length + ' 条）');
      });
    }

    // 在 bindAllEvents 中添加（例如放在表格渲染之后）
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('.ai-model-debug');
      if (btn) {
        const modelId = btn.dataset.modelId;
        if (modelId) {
          runModelDebug(modelId);
        }
      }
    });

    // 技能按钮
    document.querySelectorAll('.ai-skill-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const skill = this.dataset.skill;
        switch (skill) {
          case 'selected': {
            let info = '当前选中的项目：\n';
            if (selectedItemId) {
              const it = items.find(i => i.id === selectedItemId);
              if (it) {
                info += `ID: ${it.id}, 类型: ${it.type}`;
                if (it.type === 'point') info += `, 坐标: (${safeToFixed(it.x,2)}, ${safeToFixed(it.y,2)})`;
                else if (it.type === 'function') info += `, 表达式: ${it.expr}`;
                else if (it.type === 'param') info += `, 值: ${it.value}`;
                else if (it.type === 'segment' || it.type === 'line' || it.type === 'ray') {
                  info += `, 一次函数: y = ${it.k?.toFixed(2)}x + ${it.b?.toFixed(2)}`;
                }
              } else {
                info += '未找到';
              }
            } else {
              info += '无选中项';
            }
            if (input) input.value = info;
            break;
          }
          case 'all': {
            const data = items.map(it => {
              const base = { id: it.id, type: it.type, hidden: it.hidden };
              if (it.type === 'point') return { ...base, x: it.x, y: it.y, label: it.label };
              if (it.type === 'function') return { ...base, expr: it.expr };
              if (it.type === 'param') return { ...base, name: it.name, value: it.value };
              if (it.type === 'segment' || it.type === 'line' || it.type === 'ray') {
                return {
                  ...base,
                  pointA: it.pointA ? { label: it.pointA.label, x: it.pointA.x, y: it.pointA.y } : null,
                  pointB: it.pointB ? { label: it.pointB.label, x: it.pointB.x, y: it.pointB.y } : null,
                  k: it.k,
                  b: it.b
                };
              }
              return base;
            });
            if (input) input.value = '全量项目数据（JSON格式）：\n' + JSON.stringify(data, null, 2);
            break;
          }
          case 'kb': {
            if (input) input.value = '检索知识库：请描述你想了解的知识点，例如 "如何绘制隐函数"';
            break;
          }
          case 'clear': {
            // 清空对话：完全新建对话（清空记忆ID/上下文/聊天记录），下次发送按默认记忆模型 memoryMode 走新建流程
            resetConversation();
            addSystemMessage('? 已清空对话，下次发送将按当前记忆模式重新创建记忆 ID 并初始化上下文');
            break;
          }
          default: break;
        }
        if (input) input.focus();
      });
    });

    // 模型选择变更
    if (modelSelect) {
      modelSelect.addEventListener('change', function() {
        currentModelId = this.value;
        updateModelTag();
        const newModel = findModel(currentModelId);
        // 切换对话模型只切换模型，不再开启新对话、不清空聊天记录与记忆（仅由「清空」按钮开启新对话）
        if (newModel) {
          addSystemMessage('? 已切换为「' + newModel.name + '」');
        }
      });
    }

    // 回退按钮
    if (rollbackBtn) {
      rollbackBtn.addEventListener('click', showHistory);
    }

    // 设置面板同步
    /*
    if (systemPromptInput) {
      systemPromptInput.addEventListener('change', function() {
        aiSettings.systemPrompt = this.value;
        localStorage.setItem('ai_system_prompt', this.value);
      });
    }*/
    if (autoContextCheck) {
      autoContextCheck.addEventListener('change', function() {
        aiSettings.autoContext = this.checked;
        localStorage.setItem('ai_auto_context', this.checked ? '1' : '0');
      });
    }
    if (snapshotCountInput) {
      snapshotCountInput.addEventListener('change', function() {
        const val = parseInt(this.value) || 20;
        snapshotMax = Math.max(5, Math.min(50, val));
        aiSettings.snapshotCount = snapshotMax;
        localStorage.setItem('ai_snapshot_count', snapshotMax);
      });
    }
    if (streamingCheck) {
      streamingCheck.addEventListener('change', function() {
        aiSettings.streaming = this.checked;
        localStorage.setItem('ai_streaming', this.checked ? '1' : '0');
      });
    }
    if (requestFormatSelect) {
      requestFormatSelect.addEventListener('change', function() {
        aiSettings.requestFormat = this.value;
        localStorage.setItem('ai_request_format', this.value);
      });
    }
    if (apiKeyInput) {
      apiKeyInput.addEventListener('change', function() {
        aiSettings.apiKey = this.value.trim();
        localStorage.setItem('ai_api_key', this.value.trim());
      });
    }
    // DeepSeek 禁用思考开关
    if (deepseekThinkingCheck) {
      deepseekThinkingCheck.addEventListener('change', function() {
        aiSettings.deepseekDisableThinking = this.checked;
        localStorage.setItem('ai_ds_disable_thinking', this.checked ? '1' : '0');
      });
    }
    // 需求10：请求超时设置
    if (timeoutInput) {
      timeoutInput.addEventListener('change', function() {
        const val = parseInt(this.value) || 300;
        const t = Math.max(30, Math.min(600, val));
        aiSettings.timeoutMs = t * 1000;
        this.value = t;
        localStorage.setItem('ai_timeout', t);
      });
    }
    // 步骤失败重试设置
    if (stepRetryCheck) {
      stepRetryCheck.addEventListener('change', function() {
        aiSettings.stepRetryEnabled = this.checked;
        localStorage.setItem('ai_step_retry_enabled', this.checked ? '1' : '0');
      });
    }
    if (stepRetryCountInput) {
      stepRetryCountInput.addEventListener('change', function() {
        const val = parseInt(this.value) || 2;
        const c = Math.max(0, Math.min(10, val));
        aiSettings.stepRetryCount = c;
        this.value = c;
        localStorage.setItem('ai_step_retry_count', c);
      });
    }

    // 需求3：工具列表远程地址 + 重新获取
    if (toolListUrlInput) {
      toolListUrlInput.addEventListener('change', function() {
        const url = (this.value || '').trim();
        localStorage.setItem(TOOL_LIST_URL_KEY, url);
        initToolList(true);
      });
    }
    // 简易工具列表远程地址（记忆模型规划 tool_idx 用）
    if (simpleToolListUrlInput) {
      simpleToolListUrlInput.addEventListener('change', function() {
        const url = (this.value || '').trim();
        localStorage.setItem(SIMPLE_TOOL_LIST_URL_KEY, url);
        initSimpleToolList(true);
      });
    }
    if (toolReloadBtn) {
      toolReloadBtn.addEventListener('click', function() {
        const url = (toolListUrlInput && toolListUrlInput.value || '').trim();
        localStorage.setItem(TOOL_LIST_URL_KEY, url);
        toolReloadBtn.disabled = true;
        toolReloadBtn.textContent = '获取中...';
        initToolList(true).finally(() => {
          toolReloadBtn.disabled = false;
          toolReloadBtn.textContent = '重新获取';
        });
      });
    }

    // 数据同步按钮（需求三）
    if (syncBtn) {
      syncBtn.addEventListener('click', syncProjectData);
      updateSyncBtn();
    }

    // 需求2：查看同步数据（只读）按钮
    if (viewSyncBtn) {
      viewSyncBtn.addEventListener('click', openViewSyncData);
    }
    const viewOverlayEl = document.getElementById('aiViewOverlay');
    const viewCloseBtn = document.getElementById('aiViewCloseBtn');
    const viewCopyBtn = document.getElementById('aiViewCopyBtn');
    const viewRefreshBtn = document.getElementById('aiViewRefreshBtn');
    if (viewCloseBtn) {
      viewCloseBtn.addEventListener('click', closeViewSyncData);
    }
    if (viewOverlayEl) {
      viewOverlayEl.addEventListener('click', function(e) {
        if (e.target === viewOverlayEl) closeViewSyncData();
      });
    }
    if (viewCopyBtn) {
      viewCopyBtn.addEventListener('click', function() {
        copyText(freeContextPrompt || '暂无同步数据');
      });
    }
    if (viewRefreshBtn) {
      viewRefreshBtn.addEventListener('click', function() {
        syncProjectData();
      });
    }

    // 对话气泡操作栏事件委托（复制 / 修改，需求四）
    if (chatArea) {
      chatArea.addEventListener('click', function(e) {
        const btn = e.target.closest ? e.target.closest('.ai-msg-action-btn') : null;
        if (!btn) return;
        const wrap = btn.closest('.ai-msg-wrap');
        if (!wrap) return;
        const bubble = wrap.querySelector('.ai-msg-user, .ai-msg-assistant');
        const text = bubble ? bubble.textContent : '';
        if (btn.dataset.act === 'copy') {
          copyText(text);
        } else if (btn.dataset.act === 'edit') {
          if (input) input.value = text;
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          if (input) input.focus();
        }
      });
    }

    // ---- 模型管理弹窗 ----
    // 打开：AI设置面板「模型列表」标题 / 各表「+ 新增」/ 底部「添加自定义模型」
    if (modelManagerTitle) {
      modelManagerTitle.addEventListener('click', openModelManager);
    }
    if (modelCloseBtn) {
      modelCloseBtn.addEventListener('click', closeModelManager);
    }
    if (modelManagerOverlay) {
      modelManagerOverlay.addEventListener('click', function(e) {
        if (e.target === modelManagerOverlay) closeModelManager();
      });
    }
    if (addMainstreamBtn) {
      addMainstreamBtn.addEventListener('click', () => addCustomModel('mainstream'));
    }
    if (addLegacyBtn) {
      addLegacyBtn.addEventListener('click', () => addCustomModel('legacy'));
    }
    if (addCustomBtn) {
      addCustomBtn.addEventListener('click', () => addCustomModel('mainstream'));
    }
    if (restoreDefaultBtn) {
      restoreDefaultBtn.addEventListener('click', restoreDefaultModels);
    }
    // 默认记忆模型下拉
    if (defaultMemorySelect) {
      defaultMemorySelect.addEventListener('change', function() {
        defaultMemoryModelId = this.value;
        localStorage.setItem(DEFAULT_MEMORY_MODEL_KEY, defaultMemoryModelId);
        addSystemMessage('? 默认记忆模型已设置为：' + (findModel(defaultMemoryModelId)?.name || '无'));
      });
    }
    const debugBtn = document.getElementById('aiDebugBtn');
    if (debugBtn) {
      debugBtn.addEventListener('click', () => runModelDebug(currentModelId));
    }
    const testBtn = document.getElementById('aiRunTestBtn');
    if (testBtn) {
      testBtn.addEventListener('click', () => {
        // 可运行预设测试用例，这里简化，使用当前模型并发送预定义指令
        const model = findModel(currentModelId);
        if (model) runModelDebug(currentModelId);
      });
    }
    const debugClose = document.getElementById('debugModalClose');
    if (debugClose) {
      debugClose.addEventListener('click', () => {
        document.getElementById('debugModalOverlay').classList.remove('visible');
      });
    }
    const debugOverlay = document.getElementById('debugModalOverlay');
    if (debugOverlay) {
      debugOverlay.addEventListener('click', (e) => {
        if (e.target === debugOverlay) debugOverlay.classList.remove('visible');
      });
    }
  }

  // ---------- 外部链接导入列表（指令集）模态框 ----------
  // 指令集链接有效性检测：复用 fetchLinkContent（与 resolveDirectiveSets 抓取逻辑一致）
  async function checkLinkSetStatus(item, statusEl, btnEl) {
    if (!item || !item.url || !/^https?:\/\//i.test(item.url.trim())) {
      if (statusEl) {
        statusEl.textContent = '未填链接';
        statusEl.className = 'link-set-status pending';
      }
      if (btnEl) btnEl.disabled = false;
      return;
    }
    if (statusEl) {
      statusEl.textContent = '检测中...';
      statusEl.className = 'link-set-status pending';
    }
    if (btnEl) btnEl.disabled = true;
    const content = await fetchLinkContent(item.url.trim());
    item.linkStatus = content ? 'ok' : 'fail';
    if (statusEl) {
      if (content) {
        statusEl.textContent = '正常';
        statusEl.className = 'link-set-status ok';
        statusEl.title = '可获取文本（' + content.length + ' 字符）';
      } else {
        statusEl.textContent = '异常';
        statusEl.className = 'link-set-status fail';
        statusEl.title = '获取失败：可能是跨域限制或链接失效';
      }
    }
    if (btnEl) btnEl.disabled = false;
  }

  function renderLinkSetList() {
    if (!linkSetListEl) return;
    linkSetListEl.innerHTML = '';
    if (!linkSetList.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;color:#94a3b8;font-size:12px;padding:18px 0;';
      empty.textContent = '暂无指令集条目，点击下方「+ 新增条目」添加。';
      linkSetListEl.appendChild(empty);
      return;
    }
    linkSetList.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'link-set-row';
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'link-set-key';
      keyInput.placeholder = '指令集字样（如 工具说明）';
      keyInput.value = item.key || '';
      keyInput.addEventListener('input', () => { item.key = keyInput.value; });
      const urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.className = 'link-set-url';
      urlInput.placeholder = '外部链接 https://...';
      urlInput.value = item.url || '';
      let debounceTimer = null;
      const statusEl = document.createElement('span');
      statusEl.className = 'link-set-status ' + (item.linkStatus ? item.linkStatus : 'pending');
      statusEl.textContent = item.linkStatus ? (item.linkStatus === 'ok' ? '正常' : '异常') : '未检测';
      if (item.linkStatus === 'ok') statusEl.title = '上次检测正常';
      if (item.linkStatus === 'fail') statusEl.title = '上次检测异常';
      urlInput.addEventListener('input', () => {
        item.url = urlInput.value;
        item.linkStatus = undefined;
        statusEl.textContent = '未检测';
        statusEl.className = 'link-set-status pending';
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          checkLinkSetStatus(item, statusEl, checkBtn);
        }, 600);
      });
      const checkBtn = document.createElement('button');
      checkBtn.type = 'button';
      checkBtn.className = 'link-set-check';
      checkBtn.textContent = '检测';
      checkBtn.title = '手动检测该链接是否可获取文本';
      checkBtn.addEventListener('click', () => {
        if (checkBtn.disabled) return;
        checkLinkSetStatus(item, statusEl, checkBtn);
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'link-set-del';
      delBtn.textContent = '删除';
      delBtn.title = '删除该条目';
      delBtn.addEventListener('click', () => {
        linkSetList.splice(idx, 1);
        renderLinkSetList();
      });
      row.appendChild(keyInput);
      row.appendChild(urlInput);
      row.appendChild(statusEl);
      row.appendChild(checkBtn);
      row.appendChild(delBtn);
      linkSetListEl.appendChild(row);
    });
  }

  function openLinkSetModal() {
    renderLinkSetList();
    if (linkSetOverlay) linkSetOverlay.classList.add('visible');
  }

  function closeLinkSetModal() {
    if (linkSetOverlay) linkSetOverlay.classList.remove('visible');
  }

  // ---------- 卡片展开/收起（思考过程卡 + 步骤执行卡） ----------
  function bindCardToggle(card) {
    if (!card || card.dataset.toggleBound) return;
    card.dataset.toggleBound = '1';
    const head = card.querySelector('.ai-think-head') || card.querySelector('.ai-step-head');
    const body = card.querySelector('.ai-think-body') || card.querySelector('.ai-step-body');
    const btn = card.querySelector('.ai-card-toggle');
    const setState = (expanded) => {
      card.classList.toggle('expanded', expanded);
      if (body) body.style.display = expanded ? 'block' : 'none';
      if (btn) btn.textContent = expanded ? '收起' : '展开';
    };
    const onClick = () => setState(!card.classList.contains('expanded'));
    if (head) head.addEventListener('click', onClick);
    if (btn) btn.addEventListener('click', function(e) {
      e.stopPropagation();
      setState(!card.classList.contains('expanded'));
    });
    setState(false);
  }

  function addThinkCard(stepsBox) {
    const card = document.createElement('div');
    card.className = 'ai-think-card pending';
    card.innerHTML = `
      <div class="ai-think-head">
        <span class="ai-think-icon">&#9670;</span>
        <span class="ai-think-title">思考过程</span>
        <span class="ai-think-status">思考中...</span>
        <button class="ai-card-toggle" type="button">展开</button>
      </div>
      <div class="ai-think-body" style="display:none;"></div>
      <span class="ai-card-time"></span>`;
    card.querySelector('.ai-card-time').textContent = formatCardTime();
    (stepsBox || chatArea).appendChild(card);
    chatArea.scrollTop = chatArea.scrollHeight;
    bindCardToggle(card);
    return card;
  }

  // 思考中：实时把当前轮的思考内容写入对应轮次区块，并自动展开思考卡片
  function updateThinkCard(card, text, round) {
    if (!card) return;
    const body = card.querySelector('.ai-think-body');
    if (!body) return;
    const rn = Number(round) || 1;
    let r = body.querySelector('.ai-think-round[data-round="' + rn + '"]');
    if (!r) {
      r = document.createElement('div');
      r.className = 'ai-think-round';
      r.dataset.round = String(rn);
      if (rn > 1) {
        const hr = document.createElement('div');
        hr.className = 'ai-think-divider';
        r.appendChild(hr);
      }
      body.appendChild(r);
    }
    r.textContent = text || '';
    card.classList.add('expanded');
    body.style.display = 'block';
    const btn = card.querySelector('.ai-card-toggle');
    if (btn) btn.textContent = '收起';
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  // 一轮思考结束（或请求失败）：收起思考卡片
  function collapseThinkCard(card) {
    if (!card) return;
    card.classList.remove('expanded');
    const body = card.querySelector('.ai-think-body');
    if (body) body.style.display = 'none';
    const btn = card.querySelector('.ai-card-toggle');
    if (btn) btn.textContent = '展开';
  }

  function markThinkDone(card, hasContent) {
    if (!card) return;
    const st = card.querySelector('.ai-think-status');
    if (st) st.textContent = hasContent ? '已思考' : '无思考文本';
    collapseThinkCard(card);
  }

  function failThinkCard(card) {
    if (!card) return;
    const st = card.querySelector('.ai-think-status');
    if (st) st.textContent = '思考失败';
    collapseThinkCard(card);
  }

  // 开始执行某一步（或重试）时重置思考卡：清空多轮内容、恢复思考中状态、收起
  function resetThinkCard(card) {
    if (!card) return;
    const body = card.querySelector('.ai-think-body');
    if (body) body.innerHTML = '';
    const st = card.querySelector('.ai-think-status');
    if (st) st.textContent = '思考中...';
    card.classList.remove('expanded');
    if (body) body.style.display = 'none';
    const btn = card.querySelector('.ai-card-toggle');
    if (btn) btn.textContent = '展开';
  }

  // 设置工具/步骤卡片收起时显示的标签文本（如执行中的 busy、执行后的完整命令文本）
  function setStepCardLabel(card, text) {
    if (!card) return;
    const t = card.querySelector('.ai-step-title');
    if (t) t.textContent = text || '';
  }

  // 每步的「正常输出」容器（放在步骤卡容器内，与思考卡、工具卡并列，位于对话气泡中）
  function createStepOutput(stepsBox) {
    const div = document.createElement('div');
    div.className = 'ai-step-output';
    (stepsBox || chatArea).appendChild(div);
    return div;
  }

  // 获取/创建某一轮的输出区块（多轮对话时每轮内容都保留渲染，而非替换第一轮）
  function ensureOutputRound(outEl, round) {
    if (!outEl) return null;
    const rn = Number(round) || 1;
    let r = outEl.querySelector('.ai-round-output[data-round="' + rn + '"]');
    if (!r) {
      r = document.createElement('div');
      r.className = 'ai-round-output';
      r.dataset.round = String(rn);
      outEl.appendChild(r);
    }
    return r;
  }

  // 更新当前轮正常输出内容（markdown 渲染）
  function setOutputRoundContent(outEl, round, text) {
    const r = ensureOutputRound(outEl, round);
    if (!r) return;
    r.innerHTML = renderMarkdown(text || '');
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  // 开始执行某一步（或重试）时重置正常输出容器：清空多轮内容
  function resetStepOutput(outEl) {
    if (!outEl) return;
    outEl.innerHTML = '';
  }

  function showMemoryIdModal() {
    return new Promise((resolve) => {
      const overlay = document.getElementById('memoryModalOverlay');
      const input = document.getElementById('memoryIdInput');
      const confirmBtn = document.getElementById('memoryModalConfirm');
      const cancelBtn = document.getElementById('memoryModalCancel');
      const randomBtn = document.getElementById('memoryIdRandomBtn');
      input.value = '';
      overlay.classList.add('visible');
      const cleanup = () => {
        overlay.classList.remove('visible');
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        if (randomBtn) randomBtn.removeEventListener('click', onRandom);
      };
      const onRandom = () => {
        // 生成6位随机数字
        const randomId = Math.floor(100000 + Math.random() * 900000).toString();
        input.value = randomId;
      };
      const onConfirm = () => {
        const val = input.value.trim();
        if (/^\d{6}$/.test(val)) {
          cleanup();
          resolve(val);
        } else {
          alert('请输入6位数字');
        }
      };
      const onCancel = () => {
        cleanup();
        resolve(null);
      };
      const onKey = (e) => { if (e.key === 'Enter') onConfirm(); };
      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
      if (randomBtn) randomBtn.addEventListener('click', onRandom);
      input.focus();
    });
  }

  // 暴露全局函数，供其他部分调用（如顶部 AI 按钮）
  window.toggleAIDialog = toggleAIDialog;
  window.showAIHistory = showHistory;
  window.initAI = initAI;
  // 暴露纯函数/UI 工具，供测试与调试使用（不暴露内部状态）
  window.aiParseExecutionPlan = parseExecutionPlan;
  window.aiShowStepsBar = showStepsBar;
  window.aiUpdateStepsBarState = updateStepsBarState;
  window.aiHideStepsBar = hideStepsBar;
  window.aiFormatCardTime = formatCardTime;
  window.aiGetMemoryHostModel = getMemoryHostModel;
  window.aiExtractLegacyText = extractLegacyText;
  window.aiGetValueByPath = getValueByPath;

  // 自动保存快照（在关键操作后）
  const origFullRender = window.fullRender;
  window.fullRender = function() {
    origFullRender();
    // 如果是在非恢复状态下，保存快照
    if (!isRestoring && isVisible) {
      // 延迟保存，避免频繁
      clearTimeout(window._snapshotTimer);
      window._snapshotTimer = setTimeout(() => {
        saveSnapshot();
      }, 500);
    }
  };

  // 也拦截 add/delete 等操作（在 renderItemCards 后触发保存）
  const origRenderItemCards = window.renderItemCards;
  window.renderItemCards = function() {
    origRenderItemCards();
    if (!isRestoring && isVisible) {
      clearTimeout(window._snapshotTimer);
      window._snapshotTimer = setTimeout(() => {
        saveSnapshot();
      }, 500);
    }
    // 需求三：项目列表增删改 → 数据同步按钮变红提示
    if (!isRestoring) {
      freeDataDirty = true;
      updateSyncBtn();
    }
    window.getToolTotalArray = function() {
      // 返回工具列表的索引访问版本（{ index, tool }）
      const list = getFullToolList();
      return list.map((t, i) => ({ index: i, tool: t }));
    };
    window.resolveToolsByIndexes = function(indexes) {
      const list = getFullToolList();
      return indexes.map(i => list[i]).filter(Boolean);
    };
  };

  // 初始化 AI 模块（脚本位于 body 末尾，DOM 已就绪）
  initAI();
})();
