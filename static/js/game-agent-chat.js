/* Game Agent 聊天窗 —— 纯前端组件
 * 直接在静态页面上渲染一个可对话的窗口，后端由你的消息网关提供 REST 接口。
 */
(function () {
  "use strict";

  /* ===================== 配置区（按你的网关填） ===================== */
  var CONFIG = {
    // 网关公网地址，必须 https（GitHub Pages 是 https，不会放行 http）
    baseUrl: "https://your-gateway.example.com",
    // 专用低权限 token。注意：它会随页面暴露给访客，
    // 真正的防护要靠在网关侧做限流 + 复用控制。
    token: "REPLACE_WITH_YOUR_TOKEN",
    // 发送消息接口：POST { baseUrl + chatEndpoint }
    //   请求体: { "message": "..." }
    //   请求头: Authorization: Bearer <token>
    //   响应体(同步模式): { "reply": "..." }  或 { "error": "..." }
    chatEndpoint: "/api/v1/game-agent/chat",
    // 回复模式：
    //   "sync" — 网关一次请求直接返回 {reply}（默认）
    //   "poll" — 网关先返回 {id}，再用 GET {replyEndpoint}?id=<id> 轮询直到返回 {reply} 或超时
    replyMode: "poll",
    pollIntervalMs: 1500,
    pollTimeoutMs: 60000,
    // UI
    botName: "Game Agent",
    typingText: "Agent 正在思考…",
    placeholder: "输入指令，开始和 Agent 对话…",
    maxMessageChars: 2000,
    // 演示模式：true 时强制走本地模拟回复（不改配置也能预览效果）
    mock: false,
    // 未填写 baseUrl/token 时自动进入演示模式
    mockWhenUnconfigured: true,
    mockDelayMs: 900
  };
  /* ================================================================= */

  var el = document.getElementById("game-agent-chat");
  if (!el) return;

  /* render() 初始化的 DOM 引用（必须声明，脚本处于 "use strict" 模式） */
  var bodyEl, inputEl, sendBtn, statusEl;

  /* 用 Hugo shortcode 注入的 data-* 属性覆盖默认配置（config.toml [params.gameAgent]） */
  (function mergeDataConfig() {
    var d = el.dataset || {};
    if (d.baseUrl) CONFIG.baseUrl = d.baseUrl;
    if (d.token) CONFIG.token = d.token;
    if (d.replyMode) CONFIG.replyMode = d.replyMode;
    if (d.mock === "true") CONFIG.mock = true;
    if (d.mock === "false") CONFIG.mock = false;
  })();

  /* 访客标识：localStorage 持久化，随请求上传，网关按此隔离每个访客的记忆。
   * 同一浏览器刷新/重开页面都保持同一 id；仅换浏览器/设备/清缓存/隐私模式会生成新 id。 */
  function visitorId() {
    var k = "gac-visitor-id";
    var v = null;
    try { v = localStorage.getItem(k); } catch (e) { /* 存储不可用（隐私模式等） */ }
    if (!v) {
      v = "v" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      try { localStorage.setItem(k, v); } catch (e) { /* 降级为会话内 id */ }
    }
    return v;
  }

  var MSG = ""; // 后续填充

  /* ---------- 基础工具 ---------- */
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function isConfigFilled() {
    return CONFIG.baseUrl.indexOf("your-gateway") === -1 &&
      CONFIG.token.indexOf("REPLACE") === -1;
  }
  function mockEnabled() {
    return CONFIG.mock || (CONFIG.mockWhenUnconfigured && !isConfigFilled());
  }

  /* ---------- Markdown 渲染 ----------
   * 首选标准解析：marked（GFM：表格/删除线/嵌套列表/图片/分割线）+ DOMPurify（XSS 净化）。
   * CDN 不可用时回退到内置简易渲染器（mdRender）。 */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderMarkdown(text) {
    if (window.marked && window.DOMPurify) {
      try {
        var raw = window.marked.parse(String(text));
        return window.DOMPurify.sanitize(raw);
      } catch (e) { /* 解析失败回退简易渲染 */ }
    }
    return mdRender(text);
  }

  /* 链接新窗口打开（DOMPurify 净化后补属性） */
  if (window.DOMPurify) {
    window.DOMPurify.addHook("afterSanitizeAttributes", function (node) {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }

  function inlineMd(raw) {
    var t = escapeHtml(raw);
    t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    // 图片 ![alt](url) 必须在链接之前处理（只允许 http/https，防注入）
    t = t.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return t;
  }

  function mdRender(text) {
    var lines = String(text).split("\n");
    var out = [], inList = false, inCode = false, codeBuf = [], tableBuf = [];
    function closeList() { if (inList) { out.push("</ul>"); inList = false; } }
    function flushTable() {
      if (tableBuf.length === 0) return;
      var cells = function (ln) { return ln.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(function (c) { return c.trim(); }); };
      var header = cells(tableBuf[0]);
      var rows = tableBuf.slice(1).map(cells).filter(function (r) {
        return !(r.length > 0 && r.every(function (c) { return /^[-: ]+$/.test(c); })); // 去掉分隔行
      });
      var html = "<table><thead><tr>" + header.map(function (h) { return "<th>" + inlineMd(h) + "</th>"; }).join("") + "</tr></thead><tbody>";
      html += rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inlineMd(c) + "</td>"; }).join("") + "</tr>"; }).join("");
      html += "</tbody></table>";
      out.push(html);
      tableBuf = [];
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*```/.test(line)) {
        if (inCode) { out.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>"); codeBuf = []; inCode = false; }
        else { closeList(); flushTable(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }
      if (/^\s*\|/.test(line)) { closeList(); tableBuf.push(line); continue; } // 表格行
      flushTable();
      var h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) { closeList(); out.push("<h" + h[1].length + ">" + inlineMd(h[2]) + "</h" + h[1].length + ">"); continue; }
      // 分割线 --- / *** / ___
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
      var li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
      if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push("<li>" + inlineMd(li[1]) + "</li>"); continue; }
      closeList();
      var q = line.match(/^\s*>\s+(.*)/);
      if (q) { out.push("<blockquote>" + inlineMd(q[1]) + "</blockquote>"); continue; }
      out.push(inlineMd(line));
    }
    closeList();
    flushTable();
    if (inCode) out.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
    return out.join("\n");
  }

  /* ---------- 渲染 ---------- */
  function render() {
    el.innerHTML =
      '<div class="gac-header">' +
        '<div class="gac-avatar">GA</div>' +
        '<div><div class="gac-name">' + esc(CONFIG.botName) + '</div>' +
        '<div class="gac-status" id="gac-status">· 在线</div></div>' +
      '</div>' +
      '<div class="gac-body" id="gac-body"></div>' +
      '<div class="gac-input-row">' +
        '<textarea class="gac-input" id="gac-input" rows="1" placeholder="' + esc(CONFIG.placeholder) + '"></textarea>' +
        '<button class="gac-send" id="gac-send">发送</button>' +
      '</div>' +
      '<div class="gac-hint" id="gac-hint"></div>';

    bodyEl = el.querySelector("#gac-body");
    inputEl = el.querySelector("#gac-input");
    sendBtn = el.querySelector("#gac-send");
    statusEl = el.querySelector("#gac-status");

    if (mockEnabled()) {
      statusEl.textContent = "· 演示模式";
      setHint("本地演示模式：还未连接真实网关。回复为模拟数据，填入 baseUrl 与 token 后自动切换。");
    } else if (!isConfigFilled()) {
      statusEl.textContent = "· 未配置";
      setHint("配置未完成：请在 static/js/game-agent-chat.js 顶部填写 baseUrl 与 token。");
      sendBtn.disabled = true;
      inputEl.disabled = true;
      return;
    } else if (!/^https:\/\//.test(CONFIG.baseUrl)) {
      statusEl.textContent = "· 配置错误";
      setHint("baseUrl 必须使用 https://，否则会被浏览器拦截。");
      sendBtn.disabled = true;
      inputEl.disabled = true;
      return;
    }
    appendMsg("agent", "你好，我是 " + CONFIG.botName + "。把指令发给我，我来执行或回答。" + (mockEnabled() ? "（演示模式）" : ""));
    setHint("请求带访问 token，网关侧有限流；对话可能需要几秒，请耐心等待。");
  }

  function setHint(t) {
    var h = el.querySelector("#gac-hint");
    if (h) h.textContent = t;
  }

  function appendMsg(role, text) {
    var div = document.createElement("div");
    div.className = "gac-msg " + role;
    if (role === "agent") {
      div.className += " md";
      div.innerHTML = renderMarkdown(text); // agent 回复渲染 Markdown（标准解析）
    } else {
      div.textContent = text; // 用户消息保持纯文本
    }
    bodyEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function appendSystem(text, isError) {
    var div = document.createElement("div");
    div.className = "gac-msg " + (isError ? "error" : "agent");
    div.textContent = text;
    bodyEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  /* 打字机效果：回复文本按码点逐字打出（安全处理 emoji/多字节），总时长自适应约 0.3~2.5s */
  function typewriterAppend(text, onDone) {
    var div = document.createElement("div");
    div.className = "gac-msg agent md";
    bodyEl.appendChild(div);
    var chars = Array.from(text || "");
    if (chars.length === 0) { scrollToBottom(); if (onDone) onDone(); return; }
    var totalMs = Math.max(300, Math.min(2500, chars.length * 14));
    var step = Math.max(1, Math.ceil(chars.length / (totalMs / 16)));
    var i = 0;
    var timer = setInterval(function () {
      i = Math.min(chars.length, i + step);
      div.innerHTML = renderMarkdown(chars.slice(0, i).join("")); // 逐字渲染 Markdown
      scrollToBottom();
      if (i >= chars.length) {
        clearInterval(timer);
        if (onDone) onDone();
      }
    }, 16);
  }

  function showTyping() {
    var t = document.createElement("div");
    t.className = "gac-typing";
    t.innerHTML = "<span></span><span></span><span></span>";
    bodyEl.appendChild(t);
    scrollToBottom();
    return t;
  }

  function scrollToBottom() {
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  /* ---------- 富内容块（blocks）渲染 ---------- */
  function safeUrl(u) {
    return /^https?:\/\//i.test(String(u || "")) ? String(u) : "";
  }
  /* 从封面 URL 提取 Steam appid，生成备份图源列表（原图优先，失败依次试无 hash 的跨域名镜像）；
     若后端给了显式 covers 数组，则优先使用它（仍带跨域降级 + 镜像兜底） */
  function coverCandidates(url, extraCovers) {
    var results = [];
    function push(u) {
      var s = safeUrl(u);
      if (!s || results.indexOf(s) >= 0) return;
      results.push(s);
    }
    // 显式 covers（后端）优先
    if (Array.isArray(extraCovers)) {
      for (var e = 0; e < extraCovers.length; e++) push(extraCovers[e]);
    }
    push(url); // 原图
    var stripped = safeUrl(url).split("?")[0]; // 去掉 ?t= 时间戳
    if (stripped && stripped !== url) push(stripped);
    // 提取 appid：匹配 /apps/(\d+)/
    var m = safeUrl(url).match(/\/apps\/(\d+)\//);
    if (m) {
      var id = m[1];
      push("https://steamcdn-a.akamaihd.net/steam/apps/" + id + "/header.jpg");
      push("https://cdn.akamai.steamstatic.com/steam/apps/" + id + "/header.jpg");
      push("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + id + "/header.jpg");
    }
    return results;
  }
  function gameCardHtml(b) {
    var cover = safeUrl(b.cover);
    var video = safeUrl(b.video);
    var offPct = "";
    if (b.origin_price > 0 && b.price > 0 && b.price < b.origin_price) {
      offPct = "-" + Math.round((1 - b.price / b.origin_price) * 100) + "%";
    }
    var h = '<div class="gac-card">';
    if (cover) {
      h += '<div class="gac-card-cover"><img src="' + cover + '" alt="' + escapeHtml(b.name || "") + '" loading="lazy">';
      if (offPct) h += '<div class="gac-card-off">' + offPct + "</div>";
      h += "</div>";
    } else if (offPct) {
      h += '<div class="gac-card-off-float">' + offPct + "</div>";
    }
    h += '<div class="gac-card-body">';
    h += '<div class="gac-card-name">' + escapeHtml(b.name || "") + "</div>";
    if (b.en_name) h += '<div class="gac-card-en">' + escapeHtml(b.en_name) + "</div>";
    if (b.price > 0) {
      h += '<div class="gac-card-prices"><span class="gac-card-now">¥' + escapeHtml(String(b.price)) + "</span>";
      if (b.origin_price > 0) h += '<span class="gac-card-old">¥' + escapeHtml(String(b.origin_price)) + "</span>";
      h += "</div>";
    }
    h += '<div class="gac-card-chips">';
    if (b.rating) h += '<span class="gac-card-chip">⭐ ' + escapeHtml(String(b.rating)) + "</span>";
    if (b.platform) h += '<span class="gac-card-chip">' + escapeHtml(String(b.platform)) + "</span>";
    if (b.remaining) h += '<span class="gac-card-chip">⏳ ' + escapeHtml(String(b.remaining)) + "</span>";
    h += "</div>";
    // 各平台价格明细：划线原价 + 现价 + 折扣%，最大折扣（第一行）高亮
    var plats = Array.isArray(b.prices) ? b.prices : [];
    if (plats.length > 0) {
      h += '<div class="gac-card-plats">';
      for (var pi = 0; pi < plats.length; pi++) {
        var r = plats[pi];
        if (!r || !r.name) continue;
        var best = pi === 0 && r.off_pct > 0;
        h += '<div class="gac-plat' + (best ? " gac-plat-best" : "") + '">' +
          '<span class="gac-plat-name">' + escapeHtml(String(r.name)) +
          (best ? '<span class="gac-plat-badge">最大折扣</span>' : "") + "</span>" +
          (r.origin_price > 0 ? '<span class="gac-plat-old">¥' + escapeHtml(String(r.origin_price)) + "</span>" : "") +
          '<span class="gac-plat-now">¥' + escapeHtml(String(r.price)) + "</span>" +
          (r.off_pct > 0 ? '<span class="gac-plat-off">-' + escapeHtml(String(r.off_pct)) + "%</span>" : "") +
          "</div>";
      }
      h += "</div>";
    }
    if (video) {
      h += '<a class="gac-card-btn" href="' + video + '" target="_blank" rel="noopener noreferrer">🎬 看预告 / 演示</a>';
    }
    h += '<button type="button" class="gac-card-btn gac-card-poster-btn">🖼️ 生成海报</button>';
    h += "</div></div>";
    return h;
  }

  /* ---------- 海报：canvas 渲染 + 模态框（下载 PNG / 复制图片） ---------- */
  function loadImage(url, extraCovers) {
    return new Promise(function (resolve) {
      var candidates = coverCandidates(url, extraCovers); // 原图 + 显式covers + 备用镜像
      if (!candidates.length) { resolve(null); return; }
      var idx = 0;
      function next() {
        if (idx >= candidates.length) { resolve(null); return; }
        var u = candidates[idx++];
        var triedPlain = false;
        function tryLoad(useCors) {
          var img = new Image();
          if (useCors) img.crossOrigin = "anonymous";
          img.__corsOk = useCors; // 标记是否走 CORS（决定 canvas 能否导出）
          img.__src = u;          // 记录实际加载成功 URL（内联兜底显示）
          var done = false;
          var finish = function (ok) {
            if (done) return; done = true;
            if (ok) resolve(img);
            else if (useCors && !triedPlain) { triedPlain = true; setTimeout(function () { tryLoad(false); }, 0); }
            else next(); // 此候选失败，试下一个镜像
          };
          img.onload = function () { finish(true); };
          img.onerror = function () { finish(false); };
          img.src = u;
        }
        tryLoad(true);
      }
      next();
    });
  }
  function wrapText(ctx, text, maxW) {
    var lines = [], cur = "";
    for (var i = 0; i < Array.from(text).length; i++) {
      var ch = Array.from(text)[i];
      var t = cur + ch;
      if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = ch; }
      else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // 海报主题池：随机搭配一套，保证每套配色协调
  var POSTER_THEMES = [
    { bg: ["#241111", "#120707", "#0a0303"], fade: "22,9,9",
      title: "#ffffff", en: "#d4af37", origin: "#b5b5b5", price: "#ffd23f",
      tagTop: "#ff6b4a", tagBot: "#d92626", chipRemaining: "#a8c7e8",
      chipBg: "rgba(255,255,255,0.06)", chipBorder: "rgba(255,255,255,0.12)",
      panelBg: "rgba(20,22,28,0.72)", platName: "#e3e7ee", platOld: "#8a93a3",
      platMore: "#7a828e", platSd: "#ff5252", footer: "#6d6d6d", footerLine: "#3d2424" },
    { bg: ["#0b1a2b", "#071120", "#03090f"], fade: "8,16,28",
      title: "#eaf2ff", en: "#7fb3e0", origin: "#93a5b8", price: "#ffd23f",
      tagTop: "#3d9bff", tagBot: "#1556b0", chipRemaining: "#6fc3ff",
      chipBg: "rgba(255,255,255,0.07)", chipBorder: "rgba(120,180,255,0.15)",
      panelBg: "rgba(15,26,40,0.80)", platName: "#dbe6f2", platOld: "#7e93a8",
      platMore: "#6f8599", platSd: "#ff6b6b", footer: "#8aa0b5", footerLine: "#26435f" },
    { bg: ["#221031", "#150823", "#08030f"], fade: "16,9,26",
      title: "#f5ecff", en: "#c9a5f0", origin: "#a78fbb", price: "#ffd23f",
      tagTop: "#b06bff", tagBot: "#6a24c9", chipRemaining: "#c9a5f0",
      chipBg: "rgba(255,255,255,0.07)", chipBorder: "rgba(190,150,255,0.15)",
      panelBg: "rgba(30,18,45,0.80)", platName: "#ece0f7", platOld: "#937aa8",
      platMore: "#7e6b90", platSd: "#ff6bd6", footer: "#a892bf", footerLine: "#4a2a6b" }
  ];
  // ===== 模块化海报引擎：主题(配色) × 版式(Form: 尺寸+模块摆位) 双随机 =====
  // 模块 helper 均从 DATA 取内容，从 th 取色；
  // -- 封面等比裁剪(crop)：等比放大填满区域、居中裁掉超出的部分，绝不拉伸变形
  function mCover(ctx, img, x, y, w, h) {
    if (!img) return;
    var iw = img.width, ih = img.height;
    if (!iw || !ih) { ctx.drawImage(img, x, y, w, h); return; }
    var scale = Math.max(w / iw, h / ih);
    var sw = w / scale, sh = h / scale;          // 源里取的样子
    var sx = (iw - sw) / 2, sy = (ih - sh) / 2;  // 居中
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }
  // -- 封面（cover 已由调用方画好，这里画融合带）
  function mCoverFade(ctx, W, th, fadeBottom) {
    var f = ctx.createLinearGradient(0, fadeBottom - 130, 0, fadeBottom);
    f.addColorStop(0.00, "rgba(" + th.fade + ",0)");
    f.addColorStop(0.55, "rgba(" + th.fade + ",0.85)");
    f.addColorStop(1.00, "rgba(" + th.fade + ",1)");
    ctx.fillStyle = f; ctx.fillRect(0, fadeBottom - 130, W, 130);
  }
  // -- 标题：居中或左对齐，自适应字号，返回底部y
  function mTitle(ctx, x, topY, maxW, th, name, align, deco) {
    ctx.textAlign = align === "left" ? "left" : "center";
    ctx.textBaseline = "alphabetic";
    var size = 52;
    for (; size >= 28; size -= 4) {
      ctx.font = "800 " + size + "px 'PingFang SC',sans-serif";
      var ls = wrapText(ctx, name, maxW);
      var mx = 0; for (var i = 0; i < ls.length; i++) mx = Math.max(mx, ctx.measureText(ls[i]).width);
      if (ls.length <= 2 && mx <= maxW) break;
    }
    if (size < 28) size = 28;
    ctx.font = "800 " + size + "px 'PingFang SC',sans-serif";
    var lines = wrapText(ctx, name, maxW).slice(0, 2);
    ctx.fillStyle = th.title;
    for (var ti = 0; ti < lines.length; ti++) ctx.fillText(lines[ti], x, topY + ti * (size + 6));
    var bot = topY + (lines.length - 1) * (size + 6);
    if (deco === "band") {
      var bw = 56;
      var bg = ctx.createLinearGradient(x, 0, x + bw, 0);
      bg.addColorStop(0, th.tagTop); bg.addColorStop(1, th.tagBot);
      ctx.fillStyle = bg; roundRectPath(ctx, x, bot + 14, bw, 6, 3); ctx.fill();
      bot += 22;
    }
    return bot;
  }
  // -- 英文名：对齐，返回底部y
  function mEn(ctx, x, topY, maxW, th, en, align) {
    if (!en) return topY;
    ctx.textAlign = align === "left" ? "left" : "center";
    var t = String(en);
    ctx.fillStyle = th.en; ctx.font = "22px Georgia";
    if (ctx.measureText(t).width > maxW) { while (ctx.measureText(t + "…").width > maxW && t.length > 1) t = t.slice(0, -1); t += "…"; }
    ctx.fillText(t, x, topY);
    return topY + 44;
  }
  // -- 价格块（含原价划线 + 价格大字 + 价签 tag），align=center/left；返回价格基线y
  function mPrice(ctx, x, topY, th, origin, price, off, align, tagMode) {
    var mainY = Math.max(topY, 0);
    var px = x;
    if (origin > 0 && off !== "") {
      ctx.textAlign = align === "left" ? "left" : "center";
      ctx.font = "28px 'PingFang SC',sans-serif"; ctx.fillStyle = th.origin;
      ctx.fillText("¥" + origin, px, mainY);
      var w0 = ctx.measureText("¥" + origin).width;
      var lnL = align === "left" ? px : px - w0 / 2, lnR = align === "left" ? px + w0 : px + w0 / 2;
      ctx.strokeStyle = th.origin; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lnL, mainY - 10); ctx.lineTo(lnR, mainY - 10); ctx.stroke();
      mainY += 70;
    }
    if (price > 0) {
      var pTxt = "¥" + price;
      var pFs = pTxt.length > 7 ? 66 : 92;
      ctx.font = "900 " + pFs + "px Arial,'PingFang SC',sans-serif";
      var pw = ctx.measureText(pTxt).width;
      if (off) {
        if (tagMode === "above") {
          // tag 在价格正上方横条
          var tW = ctx.measureText(off).width + 64;
          var tagY = mainY - pFs * 0.62;
          var tg = ctx.createLinearGradient(0, tagY - 22, 0, tagY + 22);
          tg.addColorStop(0, th.tagTop); tg.addColorStop(1, th.tagBot);
          ctx.save();
          ctx.translate(align === "left" ? px + tW / 2 : px, tagY);
          ctx.rotate(8 * Math.PI / 180);
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = tg; roundRectPath(ctx, -tW / 2, -22, tW, 44, 22); ctx.fill();
          ctx.fillStyle = "#fff"; ctx.font = "900 28px Arial"; ctx.fillText(off, 0, 2);
          ctx.restore();
          ctx.textAlign = align === "left" ? "left" : "center"; ctx.textBaseline = "alphabetic";
          ctx.font = "900 " + pFs + "px Arial,'PingFang SC',sans-serif";
        } else {
          // tag 在价格右侧（组合居中）
          var gap = 32, tagBodyR = 58;
          var cx = align === "left" ? px : (off ? px - (gap + tagBodyR) / 2 : px);
          ctx.save();
          ctx.translate(align === "left" ? (px + pw + gap) : (cx + pw / 2 + gap), mainY - (pFs > 70 ? 34 : 26));
          ctx.rotate(18 * Math.PI / 180);
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          var TH = 80, TR = 18, yT = -TH / 2, yB = TH / 2;
          var bodyL = -36, bodyR = 58, tipX = -72;
          var b2 = ctx.createLinearGradient(0, yT, 0, yB);
          b2.addColorStop(0, th.tagTop); b2.addColorStop(1, th.tagBot);
          ctx.fillStyle = b2;
          ctx.beginPath();
          ctx.moveTo(bodyL, yT); ctx.lineTo(bodyR - TR, yT); ctx.arcTo(bodyR, yT, bodyR, yT + TR, TR);
          ctx.lineTo(bodyR, yB - TR); ctx.arcTo(bodyR, yB, bodyR - TR, yB, TR); ctx.lineTo(bodyL, yB);
          ctx.quadraticCurveTo(tipX, yB * 0.32, tipX + 4, 0); ctx.quadraticCurveTo(tipX, yT * 0.32, bodyL, yT);
          ctx.closePath(); ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = 3; ctx.stroke();
          ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(-46, -6, 9, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = "#fff"; ctx.font = "900 32px Arial"; ctx.fillText(off, (bodyL + bodyR) / 2 + 10, 2);
          ctx.restore();
          ctx.textAlign = align === "left" ? "left" : "center"; ctx.textBaseline = "alphabetic";
          px = align === "left" ? px : cx;
        }
      }
      ctx.fillStyle = th.price; ctx.font = "900 " + pFs + "px Arial,'PingFang SC',sans-serif";
      ctx.fillText(pTxt, align === "left" ? x : px, mainY);
    }
    return mainY;
  }
  // -- chips：评分/剩余
  function mChips(ctx, x, topY, th, rating, remaining, align) {
    var chips = [];
    if (rating) chips.push({ text: "★ " + rating, color: th.price });
    if (remaining) chips.push({ text: String(remaining), color: th.chipRemaining });
    if (!chips.length) return topY;
    ctx.font = "800 24px 'PingFang SC',sans-serif";
    var cws = [], ctw = 0;
    for (var i = 0; i < chips.length; i++) { cws.push(ctx.measureText(chips[i].text).width + 36); ctw += cws[i] + 10; }
    ctx.textAlign = align === "left" ? "left" : "center";
    var cx = align === "left" ? x : x - (ctw - 10) / 2;
    for (var j = 0; j < chips.length; j++) {
      ctx.fillStyle = th.chipBg; roundRectPath(ctx, cx, topY - 24, cws[j], 42, 21); ctx.fill();
      ctx.strokeStyle = th.chipBorder; ctx.lineWidth = 1; roundRectPath(ctx, cx, topY - 24, cws[j], 42, 21); ctx.stroke();
      ctx.fillStyle = chips[j].color; ctx.fillText(chips[j].text, cx + cws[j] / 2, topY);
      cx += cws[j] + 10;
    }
    ctx.textAlign = align === "left" ? "left" : "center"; ctx.textBaseline = "alphabetic";
    return topY + 42;
  }
  // -- 平台价格面板
  function mPanel(ctx, x, topY, W, th, plats, cols) {
    var items = [];
    // 面板内 best = 主价格最低价平台（与主价格一致）
    var minP = Infinity;
    for (var mk = 0; mk < plats.length; mk++) { var mi = plats[mk]; if (mi && mi.price > 0 && mi.price < minP) minP = mi.price; }
    for (var ik = 0; ik < plats.length; ik++) {
      var it = plats[ik];
      if (!it || !it.name) continue;
      items.push({ name: String(it.name), originP: it.origin_price || 0, price: it.price || 0, offP: it.off_pct || 0, best: it.price > 0 && it.price === minP });
    }
    if (!items.length) return topY;
    var shown = items.slice(0, 8);
    var colGap = 40, panelW = Math.min(W, 560), cellW = (panelW - colGap) / 2;
    var cellH = 40, rows = Math.ceil(shown.length / cols);
    var panelH = rows * cellH;
    var isLeft = x !== 360;
    var panelX = isLeft ? x - 6 : 360 - panelW / 2;
    ctx.fillStyle = th.panelBg; roundRectPath(ctx, panelX - 14, topY - 12, panelW + 28, panelH + 24, 14); ctx.fill();
    ctx.font = "22px 'PingFang SC',sans-serif";
    for (var ri = 0; ri < shown.length; ri++) {
      var itm = shown[ri];
      var ccx = panelX + (ri % cols) * (cellW + colGap) + cellW / 2;
      var ccy = topY + Math.floor(ri / cols) * cellH + cellH / 2;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      var nameW = cellW * 0.42, nm = itm.name;
      while (ctx.measureText(nm + "…").width > nameW && Array.from(nm).length > 1) nm = Array.from(nm).slice(0, -1).join("");
      if (nm !== itm.name) nm += "…";
      ctx.fillStyle = itm.best ? th.price : th.platName;
      ctx.font = "800 " + (itm.best ? 23 : 21) + "px 'PingFang SC',sans-serif";
      var nameLeft = ccx - cellW / 2 + 4, nameWpx = ctx.measureText(nm).width;
      ctx.fillText(nm, nameLeft, ccy);
      if (itm.best && itm.offP > 0) { ctx.fillStyle = th.platSd; ctx.font = "800 14px 'PingFang SC',sans-serif"; ctx.fillText("史低", nameLeft + nameWpx + 6, ccy); }
      ctx.font = "22px 'PingFang SC',sans-serif";
      var priceX = ccx + cellW / 2 - 6, px = priceX;
      ctx.fillStyle = th.price; ctx.font = "800 21px Arial,'PingFang SC',sans-serif";
      var nowT = "¥" + itm.price; ctx.fillText(nowT, px - ctx.measureText(nowT).width, ccy);
      px -= ctx.measureText(nowT).width + 10;
      if (itm.originP > 0 && itm.originP > itm.price) {
        ctx.font = "15px 'PingFang SC',sans-serif"; ctx.fillStyle = th.platOld;
        var oldT = "¥" + itm.originP, ow = ctx.measureText(oldT).width;
        ctx.fillText(oldT, px - ow, ccy); ctx.strokeStyle = th.platOld; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px - ow, ccy + 1); ctx.lineTo(px, ccy + 1); ctx.stroke(); px -= ow + 8;
      }
    }
    ctx.textAlign = isLeft ? "left" : "center"; ctx.textBaseline = "alphabetic";
    return topY - 12 + panelH + 24 + 8;
  }
  // -- footer
  function mFooter(ctx, x, topY, th, align) {
    var fy = Math.max(topY, 0);
    ctx.strokeStyle = th.footerLine; ctx.lineWidth = 2;
    var fL = align === "left" ? x - 16 : 140, fR = align === "left" ? 596 : 580;
    ctx.beginPath(); ctx.moveTo(fL, fy); ctx.lineTo(fR, fy); ctx.stroke();
    ctx.fillStyle = th.footer; ctx.font = "20px 'PingFang SC',sans-serif";
    ctx.fillText("由 Stray 查价生成 · 数据实时查询", align === "left" ? x : 360, fy + 36);
    return fy + 36;
  }
  // ===== 版式 pool =====
  // ===== 版式 pool（当前仅保留 F0 经典竖版；每个元素 helper 均独立可移动，可自行组合新增版式） =====
  var POSTER_FORMS = [
    // F0 经典竖版 720x960（A）
    { w: 720, h: 960, render: function (ctx, D) {
      var W = D.w, th = D.th, cover = D.coverImg;
      ctx.textAlign = "center";
      if (cover) { mCover(ctx, cover, 0, 0, W, 340); mCoverFade(ctx, W, th, 400); }
      var bot = mTitle(ctx, 360, 426, 600, th, D.name, "center", "none");
      bot = mEn(ctx, 360, bot + 40, 560, th, D.en, "center");
      var py = Math.max(bot + 46, 556);
      py = mPrice(ctx, 360, py, th, D.origin, D.price, D.off, "center", "tagRight");
      var cy = mChips(ctx, 360, py + 60, th, D.rating, D.remaining, "center");
      var bandTop = Math.max(cy + 42, py + 88);
      var end = mPanel(ctx, 360, bandTop, 560, th, D.plats, 2);
      mFooter(ctx, 360, Math.max(end + 14, 862), th, "center");
    } }
  ];
  function drawPoster(canvas, b, coverImg) {
    var th = POSTER_THEMES[(Math.random() * POSTER_THEMES.length) | 0];
    var fm = POSTER_FORMS[0]; // 当前仅 F0；可在此改为随机或依条件选版式
    var W = fm.w, H = fm.h;
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, th.bg[0]); g.addColorStop(0.55, th.bg[1]); g.addColorStop(1, th.bg[2]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 解析数据：主价格 = 所有平台中最低价
    var plats = (Array.isArray(b.prices) && b.prices.length) ? b.prices : [];
    var best = null;
    for (var bp = 0; bp < plats.length; bp++) {
      var cand = plats[bp];
      if (!cand || !(cand.price > 0)) continue;
      if (!best || cand.price < best.price) best = cand; // 取最低现价平台
    }
    var D = {
      w: W, h: H, th: th, coverImg: coverImg,
      name: String(b.name || ""), en: b.en_name ? String(b.en_name) : "",
      rating: b.rating, remaining: b.remaining, plats: plats,
      origin: best && best.origin_price ? best.origin_price : (b.origin_price || 0),
      price: best && best.price ? best.price : (b.price || 0)
    };
    D.off = "";
    if (D.origin > 0 && D.price > 0 && D.price < D.origin) D.off = "-" + Math.round((1 - D.price / D.origin) * 100) + "%";
    fm.render(ctx, D);
  }
  function toast(msg) {
    var t = document.createElement("div");
    t.className = "gac-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2000);
  }
  /* toBlob 兜底：偶发不回调（老 WebKit/被拒）时用 dataURL 转 Blob */
  function canvasToBlob(canvas) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (b) { if (!done) { done = true; resolve(b); } };
      try { canvas.toBlob(finish, "image/png"); } catch (e) { finish(null); }
      setTimeout(function () {
        if (done) return;
        done = true;
        try {
          var url = canvas.toDataURL("image/png");
          fetch(url).then(function (r) { return r.blob(); }).then(resolve).catch(function () { resolve(null); });
        } catch (e2) { resolve(null); }
      }, 900);
    });
  }
  function downloadCanvas(canvas) {
    canvasToBlob(canvas).then(function (blob) {
      if (!blob) { toast("生成图片失败，可对海报图片右键另存"); return; }
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "stray-poster-" + Date.now() + ".png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast("已开始下载海报 💾");
    });
  }
  function copyCanvas(canvas) {
    canvasToBlob(canvas).then(function (blob) {
      if (!blob) { toast("生成图片失败"); return; }
      if (navigator.clipboard && window.ClipboardItem) {
        navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
          .then(function () { toast("已复制到剪贴板 ✅"); },
                function () { toast("复制被浏览器拒绝，请用『下载 PNG』"); });
      } else {
        toast("当前浏览器不支持复制图片，请用『下载 PNG』");
      }
    });
  }
  /* 海报请求：先生成内联海报图，再发文字 */
  function showInlinePoster(block, onDone) {
    loadImage(safeUrl(block.cover), block.covers).then(function (img) {
      var canvas = document.createElement("canvas");
      try { drawPoster(canvas, block, img); } catch (e) { /* 保留空白画布，按钮仍可用 */ }
      var wrap = document.createElement("div");
      wrap.className = "gac-poster-inline-wrap";
      wrap.innerHTML =
        '<img class="gac-poster-inline" alt="海报">' +
        '<div class="gac-poster-inline-actions">' +
          '<button type="button" data-act="save">💾 下载 PNG</button>' +
          '<button type="button" data-act="copy">📋 复制图片</button>' +
        "</div>";
      var pimg = wrap.querySelector("img");
      var fallbackSrc = (img && img.__src) ? img.__src : safeUrl(block.cover);
      // 画布被污染(封面走了非CORS降级)时 toDataURL 会抛错，改用实际加载成功的图 src 兜底显示
      if (img && img.__corsOk === false) {
        pimg.src = fallbackSrc;
      } else {
        try { pimg.src = canvas.toDataURL("image/png"); } catch (e) { pimg.src = fallbackSrc || ""; }
      }
      bodyEl.appendChild(wrap);
      scrollToBottom();
      wrap.querySelector('[data-act="save"]').addEventListener("click", function () { downloadCanvas(canvas); });
      wrap.querySelector('[data-act="copy"]').addEventListener("click", function () { copyCanvas(canvas); });
      if (onDone) setTimeout(onDone, 150);
    });
  }
  function openPoster(block) {
    loadImage(safeUrl(block.cover), block.covers).then(function (img) {
      var overlay = document.createElement("div");
      overlay.className = "gac-poster-modal";
      overlay.innerHTML =
        '<div class="gac-poster-box">' +
          '<canvas class="gac-poster-canvas"></canvas>' +
          '<div class="gac-poster-actions">' +
            '<button type="button" class="gac-poster-act" data-act="save">💾 下载 PNG</button>' +
            '<button type="button" class="gac-poster-act" data-act="copy">📋 复制图片</button>' +
            '<button type="button" class="gac-poster-act gac-poster-close">✕ 关闭</button>' +
          "</div>" +
        "</div>";
      document.body.appendChild(overlay);
      var canvas = overlay.querySelector("canvas");
      // 先绑定事件（即使绘制失败按钮也可用），再绘制
      overlay.querySelector(".gac-poster-close").addEventListener("click", function () { overlay.remove(); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });
      overlay.querySelector('[data-act="save"]').addEventListener("click", function () { downloadCanvas(canvas); });
      overlay.querySelector('[data-act="copy"]').addEventListener("click", function () { copyCanvas(canvas); });
      try { drawPoster(canvas, block, img); } catch (e) { /* 保留空画布，操作仍可用 */ }
    });
  }
  function renderBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) return;
    var wrap = document.createElement("div");
    wrap.className = "gac-blocks";
    blocks.forEach(function (b) {
      var div = document.createElement("div");
      div.className = "gac-block gac-block-" + (b && b.type ? escapeHtml(String(b.type)) : "unknown");
      if (b && b.type === "game_card") {
        div.innerHTML = gameCardHtml(b);
        var btn = div.querySelector(".gac-card-poster-btn");
        if (btn) {
          btn.addEventListener("click", function () { openPoster(b); });
        }
      } else if (b && b.type === "poster" && /^data:image\/svg\+xml;base64,/.test(String(b.src || ""))) {
        var img = document.createElement("img");
        img.className = "gac-poster";
        img.src = String(b.src);
        img.alt = "海报";
        img.loading = "lazy";
        div.appendChild(img);
      } else {
        div.textContent = JSON.stringify(b); // 未知块降级为文本
      }
      wrap.appendChild(div);
    });
    bodyEl.appendChild(wrap);
    scrollToBottom();
  }

  /* ---------- 网络层 ---------- */
  function headers() {
    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.token
    };
  }

  async function sendMessage(text) {
    if (mockEnabled()) {
      await sleep(CONFIG.mockDelayMs);
      return { reply: mockReply(text), blocks: [] };
    }

    var url = CONFIG.baseUrl.replace(/\/+$/, "") + CONFIG.chatEndpoint;
    var resp = null, lastErr = null;
    for (var attempt = 0; attempt < 2 && !resp; attempt++) {
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ message: text, visitorId: visitorId() })
        });
      } catch (e) {
        lastErr = e; // 瞬时网络/CORS 抖动，重试一次
        await sleep(800);
      }
    }
    if (!resp) throw lastErr || new Error("网络请求失败");

    var data = null;
    try { data = await resp.json(); } catch (e) { /* 非 JSON 响应 */ }

    if (!resp.ok) {
      var msg = "HTTP " + resp.status;
      if (data && data.error) msg += ": " + data.error;
      throw new Error(msg);
    }
    if (!data) throw new Error("网关返回了无法解析的响应");

    if (CONFIG.replyMode === "poll") {
      return await pollReply(data.id);
    }
    if (typeof data.reply === "string") return { reply: data.reply, blocks: data.blocks || [] };
    if (data.reply) return { reply: JSON.stringify(data.reply), blocks: [] };
    if (data.error) throw new Error(data.error);
    return { reply: JSON.stringify(data), blocks: [] };
  }

  async function pollReply(id) {
    if (!id) throw new Error("网关未返回任务 id");
    var url = CONFIG.baseUrl.replace(/\/+$/, "") + (CONFIG.replyEndpoint || CONFIG.chatEndpoint);
    var deadline = Date.now() + CONFIG.pollTimeoutMs;
    var lastErr = null;
    while (Date.now() < deadline) {
      await sleep(CONFIG.pollIntervalMs);
      try {
        // 轮询用 POST 携带 id：ngrok 对浏览器 GET 会弹访问警告页（无 CORS 头），POST 不受影响
        var resp = await fetch(url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ id: id })
        });
        if (!resp.ok) { lastErr = new Error("HTTP " + resp.status); continue; }
        var data = await resp.json().catch(function () { return {}; });
        if (typeof data.reply === "string") return { reply: data.reply, blocks: data.blocks || [] };
        if (data.status === "done" && data.result) return { reply: data.result, blocks: [] };
        lastErr = null; // 一次成功的轮询清除之前的瞬时错误
      } catch (e) {
        // 瞬时网络/CORS 抖动（如网关边缘偶发错误页）：继续轮询，不中断整个对话
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    throw new Error("等待回复超时，请重试。");
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- 演示模式（网关未实现时的本地模拟回复） ---------- */
  function mockReply(text) {
    var t = text.toLowerCase();
    if (/红色沙漠|多少钱|价格/.test(t)) {
      return "🎮 红色沙漠 价格信息\n\n💰 当前各平台售价：\n🔸 Steam：¥268\n🔸 Epic：¥268\n🔸 XSX|S：¥331.7\n🔸 PS5：¥492.3\n\n📊 游戏信息：\n⭐ 玩家评分：6.09（161条评论）\n🎯 媒体评分：二柄/Steam 7.9 | IGN 6 | GameSpot 7 | IGN日本 8\n\n⚠️ 目前没有折扣，都是原价\n\n📌 说实话评分有点低，口碑比较两极分化。如果你喜欢开放世界动作游戏，可以等等看后续更新和打折。（演示内容）";
    }
    if (/二郎神|黑神话|杨戬|攻略|怎么打/.test(t)) {
      return "二郎神杨戬是黑神话悟空的隐藏BOSS，难度不低，给你整理一份打法攻略👇\n\n📌 前置条件（解锁杨戬）\n▪️ 解锁四张隐藏地图：旧观音禅院、斯哈里国、紫云山、碧水洞\n▪️ 分别击败金池长老、蝜蝂、晦月魔君、避水金睛兽\n▪️ 在瓜田与翠笠武师对战并获胜\n▪️ 全部完成后回浮屠塔触发小弥勒剧情\n\n⚔️ 核心思路：破盾优先，芭蕉扇是神器，多用翻滚躲投技，别贪刀\n🎮 打完杨戬：解锁隐藏结局“杨戬无金箍形态”，奖励石猿变身和杨戬武器💪\n\n（演示内容，接上真实网关后会有完整分阶段攻略）";
    }
    if (/折扣|降价|steam|优惠/.test(t)) {
      return "📉 目前正在打折的游戏 TOP3：\n① 艾尔登法环 ¥398 → ¥199\n② 双人成行 ¥198 → ¥49\n③ 星露谷物语 ¥48 → ¥24\n\n（演示内容，接入真实网关后会返回实时折扣数据）";
    }
    if (/推荐|好玩|适合/.test(t)) {
      return "🎮 给你推荐这几款：\n· 双人成行（双人合作天花板）\n· 艾尔登法环（魂系开放世界）\n· 黑神话：悟空（国产动作大作）\n\n（演示内容）";
    }
    return "收到：「" + text + "」。\n（演示模式）真实网关尚未接入，接好后这里会返回 Game Agent 的实际回复。可以试试问我：红色沙漠现在多少钱 / 黑神话 二郎神怎么打。";
  }

  /* ---------- 交互 ---------- */
  function setBusy(busy) {
    sendBtn.disabled = busy;
    inputEl.disabled = busy;
    sendBtn.textContent = busy ? "…" : "发送";
  }

  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + "px";
  }

  function onSend() {
    var text = inputEl.value.trim();
    if (!text || sendBtn.disabled) return;
    if (text.length > CONFIG.maxMessageChars) {
      appendSystem("消息超过 " + CONFIG.maxMessageChars + " 字符，请精简后重试。", true);
      return;
    }

    appendMsg("user", text);
    inputEl.value = "";
    autoGrow();
    setBusy(true);
    statusEl.textContent = "· 思考中";

    var typing = showTyping();
    sendMessage(text)
      .then(function (res) {
        typing.remove();
        var blocks = res.blocks || [];
        var firstCard = null;
        for (var bi = 0; bi < blocks.length; bi++) {
          if (blocks[bi] && blocks[bi].type === "game_card") { firstCard = blocks[bi]; break; }
        }
        // 海报请求：先生成海报图，再打字发文字（卡片信息已含在海报里，不再重复出卡）
        if (/海报|宣传图|poster/i.test(text) && firstCard) {
          showInlinePoster(firstCard, function () {
            typewriterAppend(res.reply);
          });
          statusEl.textContent = "· 在线";
          return;
        }
        var hasCard = firstCard !== null;
        // 默认：有游戏卡片时【卡片先出、文字后打】（卡片承载结构化信息，文字做补充）
        if (hasCard) {
          renderBlocks(blocks);
          setTimeout(function () { typewriterAppend(res.reply); }, 60);
        } else {
          typewriterAppend(res.reply, function () {
            renderBlocks(blocks);
          });
        }
        statusEl.textContent = "· 在线";
      })
      .catch(function (err) {
        typing.remove();
        appendSystem("对话失败：" + err.message + "（如果网关有限流，请稍后再试）", true);
        statusEl.textContent = "· 连接异常";
      })
      .finally(function () {
        setBusy(false);
        inputEl.focus();
      });
  }

  render();

  /* 跟随主题深色模式：监听主题的 #dark-theme <link> 是否被禁用 */
  (function watchTheme() {
    var themeLink = document.getElementById("dark-theme");
    function apply() {
      var dark = themeLink
        ? themeLink.disabled !== true
        : !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      el.classList.toggle("gac-dark", dark);
    }
    apply();
    if (themeLink) {
      new MutationObserver(apply).observe(themeLink, { attributes: true, attributeFilter: ["disabled"] });
    }
  })();

  sendBtn.addEventListener("click", onSend);
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  inputEl.addEventListener("input", autoGrow);
})();