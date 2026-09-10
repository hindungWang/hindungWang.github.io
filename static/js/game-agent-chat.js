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
  /* 价格显示统一走这里：最多两位小数、去掉多余 0，
     避免后端浮点值被渲染成 ¥195.89999999999998 */
  function fmtPrice(v) {
    var n = typeof v === "number" ? v : parseFloat(v);
    if (!isFinite(n)) return String(v == null ? "" : v);
    return String(Math.round(n * 100) / 100);
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
    // 封面：窄横幅 + 折扣角标 + 剩余时间角标（都压在图上，不占正文高度）
    if (cover) {
      h += '<div class="gac-card-cover"><img src="' + cover + '" alt="' + escapeHtml(b.name || "") + '" loading="lazy" referrerpolicy="no-referrer">';
      if (offPct) h += '<div class="gac-card-off">' + offPct + "</div>";
      if (b.remaining) h += '<div class="gac-card-left">⏳ ' + escapeHtml(String(b.remaining)) + "</div>";
      h += "</div>";
    }
    h += '<div class="gac-card-body">';
    // 标题行：左标题、右价格（价格是视觉主角）
    h += '<div class="gac-card-head"><div class="gac-card-titles">';
    h += '<div class="gac-card-name">' + escapeHtml(b.name || "") + "</div>";
    if (b.en_name) h += '<div class="gac-card-en">' + escapeHtml(b.en_name) + "</div>";
    h += "</div>";
    if (b.price > 0) {
      h += '<div class="gac-card-prices">';
      if (b.origin_price > 0) h += '<span class="gac-card-old">¥' + escapeHtml(fmtPrice(b.origin_price)) + "</span>";
      h += '<span class="gac-card-now">¥' + escapeHtml(fmtPrice(b.price)) + "</span>";
      h += "</div>";
    }
    h += "</div>";
    // 元信息 chips（无封面时剩余时间落在这里）
    var chips = "";
    if (b.rating) chips += '<span class="gac-card-chip">⭐ ' + escapeHtml(String(b.rating)) + "</span>";
    if (b.platform) chips += '<span class="gac-card-chip">' + escapeHtml(String(b.platform)) + "</span>";
    if (b.follow) chips += '<span class="gac-card-chip">👥 ' + escapeHtml(String(b.follow)) + "</span>";
    if (!cover && b.remaining) chips += '<span class="gac-card-chip">⏳ ' + escapeHtml(String(b.remaining)) + "</span>";
    if (chips) h += '<div class="gac-card-chips">' + chips + "</div>";
    // 特性标签（中文/Steam Deck/家庭共享等）：最多 4 个，其余折叠为 +N
    if (Array.isArray(b.features) && b.features.length) {
      var fmax = Math.min(b.features.length, 4);
      h += '<div class="gac-card-feats">';
      for (var fi = 0; fi < fmax; fi++) {
        h += '<span class="gac-feat">' + escapeHtml(String(b.features[fi])) + "</span>";
      }
      if (b.features.length > fmax) h += '<span class="gac-feat gac-feat-more">+' + (b.features.length - fmax) + "</span>";
      h += "</div>";
    }
    // 史低提示
    if (b.lowest_price > 0) {
      h += '<div class="gac-card-lowest">史低 ¥' + escapeHtml(fmtPrice(b.lowest_price)) +
        (b.lowest_date ? ' <span class="gac-lowest-date">· ' + escapeHtml(String(b.lowest_date)) + "</span>" : "") + "</div>";
    }
    // 各平台价格：全平台两列紧凑网格，最低价平台高亮（网格省掉一半高度）
    var plats = [];
    if (Array.isArray(b.prices)) {
      for (var pk = 0; pk < b.prices.length; pk++) {
        if (b.prices[pk] && b.prices[pk].name) plats.push(b.prices[pk]);
      }
    }
    if (plats.length > 0) {
      var minP = Infinity;
      for (var mi = 0; mi < plats.length; mi++) {
        var mp = parseFloat(plats[mi].price);
        if (isFinite(mp) && mp > 0 && mp < minP) minP = mp;
      }
      h += '<div class="gac-card-plats">';
      for (var pi = 0; pi < plats.length; pi++) {
        var r = plats[pi];
        var best = parseFloat(r.price) === minP && plats.length > 1;
        var hasOff = r.off_pct > 0;
        var hasOld = r.origin_price > 0 && r.origin_price > r.price;
        h += '<div class="gac-plat' + (best ? " gac-plat-best" : "") + '">' +
          '<span class="gac-plat-name">' + escapeHtml(String(r.name)) +
          (best ? '<span class="gac-plat-badge">最低</span>' : "") + "</span>" +
          '<span class="gac-plat-price">' +
          (hasOld && !hasOff ? '<span class="gac-plat-old">¥' + escapeHtml(fmtPrice(r.origin_price)) + "</span>" : "") +
          '<span class="gac-plat-now">¥' + escapeHtml(fmtPrice(r.price)) + "</span>" +
          (hasOff ? '<span class="gac-plat-off">-' + escapeHtml(String(r.off_pct)) + "%</span>" : "") +
          "</span></div>";
      }
      h += "</div>";
    }
    // 操作按钮：并排紧凑一行
    h += '<div class="gac-card-actions">';
    if (video) {
      h += '<a class="gac-card-btn" href="' + video + '" target="_blank" rel="noopener noreferrer">🎬 预告</a>';
    }
    h += '<button type="button" class="gac-card-btn gac-card-poster-btn">🖼️ 生成海报</button>';
    h += "</div></div></div>";
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
          img.referrerPolicy = "no-referrer"; // 绕过 erbingeditor 等 CDN 的 Referer 防盗链(403)
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
  /* ===================== 海报引擎 v2：量高式流式排版 =====================
   * v1 用硬编码 y 坐标摆模块，长标题/多平台时会互相压盖并把页脚顶出画布（已实测）。
   * v2 约定：每个模块收到自己的“顶部 y”，返回自己占用的“高度”；
   *   - 版式 F0 负责按游标顺排，并把富余空间匀给模块间距；
   *   - 平台面板 / 页脚底部锚定，空间不足时按 英文名 → 特性 → 史低 → 面板条目 降级；
   * 因此任意数据量（超长标题 / 十几平台 / 无封面）都不会越界或压盖。
   */
  var POSTER_MARGIN = 48;
  var POSTER_FOOTER_LINE = 884; // 页脚线（720x960 画布）
  var POSTER_TAG_W = 124;       // 价签包围盒宽度（tipX=-70 → bodyR=54）

  // -- 封面底部融合带
  function mCoverFade(ctx, W, th, y, h) {
    var hh = h || 118;
    var f = ctx.createLinearGradient(0, y - hh, 0, y);
    f.addColorStop(0.00, "rgba(" + th.fade + ",0)");
    f.addColorStop(0.55, "rgba(" + th.fade + ",0.85)");
    f.addColorStop(1.00, "rgba(" + th.fade + ",1)");
    ctx.fillStyle = f; ctx.fillRect(0, y - hh, W, hh);
  }
  // -- 封面角标（如“⏳ 剩余3天”）：压在封面左上角，不占正文高度
  function mCoverBadge(ctx, th, text) {
    if (!text) return;
    ctx.font = "800 22px 'PingFang SC',sans-serif";
    var w = ctx.measureText(text).width + 34;
    ctx.fillStyle = "rgba(0,0,0,0.46)";
    roundRectPath(ctx, 24, 24, w, 48, 24); ctx.fill();
    ctx.fillStyle = "#ffd9a0";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(text, 41, 49);
    ctx.textBaseline = "alphabetic";
  }
  // -- 标题：字号自适应 54→30，最多 2 行
  function mTitle(ctx, W, top, th, name, align, maxW, dry) {
    if (!name) return 0;
    var size = 54, ls = [];
    for (; size >= 30; size -= 3) {
      ctx.font = "800 " + size + "px 'PingFang SC',sans-serif";
      ls = wrapText(ctx, name, maxW);
      var mx = 0;
      for (var i = 0; i < ls.length; i++) mx = Math.max(mx, ctx.measureText(ls[i]).width);
      if (ls.length <= 2 && mx <= maxW) break;
    }
    if (size < 30) size = 30;
    ctx.font = "800 " + size + "px 'PingFang SC',sans-serif";
    ls = wrapText(ctx, name, maxW).slice(0, 2);
    var lh = Math.round(size * 1.16);
    if (!dry) {
      ctx.textAlign = align === "left" ? "left" : "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = th.title;
      var x = align === "left" ? POSTER_MARGIN : W / 2;
      for (var ti = 0; ti < ls.length; ti++) ctx.fillText(ls[ti], x, top + Math.round(size * 0.84) + ti * lh);
    }
    return (ls.length - 1) * lh + size;
  }
  // -- 英文名
  function mEn(ctx, W, top, th, en, align, maxW, dry) {
    if (!en) return 0;
    ctx.font = "22px Georgia,serif";
    var t = String(en);
    if (ctx.measureText(t).width > maxW) {
      while (ctx.measureText(t + "…").width > maxW && Array.from(t).length > 1) t = Array.from(t).slice(0, -1).join("");
      t += "…";
    }
    if (!dry) {
      ctx.textAlign = align === "left" ? "left" : "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = th.en;
      ctx.fillText(t, align === "left" ? POSTER_MARGIN : W / 2, top + 22);
    }
    return 28;
  }
  // -- 折扣价签：尖端 + 穿绳环 + 大圆角，以 (cx, cy) 为几何中心，倾斜 16°
  function mTag(ctx, cx, cy, th, off) {
    var TH = 76, TR = 18, bodyL = -34, bodyR = 54, tipX = -70;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(16 * Math.PI / 180);
    var g = ctx.createLinearGradient(0, -TH / 2, 0, TH / 2);
    g.addColorStop(0, th.tagTop); g.addColorStop(1, th.tagBot);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(bodyL, -TH / 2);
    ctx.lineTo(bodyR - TR, -TH / 2); ctx.arcTo(bodyR, -TH / 2, bodyR, -TH / 2 + TR, TR);
    ctx.lineTo(bodyR, TH / 2 - TR); ctx.arcTo(bodyR, TH / 2, bodyR - TR, TH / 2, TR);
    ctx.lineTo(bodyL, TH / 2);
    ctx.quadraticCurveTo(tipX, TH / 2 * 0.32, tipX + 4, 0);
    ctx.quadraticCurveTo(tipX, -TH / 2 * 0.32, bodyL, -TH / 2);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(-44, -4, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "900 32px Arial,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(off, (bodyL + bodyR) / 2 + 10, 1);
    ctx.restore();
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  }
  // -- 价格块：原价划线独占一行（v1 里它与大字压盖 9px）+ 大字现价 + 右侧价签（整体居中）
  function mPrice(ctx, W, top, th, origin, price, off, align, dry) {
    var M = POSTER_MARGIN, y = top;
    var anchor = align === "left" ? M : W / 2;
    if (origin > 0 && price > 0 && off) {
      var ot = "¥" + fmtPrice(origin);
      ctx.font = "26px 'PingFang SC',sans-serif";
      if (!dry) {
        ctx.textAlign = align === "left" ? "left" : "center";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = th.origin;
        ctx.fillText(ot, anchor, y + 26);
        var w0 = ctx.measureText(ot).width;
        var l0 = align === "left" ? anchor : anchor - w0 / 2;
        ctx.strokeStyle = th.origin; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(l0, y + 16); ctx.lineTo(l0 + w0, y + 16); ctx.stroke();
      }
      y += 40;
    }
    if (!(price > 0)) return y - top;
    var pTxt = "¥" + fmtPrice(price);
    var pFs = pTxt.length > 7 ? 68 : 92;
    ctx.font = "900 " + pFs + "px Arial,'PingFang SC',sans-serif";
    var pw = ctx.measureText(pTxt).width;
    var comboW = pw + (off ? 20 + POSTER_TAG_W : 0);
    var left = align === "left" ? M : (W - comboW) / 2;
    var baseY = y + Math.round(pFs * 0.78);
    if (!dry) {
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = th.price;
      ctx.font = "900 " + pFs + "px Arial,'PingFang SC',sans-serif";
      ctx.fillText(pTxt, left, baseY);
      if (off) mTag(ctx, left + pw + 20 + POSTER_TAG_W / 2, baseY - Math.round(pFs * 0.30), th, off);
    }
    return y - top + Math.round(pFs * 0.98);
  }
  // -- 评分 / 剩余时间 chips
  function mChips(ctx, W, top, th, rating, remaining, align, dry) {
    var chips = [];
    if (rating) chips.push({ text: "★ " + rating, color: th.price });
    if (remaining) chips.push({ text: String(remaining), color: th.chipRemaining || "#a8c7e8" });
    if (!chips.length) return 0;
    ctx.font = "800 24px 'PingFang SC',sans-serif";
    var cws = [], total = 0, i;
    for (i = 0; i < chips.length; i++) { cws.push(ctx.measureText(chips[i].text).width + 36); total += cws[i] + 10; }
    total -= 10;
    var x0 = align === "left" ? POSTER_MARGIN : (W - total) / 2;
    if (!dry) {
      var h = 44;
      for (var j = 0; j < chips.length; j++) {
        ctx.fillStyle = th.chipBg; roundRectPath(ctx, x0, top, cws[j], h, h / 2); ctx.fill();
        ctx.strokeStyle = th.chipBorder; ctx.lineWidth = 1; roundRectPath(ctx, x0, top, cws[j], h, h / 2); ctx.stroke();
        ctx.fillStyle = chips[j].color;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(chips[j].text, x0 + cws[j] / 2, top + h / 2 + 1);
        x0 += cws[j] + 10;
      }
      ctx.textBaseline = "alphabetic";
    }
    return 44;
  }
  // -- 特性行（中文 · Steam Deck · 家庭共享 …）
  function mFeatures(ctx, W, top, th, feats, align, dry) {
    if (!feats || !feats.length) return 0;
    var txt = feats.slice(0, 5).join(" · ");
    var maxW = W - POSTER_MARGIN * 2;
    ctx.font = "600 20px 'PingFang SC',sans-serif";
    if (ctx.measureText(txt).width > maxW) {
      while (ctx.measureText(txt + "…").width > maxW && Array.from(txt).length > 1) txt = Array.from(txt).slice(0, -1).join("");
      txt += "…";
    }
    if (!dry) {
      ctx.textAlign = align === "left" ? "left" : "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = th.chipRemaining || "#a8c7e8";
      ctx.fillText(txt, align === "left" ? POSTER_MARGIN : W / 2, top + 20);
    }
    return 26;
  }
  // -- 史低行（历史最低价与日期；与面板里的“最低现价”是两个口径）
  function mLowest(ctx, W, top, th, price, date, dry) {
    if (!(price > 0)) return 0;
    if (!dry) {
      ctx.font = "800 22px 'PingFang SC',sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = th.price;
      ctx.fillText("史低 ¥" + fmtPrice(price) + (date ? "  ·  " + date : ""), W / 2, top + 22);
    }
    return 28;
  }
  // -- 价格组宽度（现价必显；折扣与原价二选一）
  function platGroupWidth(ctx, s, fs, withOff, withOld) {
    ctx.font = "800 " + fs + "px Arial,'PingFang SC',sans-serif";
    var w = ctx.measureText("¥" + fmtPrice(s.price)).width;
    if (withOff && s.offP > 0) {
      ctx.font = "800 15px Arial,sans-serif";
      w += ctx.measureText("-" + s.offP + "%").width + 8;
    } else if (withOld && s.originP > 0 && s.originP > s.price) {
      ctx.font = "15px 'PingFang SC',sans-serif";
      w += ctx.measureText("¥" + fmtPrice(s.originP)).width + 8;
    }
    return w;
  }
  // -- 单元格自适应：保证“平台名 + 价格组”永不越出单元格
  //    降级顺序：去“最低”角标 → 字号 22→20→18 → 去折扣 → 去原价
  function platCellFit(ctx, s, cellW) {
    var badgeT = s.best ? "最低" : "";
    var fsList = [22, 20, 18];
    for (var useBadge = 1; useBadge >= 0; useBadge--) {
      for (var fi = 0; fi < fsList.length; fi++) {
        var fs = fsList[fi];
        var g = platGroupWidth(ctx, s, fs, true, true);
        var bw = 0;
        if (useBadge && badgeT) {
          ctx.font = "800 15px 'PingFang SC',sans-serif";
          bw = ctx.measureText(badgeT).width + 7;
        }
        var nameMax = cellW - g - 14 - bw;
        if (nameMax >= (useBadge ? 46 : 54)) {
          return { fs: fs, off: true, old: true, badge: useBadge ? badgeT : "", groupW: g, nameMax: nameMax };
        }
      }
    }
    var g2 = platGroupWidth(ctx, s, 18, false, true); // 去掉折扣，保留原价划线
    if (cellW - g2 - 14 >= 46) return { fs: 18, off: false, old: true, badge: "", groupW: g2, nameMax: cellW - g2 - 14 };
    var g3 = platGroupWidth(ctx, s, 18, false, false); // 只留现价
    return { fs: 18, off: false, old: false, badge: "", groupW: g3, nameMax: Math.max(30, cellW - g3 - 14) };
  }
  // -- 平台面板：全平台价，底部锚定；放不下先减条目，再缩行数，末尾用“还有 N 个平台”占位
  function mPanel(ctx, W, top, maxBottom, th, plats, cols, dry) {
    var items = [], i;
    for (i = 0; i < plats.length; i++) {
      var it = plats[i];
      if (!it || !it.name) continue;
      items.push({ name: String(it.name), originP: it.origin_price || 0, price: it.price || 0, offP: it.off_pct || 0 });
    }
    if (!items.length) return 0;
    var minP = Infinity;
    for (i = 0; i < items.length; i++) if (items[i].price > 0 && items[i].price < minP) minP = items[i].price;
    for (i = 0; i < items.length; i++) items[i].best = items.length > 1 && isFinite(minP) && items[i].price === minP;

    var ROW = 38, PADV = 16, PADH = 18, GAPX = 22;
    var panelW = Math.min(W - POSTER_MARGIN * 2, 640);
    var panelX = (W - panelW) / 2;
    var maxRows = Math.max(1, Math.floor((maxBottom - top - PADV * 2) / ROW));
    var slots = Math.min(items.length, maxRows * cols);
    var truncated = items.length > slots;
    var shownCount = truncated ? Math.max(1, slots - 1) : slots;
    var shown = items.slice(0, shownCount);
    var rest = items.length - shownCount;
    var rows = Math.max(1, Math.ceil((shownCount + (rest > 0 ? 1 : 0)) / cols));
    var panelH = rows * ROW + PADV * 2;
    while (top + panelH > maxBottom && rows > 1) {   // 兜底：绝不越过 maxBottom
      rows -= 1;
      shownCount = Math.min(items.length, rows * cols - 1);
      if (shownCount < 1) { shownCount = 1; }
      shown = items.slice(0, shownCount);
      rest = items.length - shownCount;
      rows = Math.max(1, Math.ceil((shownCount + (rest > 0 ? 1 : 0)) / cols));
      panelH = rows * ROW + PADV * 2;
    }
    var cellW = (panelW - PADH * 2 - GAPX * (cols - 1)) / cols;

    if (!dry) {
      ctx.fillStyle = th.panelBg;
      roundRectPath(ctx, panelX, top, panelW, panelH, 18); ctx.fill();
      for (var si = 0; si < shown.length; si++) {
        var s = shown[si];
        var cxc = panelX + PADH + (si % cols) * (cellW + GAPX);
        var cyc = top + PADV + Math.floor(si / cols) * ROW + ROW / 2;
        var rightEdge = cxc + cellW;
        var fit = platCellFit(ctx, s, cellW);
        var nowT = "¥" + fmtPrice(s.price);
        var offT = (fit.off && s.offP > 0) ? "-" + s.offP + "%" : "";
        var oldT = (fit.old && s.originP > 0 && s.originP > s.price && !offT) ? "¥" + fmtPrice(s.originP) : "";
        // 左：平台名（超长省略，字号随单元格自适应）
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.font = "800 " + fit.fs + "px 'PingFang SC',sans-serif";
        var nm = s.name;
        if (ctx.measureText(nm).width > fit.nameMax) {
          // 省略号本身也占宽度，必须先把它算进去，否则截断后仍会压到价格上
          while (Array.from(nm).length > 1 && ctx.measureText(nm + "…").width > fit.nameMax) {
            nm = Array.from(nm).slice(0, -1).join("");
          }
          nm += "…";
        }
        var nmW = ctx.measureText(nm).width;
        ctx.fillStyle = s.best ? th.price : th.platName;
        ctx.fillText(nm, cxc, cyc);
        if (fit.badge) {
          ctx.font = "800 15px 'PingFang SC',sans-serif";
          ctx.fillStyle = th.platSd;
          ctx.fillText(fit.badge, cxc + nmW + 7, cyc + 1);
        }
        // 右：价格组（整体右对齐）
        ctx.textAlign = "right";
        ctx.font = "800 " + fit.fs + "px Arial,'PingFang SC',sans-serif";
        ctx.fillStyle = th.price;
        ctx.fillText(nowT, rightEdge, cyc);
        var rx = rightEdge - ctx.measureText(nowT).width - 10;
        if (oldT) {
          ctx.font = "15px 'PingFang SC',sans-serif"; ctx.fillStyle = th.platOld;
          var oldW = ctx.measureText(oldT).width;
          ctx.fillText(oldT, rx, cyc);
          ctx.strokeStyle = th.platOld; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(rx - oldW, cyc + 1); ctx.lineTo(rx, cyc + 1); ctx.stroke();
          rx -= oldW + 8;
        }
        if (offT) {
          ctx.font = "800 15px Arial,sans-serif"; ctx.fillStyle = th.platSd;
          ctx.fillText(offT, rx, cyc);
        }
      }
      if (rest > 0) {
        var nxc = panelX + PADH + (shown.length % cols) * (cellW + GAPX);
        var nyc = top + PADV + Math.floor(shown.length / cols) * ROW + ROW / 2;
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.font = "600 20px 'PingFang SC',sans-serif";
        ctx.fillStyle = th.footer;
        ctx.fillText("还有 " + rest + " 个平台…", nxc, nyc);
      }
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    }
    return panelH;
  }
  // -- 页脚（固定在画布底部，与面板互不干扰）
  function mFooter(ctx, W, th) {
    var line = POSTER_FOOTER_LINE;
    ctx.strokeStyle = th.footerLine; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(POSTER_MARGIN, line); ctx.lineTo(W - POSTER_MARGIN, line); ctx.stroke();
    var d = new Date();
    var ds = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    ctx.font = "20px 'PingFang SC',sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = th.footer;
    ctx.fillText("由 Stray 查价生成 · 数据实时查询 · " + ds, W / 2, line + 40);
  }
  // ===== 版式 pool =====
  // F0 经典竖版 720x960：封面横幅 → 标题/英文名 → 价格主视觉 → chips → 特性/史低 →（底部锚定）平台面板 → 页脚
  var POSTER_FORMS = [
    { w: 720, h: 960, render: function (ctx, D) {
      var W = D.w, th = D.th;
      var CW = W - POSTER_MARGIN * 2;
      var COVER_H = 300;
      if (D.coverImg) {
        mCover(ctx, D.coverImg, 0, 0, W, COVER_H);
        mCoverFade(ctx, W, th, COVER_H + 54, 118);
      }
      var startY = D.coverImg ? COVER_H - 8 : 96;
      // 有封面时“剩余时间”压在封面上（省一行）；无封面时落到 chips 行
      var coverBadge = (D.coverImg && D.remaining) ? "⏳ " + D.remaining : "";
      var chipRemaining = D.coverImg ? "" : D.remaining;

      var plats = Array.isArray(D.plats) ? D.plats : [];
      var cols = plats.length >= 5 ? 3 : 2;   // 平台多时走三列，一眼看全

      // ---- 第一遍：只量不画 ----
      var mods = [
        { key: "title", gap: 0, h: mTitle(ctx, W, 0, th, D.name, "center", CW, true),
          draw: function (t) { mTitle(ctx, W, t, th, D.name, "center", CW, false); } },
        { key: "en", gap: 14, h: mEn(ctx, W, 0, th, D.en, "center", CW, true),
          draw: function (t) { mEn(ctx, W, t, th, D.en, "center", CW, false); } },
        { key: "price", gap: 24, h: mPrice(ctx, W, 0, th, D.origin, D.price, D.off, "center", true),
          draw: function (t) { mPrice(ctx, W, t, th, D.origin, D.price, D.off, "center", false); } },
        { key: "chips", gap: 22, h: mChips(ctx, W, 0, th, D.rating, chipRemaining, "center", true),
          draw: function (t) { mChips(ctx, W, t, th, D.rating, chipRemaining, "center", false); } },
        { key: "feats", gap: 16, h: mFeatures(ctx, W, 0, th, D.features, "center", true),
          draw: function (t) { mFeatures(ctx, W, t, th, D.features, "center", false); } },
        { key: "lowest", gap: 16, h: mLowest(ctx, W, 0, th, D.lowestPrice, D.lowestDate, "center", true),
          draw: function (t) { mLowest(ctx, W, t, th, D.lowestPrice, D.lowestDate, "center", false); } }
      ].filter(function (m) { return m.h > 0; });

      var needPanel = mPanel(ctx, W, 0, 1e4, th, plats, cols, true);
      var bottomLimit = POSTER_FOOTER_LINE - 20;

      // ---- 降级：英文名 → 特性 → 史低（面板内部还会自己减条目/缩行）----
      var dropped = {};
      var dropOrder = ["en", "feats", "lowest"];
      function contentBottom() {
        var y = startY;
        for (var i = 0; i < mods.length; i++) {
          if (dropped[mods[i].key]) continue;
          y += mods[i].gap + mods[i].h;
        }
        return y;
      }
      var cb = contentBottom();
      var panelTop = Math.max(cb + 26, bottomLimit - needPanel);
      for (var di = 0; di < dropOrder.length && panelTop + needPanel > bottomLimit; di++) {
        dropped[dropOrder[di]] = true;
        cb = contentBottom();
        panelTop = Math.max(cb + 26, bottomLimit - needPanel);
      }

      // ---- 第二遍：绘制（富余留白匀给顶部与模块间距，最多各 +18/+16px，避免下半部空一大块）----
      var visible = mods.filter(function (m) { return !dropped[m.key]; });
      var slack = Math.max(0, panelTop - 22 - cb);
      var padTop = Math.round(Math.min(40, slack * 0.35));
      var extra = Math.max(0, Math.min(18, Math.round((slack - padTop) / Math.max(1, visible.length))));
      var y = startY + padTop;
      for (var vi = 0; vi < visible.length; vi++) {
        y += visible[vi].gap + (vi === 0 ? 0 : extra);
        visible[vi].draw(y);
        y += visible[vi].h;
      }
      if (plats.length) {
        mPanel(ctx, W, panelTop, bottomLimit, th, plats, cols, false);
      } else {
        // 没有任何平台价（工具没取到数据）时给个交代，避免出一张只有标题的空海报
        ctx.font = "600 26px 'PingFang SC',sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
        ctx.fillStyle = th.footer;
        ctx.fillText("暂无实时价格数据 · 稍后重试", W / 2, panelTop + 30);
      }
      if (coverBadge) mCoverBadge(ctx, th, coverBadge);
      mFooter(ctx, W, th);
    } }
  ];
  /* ---- 主题：优先从封面取主色调，取不到再回落到预设池 ---- */
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }
  function hslHex(h, s, l) {
    var c = hslToRgb(h, s, l);
    return "#" + c.map(function (v) {
      var n = Math.max(0, Math.min(255, Math.round(v)));
      return (n < 16 ? "0" : "") + n.toString(16);
    }).join("");
  }
  function hslTriple(h, s, l) {
    var c = hslToRgb(h, s, l);
    return Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]);
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    h = (h + 360) % 360;
    var l = (mx + mn) / 2;
    var s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    return [h, s, l];
  }
  // 采样封面主色调 → 生成同色系暗调主题（跨域无 CORS 时 getImageData 会抛错，交给预设池）
  function themeFromImage(img) {
    try {
      if (!img || !img.width || !img.height || !document || !document.createElement) return null;
      var size = 24;
      var c = document.createElement("canvas");
      c.width = size; c.height = size;
      var cx = c.getContext("2d");
      cx.drawImage(img, 0, 0, size, size);
      var d = cx.getImageData(0, 0, size, size).data;
      var r = 0, g = 0, b = 0, n = 0;
      var rowCount = Math.max(1, Math.round(size * 0.6)); // 只取上部主视觉，避开底部渐隐
      for (var yy = 0; yy < rowCount; yy++) {
        for (var xx = 0; xx < size; xx++) {
          var o = (yy * size + xx) * 4;
          r += d[o]; g += d[o + 1]; b += d[o + 2]; n++;
        }
      }
      if (!n) return null;
      var hsl = rgbToHsl(r / n, g / n, b / n);
      if (hsl[1] < 0.14) return null; // 近灰/黑白封面 → 用预设主题
      var h = hsl[0], s = Math.min(0.6, Math.max(0.34, hsl[1] * 1.15));
      return {
        bg: [hslHex(h, s, 0.16), hslHex(h, s, 0.10), hslHex(h, s * 0.9, 0.05)],
        fade: hslTriple(h, s, 0.09),
        title: "#ffffff", en: hslHex(h, 0.35, 0.74), origin: "#b8bdc7", price: "#ffd23f",
        tagTop: "#ff6b4a", tagBot: "#d92626", chipRemaining: hslHex(h, 0.45, 0.78),
        chipBg: "rgba(255,255,255,0.07)", chipBorder: "rgba(255,255,255,0.14)",
        panelBg: "rgba(0,0,0,0.26)", platName: "#e6eaf2", platOld: "#9199a8",
        platSd: "#ff5252", footer: hslHex(h, 0.18, 0.62), footerLine: hslHex(h, 0.28, 0.26)
      };
    } catch (e) { return null; }
  }
  function pickTheme(img) {
    var t = themeFromImage(img);
    if (t) return t;
    return POSTER_THEMES[(Math.random() * POSTER_THEMES.length) | 0];
  }
  /* 渲染海报：theme 传同一个值可保证「预览 / 下载 / 复制」三处配色一致；
     scale=2 用于导出 1440x1920 高清图（逻辑坐标不变，ctx 整体放大） */
  function drawPoster(canvas, b, coverImg, theme, scale) {
    var th = theme || pickTheme(coverImg);
    var fm = POSTER_FORMS[0];
    var W = fm.w, H = fm.h;
    var s = scale > 1 ? scale : 1;
    canvas.width = W * s; canvas.height = H * s;
    var ctx = canvas.getContext("2d");
    if (s !== 1) ctx.scale(s, s);
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, th.bg[0]); g.addColorStop(0.55, th.bg[1]); g.addColorStop(1, th.bg[2]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 主价格 = 全平台最低现价；原价/折扣随该平台
    var plats = (Array.isArray(b.prices) && b.prices.length) ? b.prices : [];
    var best = null;
    for (var bp = 0; bp < plats.length; bp++) {
      var cand = plats[bp];
      if (!cand || !(cand.price > 0)) continue;
      if (!best || cand.price < best.price) best = cand;
    }
    var D = {
      w: W, h: H, th: th, coverImg: coverImg,
      name: String(b.name || ""), en: b.en_name ? String(b.en_name) : "",
      rating: b.rating, remaining: b.remaining, plats: plats,
      features: Array.isArray(b.features) ? b.features : undefined,
      lowestPrice: b.lowest_price > 0 ? b.lowest_price : undefined,
      lowestDate: b.lowest_date ? String(b.lowest_date) : "",
      origin: best && best.origin_price ? best.origin_price : (b.origin_price || 0),
      price: best && best.price ? best.price : (b.price || 0)
    };
    D.off = "";
    if (D.origin > 0 && D.price > 0 && D.price < D.origin) D.off = "-" + Math.round((1 - D.price / D.origin) * 100) + "%";
    fm.render(ctx, D);
    return th;
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
  /* 封面若走了非 CORS 降级（小黑盒 max-c.com 等 CDN 不返回 Access-Control-Allow-Origin），
     画进 canvas 会把画布污染、导致 toDataURL/toBlob 抛错 —— 此时改用「无封面纯排版版式」，
     宁可少一张封面图，也要保证用户拿到的是能下载/复制的真海报，而不是退回一张原封面。 */
  function posterImageFor(img) {
    return (img && img.__corsOk === false) ? null : img;
  }
  /* 海报渲染：预览用 scale=1，导出用 scale=2（1440x1920 高清）；
     主题由 pickTheme 选一次后沿用，保证预览/下载/复制配色完全一致 */
  function renderPoster(block, img, theme, scale) {
    var canvas = document.createElement("canvas");
    try { drawPoster(canvas, block, img, theme, scale || 1); } catch (e) { /* 保留空画布，按钮仍可用 */ }
    return canvas;
  }
  function exportCanvas(preview, block, img, theme) {
    if (!block || !img) return preview;
    try {
      var hi = renderPoster(block, img, theme, 2);
      return hi.width > preview.width ? hi : preview;
    } catch (e) { return preview; }
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
      var usable = posterImageFor(img);           // 不可导出时置 null → 走无封面版式
      var theme = pickTheme(usable);
      var canvas = renderPoster(block, usable, theme, 1);
      var wrap = document.createElement("div");
      wrap.className = "gac-poster-inline-wrap";
      wrap.innerHTML =
        '<img class="gac-poster-inline" alt="海报" referrerpolicy="no-referrer">' +
        '<div class="gac-poster-inline-actions">' +
          '<button type="button" data-act="save">💾 下载高清 PNG</button>' +
          '<button type="button" data-act="copy">📋 复制图片</button>' +
        "</div>" +
        (usable ? "" : '<div class="gac-poster-note">封面图源不支持跨域，已生成纯排版版海报（可正常下载）</div>');
      var pimg = wrap.querySelector("img");
      try { pimg.src = canvas.toDataURL("image/png"); } catch (e) { pimg.src = (img && img.__src) ? img.__src : safeUrl(block.cover) || ""; }
      bodyEl.appendChild(wrap);
      scrollToBottom();
      wrap.querySelector('[data-act="save"]').addEventListener("click", function () {
        downloadCanvas(exportCanvas(canvas, block, usable, theme));
      });
      wrap.querySelector('[data-act="copy"]').addEventListener("click", function () {
        copyCanvas(exportCanvas(canvas, block, usable, theme));
      });
      if (onDone) setTimeout(onDone, 150);
    });
  }
  function openPoster(block) {
    loadImage(safeUrl(block.cover), block.covers).then(function (img) {
      var usable = posterImageFor(img);
      var theme = pickTheme(usable);
      var overlay = document.createElement("div");
      overlay.className = "gac-poster-modal";
      overlay.innerHTML =
        '<div class="gac-poster-box">' +
          '<canvas class="gac-poster-canvas"></canvas>' +
          '<div class="gac-poster-actions">' +
            '<button type="button" class="gac-poster-act" data-act="save">💾 下载高清 PNG</button>' +
            '<button type="button" class="gac-poster-act" data-act="copy">📋 复制图片</button>' +
            '<button type="button" class="gac-poster-act gac-poster-close">✕ 关闭</button>' +
          "</div>" +
        "</div>";
      document.body.appendChild(overlay);
      var canvas = overlay.querySelector("canvas");
      // 先绑定事件（即使绘制失败按钮也可用），再绘制
      overlay.querySelector(".gac-poster-close").addEventListener("click", function () { overlay.remove(); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });
      overlay.querySelector('[data-act="save"]').addEventListener("click", function () {
        downloadCanvas(exportCanvas(canvas, block, usable, theme));
      });
      overlay.querySelector('[data-act="copy"]').addEventListener("click", function () {
        copyCanvas(exportCanvas(canvas, block, usable, theme));
      });
      try { drawPoster(canvas, block, usable, theme, 1); } catch (e) { /* 保留空画布，操作仍可用 */ }
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