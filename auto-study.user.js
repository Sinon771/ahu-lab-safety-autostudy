// ==UserScript==
// @name         实验室安全学习系统 · 自动刷课（纯前端版）
// @namespace    http://172.17.109.74/
// @version      2.3.0
// @description  自动播放视频 + 自动回答配套题目 + 自动跳下一节（无需 token，手动登录即可，倍速可选，支持后台运行）
// @match        http://172.17.109.74/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @noframes
// ==/UserScript==

/*
 * 使用说明（v2.2，纯前端驱动，不需要 token）：
 * 1. 在 Edge 的 Tampermonkey 里新建脚本，粘贴本文件全部内容，保存。
 * 2. 手动登录系统，进入任意一门视频课的详情页：
 *    - 自动开始：静音播放，题目弹出时自动选正确答案并提交，播完自动跳下一节。
 * 3. 右下角面板：
 *    - 【倍速】下拉框：0.25x ~ 2x，与网页原生播放器可选倍速一致（默认 2x）。
 *      也可直接用网页视频右键菜单里的“播放速度”改，脚本会自动跟随、互相同步。
 *    - 【暂停/继续】  临时停止 / 恢复自动播放
 *    - 【秒完成本节】 立即作答本节全部题目并把视频快进到结尾（最快）
 *    - 【跳到下一节】 手动切到下一节
 * 4. 提示：页面有“快进超过 3 秒会被拉回”的防作弊，所以倍速只到 2x（网页原生的上限），
 *    再快会漏掉题目、甚至触发快进检测被回拉。
 * 5. 后台运行：脚本已强制 document.hidden=false 骗过网页的“页面隐藏即暂停”逻辑，
 *    并把答题挂在视频 timeupdate 事件上，所以最小化窗口 / 切到别的标签页也能继续刷。
 *    注意：若长时间后台运行，建议关闭 Edge 的“睡眠标签页 / 内存节省”或把该标签页“固定”，
 *    以免浏览器把页面冻结（冻结后任何脚本都无法运行）。
 */
(function () {
  'use strict';
  console.log('[自动刷课] 脚本已加载', location.href);

  // ======================= 配置 =======================
  const CONFIG = {
    defaultRate: 2,   // 默认倍速（与网页原生一致：0.25/0.5/0.75/1/1.25/1.5/1.75/2）
    autoNext: true,   // 视频播完后自动跳下一节
    autoStart: true,  // 进入课程详情页后自动开始
  };
  // 网页原生播放器可选倍速（Edge/Chromium 原生 <video> 的“播放速度”菜单）
  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  // ======================= 工具 =======================
  let paused = false;
  let currentRate = CONFIG.defaultRate; // 当前倍速（会与网页原生选择双向同步）
  const logLines = [];
  function log(msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logLines.push(`[${time}] ${msg}`);
    if (logLines.length > 200) logLines.shift();
    const box = document.getElementById('as-log');
    if (box) box.textContent = logLines.join('\n');
    console.log('[自动刷课]', msg);
  }

  // ======================= Vue 组件访问 =======================
  function getRoot() {
    const el = document.getElementById('app') || document.querySelector('#app');
    return el && el.__vue__;
  }
  function findComp(vm, pred, depth) {
    if (!vm || depth > 30) return null;
    if (pred(vm)) return vm;
    const kids = vm.$children || [];
    for (let i = 0; i < kids.length; i++) {
      const r = findComp(kids[i], pred, depth + 1);
      if (r) return r;
    }
    return null;
  }
  // 课程详情组件：有 graphId、urlTemp、model.questionRelaList、submit 方法
  let _compCache = null;
  function getCourseComp() {
    if (_compCache) return _compCache;
    const root = getRoot();
    if (!root) return null;
    _compCache = findComp(root, function (vm) {
      const d = vm.$data;
      return !!(d && d.graphId !== undefined && d.urlTemp !== undefined &&
        d.model && Array.isArray(d.model.questionRelaList) && typeof vm.submit === 'function');
    }, 0);
    return _compCache;
  }

  // 正确答案 -> 提交格式。单选/判断返回 "A"；多选返回 ["A","B",...]
  function formatAnswer(q) {
    const raw = q.correctAnswer == null ? '' : String(q.correctAnswer).trim();
    if (!raw) return '';
    const kind = String(q.kind || ''); // 数字/字符串都按字符串处理
    const upper = raw.toUpperCase();
    if (kind === '3') {
      // 多选：兼容 "A,B,C" / "ABC" / "A|B|C" / "A、B、C" 等写法
      const parts = raw.split(/[,，|、;\s]+/).filter(Boolean).map((s) => s.toUpperCase());
      if (parts.length > 1) return parts;
      const letters = upper.replace(/[^A-D]/g, '').split('');
      return letters.length ? letters : parts;
    }
    // 单选/判断：优先取 A-D 字母；否则按“正确/错误”映射（A=正确，B=错误）
    const letter = upper.match(/[A-D]/);
    if (letter) return letter[0];
    if (/正确|对|是|TRUE|T|√/.test(upper)) return 'A';
    if (/错误|错|否|FALSE|F|×/.test(upper)) return 'B';
    return upper.charAt(0);
  }

  // ======================= 倍速 =======================
  function applyRate() {
    const v = document.querySelector('video');
    if (!v) return;
    if (Math.abs(v.playbackRate - currentRate) > 0.01) v.playbackRate = currentRate;
  }
  function syncSelect() {
    const sel = document.getElementById('as-rate');
    if (!sel) return;
    let nearest = RATES[0], best = Infinity;
    for (const r of RATES) {
      if (Math.abs(r - currentRate) < best) { best = Math.abs(r - currentRate); nearest = r; }
    }
    sel.value = String(nearest);
  }

  // ======================= 自动播放 =======================
  function ensurePlaying() {
    const v = document.querySelector('video');
    if (!v || paused) return;
    // 每个视频元素只在首次出现时应用一次默认倍速，之后不再强制，
    // 避免和网页原生倍速菜单互相打架。
    if (!v.__asRateApplied) {
      v.__asRateApplied = true;
      if (Math.abs(v.playbackRate - CONFIG.defaultRate) > 0.01) v.playbackRate = CONFIG.defaultRate;
      currentRate = v.playbackRate;
      syncSelect();
    }
    if (v.muted !== true) v.muted = true;
    if (v.paused && !v.ended) {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  // ======================= 自动答题 =======================
  const answered = new Set();
  let _lastCompWarn = 0;
  let _dumpedShape = false;
  function answerLoop() {
    if (paused) return; // 暂停时也不自动答题
    const comp = getCourseComp();
    if (!comp) {
      if (Date.now() - _lastCompWarn > 10000) {
        _lastCompWarn = Date.now();
        log('⚠ 未找到课程组件（请确认已进入视频课详情页）');
      }
      return;
    }
    // 一次性打印题目数据结构，便于排查字段名/类型变化
    if (!_dumpedShape) {
      const list = comp.model.questionRelaList;
      if (list && list.length) {
        _dumpedShape = true;
        const q0 = list[0];
        log(`题目字段：${Object.keys(q0).join(', ')}`);
        log(`示例题：kind=${q0.kind}（${typeof q0.kind}） correctAnswer=${q0.correctAnswer} id=${q0.id} questionId=${q0.questionId}`);
      }
    }
    if (comp.showModal && comp.questionId && !answered.has(comp.questionId)) {
      const list = comp.model.questionRelaList || [];
      const cid = String(comp.questionId);
      const q = list.find((x) => String(x.id) === cid || String(x.questionId) === cid);
      if (!q) {
        log(`⚠ 未找到题目数据（id=${cid}），列表共 ${list.length} 条`);
        return;
      }
      const ans = formatAnswer(q);
      if (!ans || (Array.isArray(ans) && !ans.length)) {
        log(`⚠ 题目缺少正确答案，无法自动作答：${String(q.stem || '').slice(0, 20)}…`);
        return;
      }
      if (String(q.kind) === '3') comp.selectedValues = ans;
      else comp.option = ans;
      answered.add(comp.questionId);
      setTimeout(() => { try { comp.submit(); } catch (e) {} }, 60);
      log(`已回答：${String(q.stem || '').slice(0, 20)}…（答案 ${Array.isArray(ans) ? ans.join(',') : ans}）`);
    }
  }

  // ======================= 秒完成本节 =======================
  function fastFinish() {
    const comp = getCourseComp();
    const v = document.querySelector('video');
    if (!comp || !v) return log('未找到课程组件或视频');
    if (!isFinite(v.duration) || v.duration <= 0) return log('视频元数据未加载，无法秒完成');
    const qs = comp.model.questionRelaList || [];
    log(`秒完成：共 ${qs.length} 道题`);
    // 1) 直接作答全部题目（不依赖题目弹出）
    qs.forEach((q, i) => {
      answered.add(q.questionId || q.id); // 避免 answerLoop 重复作答
      setTimeout(() => {
        comp.questionId = q.questionId || q.id;
        comp.model.kind = q.kind;
        comp.model.stem = q.stem;
        if (q.kind === '3') comp.selectedValues = formatAnswer(q);
        else comp.option = formatAnswer(q);
        try { comp.submit(); } catch (e) {}
      }, i * 250);
    });
    // 2) 绕过页面“快进>3 秒会拉回”的检测：先把页面记录的 currTime 抬到接近结尾，再快进
    setTimeout(() => {
      const target = Math.max(0, v.duration - 1);
      comp.currTime = target;       // 让页面认为只是小幅度前进
      v.muted = true;
      v.currentTime = target;
      v.play();                     // 播放最后 1 秒 -> 触发 ended -> finish 上报 -> 自动跳下一节
    }, qs.length * 250 + 600);
  }

  // ======================= 自动跳下一节 =======================
  function flattenLeaves(nodes, out) {
    out = out || [];
    (nodes || []).forEach((n) => {
      if (n.children && n.children.length) flattenLeaves(n.children, out);
      else out.push(n);
    });
    return out;
  }
  function goNext() {
    const comp = getCourseComp();
    if (!comp || !comp.treeData || !comp.treeData.length) return log('未找到课程树');
    const leaves = flattenLeaves(comp.treeData);
    const curId = String(comp.model.id || new URLSearchParams(location.search).get('id'));
    let idx = -1;
    for (let i = 0; i < leaves.length; i++) {
      if (String(leaves[i].key) === curId) { idx = i; break; }
    }
    if (idx >= 0 && idx + 1 < leaves.length) {
      const next = leaves[idx + 1];
      const u = new URL(location.href);
      u.searchParams.set('id', next.key);
      log(`跳转下一节：${next.title || next.key}`);
      setTimeout(() => { location.href = u.href; }, 800);
    } else {
      log('已是本分类最后一节');
    }
  }

  // ======================= 后台运行 =======================
  // 骗过网页的“页面隐藏即暂停”逻辑，让最小化/切后台时视频继续播
  function makeBackgroundSafe() {
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    } catch (e) {}
  }

  // ======================= 主循环 =======================
  function watchVideo() {
    const v = document.querySelector('video');
    if (!v) return;
    if (!v.__asEnded) {
      v.__asEnded = true;
      v.addEventListener('ended', () => {
        log('本节视频播放结束');
        if (CONFIG.autoNext && !paused) goNext();
      });
    }
    // 用户通过网页原生倍速菜单改速度时，同步到脚本
    if (!v.__asRateSync) {
      v.__asRateSync = true;
      v.addEventListener('ratechange', () => {
        currentRate = v.playbackRate;
        syncSelect();
      });
    }
    // 视频 timeupdate 在后台不被限流，挂在这里确保题目一弹出就立即作答
    if (!v.__asAnswer) {
      v.__asAnswer = true;
      v.addEventListener('timeupdate', () => { answerLoop(); });
    }
  }
  function mainLoop() {
    ensurePlaying();
    watchVideo();
    answerLoop();
  }

  // ======================= UI 面板 =======================
  function buildPanel() {
    if (document.getElementById('as-panel')) return;
    const style = document.createElement('style');
    style.textContent = `
      #as-panel{position:fixed;right:16px;bottom:16px;z-index:999999;width:260px;
        background:#1f2430;color:#e6e6e6;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.4);
        font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif;overflow:hidden}
      #as-panel .as-head{display:flex;align-items:center;justify-content:space-between;
        padding:10px 12px;background:#2a3040;cursor:move;user-select:none}
      #as-panel .as-head b{font-size:14px}
      #as-panel .as-body{padding:10px 12px}
      #as-panel .as-row{display:flex;align-items:center;gap:8px;margin:6px 0}
      #as-panel .as-row label{flex:0 0 auto;color:#9aa4b2}
      #as-panel select{flex:1;padding:6px;border:0;border-radius:6px;background:#14181f;color:#e6e6e6;font-size:13px}
      #as-panel button{display:block;width:100%;margin:6px 0;padding:8px;border:0;border-radius:6px;
        background:#3b82f6;color:#fff;cursor:pointer;font-size:13px}
      #as-panel button:hover{filter:brightness(1.1)}
      #as-panel button.as-warn{background:#f59e0b}
      #as-log{white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;
        margin-top:8px;padding:8px;background:#14181f;border-radius:6px;font-size:11px;color:#9fd3a8}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'as-panel';
    panel.innerHTML = `
      <div class="as-head"><b>自动刷课</b><span>⚙</span></div>
      <div class="as-body">
        <div class="as-row"><label>倍速</label>
          <select id="as-rate">
            <option value="0.25">0.25x</option>
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1">1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="1.75">1.75x</option>
            <option value="2" selected>2x</option>
          </select>
        </div>
        <button data-act="toggle">⏯ 暂停 / 继续</button>
        <button data-act="fast" class="as-warn">⚡ 秒完成本节</button>
        <button data-act="next">⏭ 跳到下一节</button>
        <div id="as-log">就绪。</div>
      </div>`;
    document.body.appendChild(panel);

    // 倍速下拉
    const rateSel = document.getElementById('as-rate');
    rateSel.value = String(CONFIG.defaultRate);
    rateSel.addEventListener('change', () => {
      currentRate = parseFloat(rateSel.value);
      applyRate();
      log(`倍速已设为 ${currentRate}x`);
    });

    // 拖拽
    const head = panel.querySelector('.as-head');
    let sx, sy, ox, oy, dragging = false;
    head.addEventListener('mousedown', (e) => {
      dragging = true; sx = e.clientX; sy = e.clientY;
      ox = panel.offsetLeft; oy = panel.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (ox + e.clientX - sx) + 'px';
      panel.style.top = (oy + e.clientY - sy) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => (dragging = false));

    panel.querySelector('.as-body').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'toggle') {
        paused = !paused;
        const v = document.querySelector('video');
        if (paused) {
          if (v) v.pause(); // 真正把视频停掉
          log('已暂停：视频、答题、自动跳下一节均已停止');
        } else {
          if (v) { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
          log('已继续：视频、答题、自动跳下一节均已恢复');
        }
      } else if (act === 'fast') {
        fastFinish();
      } else if (act === 'next') {
        goNext();
      }
    });
  }

  // ======================= 入口 =======================
  function main() {
    buildPanel();
    if (location.pathname.indexOf('courseDetail') >= 0) {
      log('检测到课程详情页');
      makeBackgroundSafe();
      if (CONFIG.autoStart) {
        log(`自动刷课已启动：默认 ${CONFIG.defaultRate}x，自动跳下一节=${CONFIG.autoNext ? '开' : '关'}`);
      }
    } else {
      log('当前不是课程详情页，请进入视频课页面');
    }
    setInterval(mainLoop, 800);
  }

  function boot() {
    try { main(); } catch (e) {
      console.error('[自动刷课] 运行出错：', e);
      alert('[自动刷课] 运行出错：' + (e && e.message ? e.message : e));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
