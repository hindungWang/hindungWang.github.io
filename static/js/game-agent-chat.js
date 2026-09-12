/* Stray 聊天窗 —— 纯前端组件
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
    // 封面图代理（网关侧补 CORS 头；小黑盒图床不返回 CORS 头，直连会让海报 canvas 被污染、导不出 PNG）
    imgEndpoint: "/api/v1/game-agent/img",
    // 海报比例："4:5"（1080×1350，朋友圈/小红书更占屏，默认）| "3:4"（720×960）| "auto"（每次随机）
    posterAspect: "4:5",
    // 回复模式：
    //   "sync" — 网关一次请求直接返回 {reply}（默认）
    //   "poll" — 网关先返回 {id}，再用 GET {replyEndpoint}?id=<id> 轮询直到返回 {reply} 或超时
    replyMode: "poll",
    pollIntervalMs: 1500,
    pollTimeoutMs: 180000,  // 3 分钟：游戏查价含多次接口调用+限流退避，p99 实测可达 60s+
    // UI
    botName: "Stray",
    typingText: "Stray 正在思考…",
    placeholder: "输入指令，开始和 Stray 对话…",
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
  /* 大数字简写：62352 → 6.2万（海报/卡片显示用） */
  function fmtCount(n) {
    var v = Number(n) || 0;
    if (v >= 100000000) return (v / 100000000).toFixed(1) + "亿";
    if (v >= 10000) return (v / 10000).toFixed(1) + "万";
    return String(v);
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
    // 图片 / 视频 ![alt](url) 必须在链接之前处理（只允许 http/https，防注入）
    t = t.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, function (_m, alt, url) {
      if (isVideoSrc(url)) {
        // 视频：先给一个播放按钮，点了再创建播放器（避免一上来就加载视频）
        return '<span class="gac-md-video" data-src="' + url + '">' +
          '<button type="button" class="gac-md-video-btn">▶ ' + (alt || "播放视频") + "</button></span>";
      }
      return '<img class="gac-md-img" src="' + url + '" alt="' + alt + '" loading="lazy" referrerpolicy="no-referrer">';
    });
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
        '<div class="gac-avatar">' + esc(String(CONFIG.botName || "S").trim().charAt(0).toUpperCase()) + '</div>' +
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
    appendMsg("agent", "你好，今天想玩什么游戏？" + (mockEnabled() ? "（演示模式）" : ""));
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
      bindMdMedia(div); // 回复里的图片可点开大图、视频可内联播放
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
  /* 折扣截止文案：平台行很窄，把"剩余"去掉只留"13天/12小时" */
  function shortDeadline(t) {
    return String(t || "").replace(/^剩余\s*/, "").trim();
  }

  function safeUrl(u) {
    return /^https?:\/\//i.test(String(u || "")) ? String(u) : "";
  }
  /* 从封面 URL 提取 Steam appid，生成备份图源列表（原图优先，失败依次试无 hash 的跨域名镜像）；
     若后端给了显式 covers 数组，则优先使用它（仍带跨域降级 + 镜像兜底） */
  /* 封面候选 → [{u, cors}] 计划列表。
     顺序很重要：先"直连 + CORS"，再"代理 + CORS"，最后才退到"直连不带 CORS"——
     因为不带 CORS 的图能把画面显示出来，却会污染 canvas 导致海报导不出 PNG。 */
  function coverCandidates(url, extraCovers, inlineData) {
    var direct = [];
    function push(u) {
      var s = safeUrl(u);
      if (!s || direct.indexOf(s) >= 0) return;
      direct.push(s);
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
    var plan = [], seen = {};
    function add(u, cors, clean) {
      var s = clean ? String(u || "") : safeUrl(u);
      if (!s || seen[s + "|" + cors]) return;
      seen[s + "|" + cors] = 1;
      plan.push({ u: s, cors: !!cors, clean: clean === undefined ? !!cors : !!clean });
    }
    // 网关内联的封面（data URL）：同源内容，既不依赖 CDN 的 CORS 头，也不会污染画布
    if (typeof inlineData === "string" && /^data:image\//.test(inlineData)) add(inlineData, false, true);
    for (var i = 0; i < direct.length; i++) add(direct[i], true);
    var proxyBase = imgProxyUrl();
    if (proxyBase) {
      for (var j = 0; j < direct.length; j++) add(proxyBase + encodeURIComponent(direct[j]), true);
    }
    for (var k = 0; k < direct.length; k++) add(direct[k], false);
    return plan;
  }
  /* 网关图片代理地址（配置缺失或未配置网关时返回空串，海报自动降级为无封面版式） */
  function imgProxyUrl() {
    if (!isConfigFilled() || mockEnabled()) return "";
    var base = CONFIG.baseUrl.replace(/\/+$/, "");
    if (!/^https:\/\//.test(base)) return "";
    return base + (CONFIG.imgEndpoint || "/api/v1/game-agent/img") + "?u=";
  }
  function gameCardHtml(b) {
    var cover = safeUrl(b.cover);
    var offPct = "";
    if (b.origin_price > 0 && b.price > 0 && b.price < b.origin_price) {
      offPct = "-" + Math.round((1 - b.price / b.origin_price) * 100) + "%";
    }
    var h = '<div class="gac-card">';
    // 封面：窄横幅 + 折扣角标 + 剩余时间角标（都压在图上，不占正文高度）
    if (cover) {
      h += '<div class="gac-card-cover"><img src="' + cover + '" alt="' + escapeHtml(b.name || "") + '" loading="lazy" referrerpolicy="no-referrer">';
      if (offPct) h += '<div class="gac-card-off">' + offPct + "</div>";
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
      // 折扣截止放在价格正下方（小黑盒只在打折时给这个字段）
      if (b.remaining) h += '<span class="gac-card-deadline">⏳ ' + escapeHtml(shortDeadline(b.remaining)) + "</span>";
      h += "</div>";
    }
    h += "</div>";
    // 元信息 chips（无封面时剩余时间落在这里）
    var chips = "";
    if (b.rating) chips += '<span class="gac-card-chip">⭐ ' + escapeHtml(String(b.rating)) + "</span>";
    if (b.platform) chips += '<span class="gac-card-chip">' + escapeHtml(String(b.platform)) + "</span>";
    if (b.dlc_count > 0) chips += '<span class="gac-card-chip">DLC × ' + escapeHtml(String(b.dlc_count)) + "</span>";
    if (b.good_rate) chips += '<span class="gac-card-chip">好评率 ' + escapeHtml(String(b.good_rate)) + "</span>";
    if (b.follow) chips += '<span class="gac-card-chip">👥 ' + escapeHtml(String(b.follow)) + "</span>";
    if (Array.isArray(b.awards) && b.awards.length) chips += '<span class="gac-card-chip gac-chip-award">🏆 ' + escapeHtml(String(b.awards[0])) + "</span>";
    if (chips) h += '<div class="gac-card-chips">' + chips + "</div>";
    // 元信息行：开发商 · 发售日期 · 评价数（有才显示）
    var metaBits = [];
    if (b.developer) metaBits.push(String(b.developer));
    if (b.release_date) metaBits.push(String(b.release_date));
    if (b.comment_count > 0) metaBits.push(fmtCount(b.comment_count) + "评价");
    if (metaBits.length) h += '<div class="gac-card-meta">' + escapeHtml(metaBits.join(" · ")) + "</div>";
    // 特性标签（中文/Steam Deck/家庭共享等）：全部展示，不折叠（用户要求）
    if (Array.isArray(b.features) && b.features.length) {
      h += '<div class="gac-card-feats">';
      for (var fi = 0; fi < b.features.length; fi++) {
        h += '<span class="gac-feat">' + escapeHtml(String(b.features[fi])) + "</span>";
      }
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
      var minP = Infinity, pricedCount = 0;
      for (var mi = 0; mi < plats.length; mi++) {
        var mp = parseFloat(plats[mi].price);
        if (isFinite(mp) && mp > 0) {
          pricedCount++;
          if (mp < minP) minP = mp;
        }
      }
      h += '<div class="gac-card-plats">';
      for (var pi = 0; pi < plats.length; pi++) {
        var r = plats[pi];
        var noPrice = r.no_price === true || !(parseFloat(r.price) > 0);
        var best = !noPrice && pricedCount > 1 && parseFloat(r.price) === minP;
        if (noPrice) {
          h += '<div class="gac-plat gac-plat-none">' +
            '<span class="gac-plat-name">' + escapeHtml(String(r.name)) + "</span>" +
            '<span class="gac-plat-price"><span class="gac-plat-na">暂无价格</span></span></div>';
          continue;
        }
        var hasOff = r.off_pct > 0;
        var hasOld = r.origin_price > 0 && r.origin_price > r.price;
        h += '<div class="gac-plat' + (best ? " gac-plat-best" : "") + '">' +
          '<span class="gac-plat-name">' + escapeHtml(String(r.name)) +
          (best ? '<span class="gac-plat-badge">最低</span>' : "") + "</span>" +
          '<span class="gac-plat-price">' +
          (hasOld && !hasOff ? '<span class="gac-plat-old">¥' + escapeHtml(fmtPrice(r.origin_price)) + "</span>" : "") +
          '<span class="gac-plat-now">¥' + escapeHtml(fmtPrice(r.price)) + "</span>" +
          (hasOff ? '<span class="gac-plat-off">-' + escapeHtml(String(r.off_pct)) + "%</span>" : "") +
          (r.remaining ? '<span class="gac-plat-dead">⏳' + escapeHtml(shortDeadline(r.remaining)) + "</span>" : "") +
          "</span></div>";
      }
      h += "</div>";
    }
    // 游戏截图集：一排三张（不横向滑动，避免出现丑滚动条），多余的用「+N」角标进灯箱看
    var shots = Array.isArray(b.screenshots) ? b.screenshots.filter(function (x) { return x && safeUrl(x.thumb); }) : [];
    if (shots.length) {
      var cardShow = Math.min(shots.length, 3);
      h += '<div class="gac-shots-head"><span>🖼 游戏截图 ' + shots.length + " 张</span>";
      h += '<span class="gac-shots-more">' + (shots.length > cardShow ? "点图看全部 ›" : "点图看大图 ›") + "</span></div>";
      h += '<div class="gac-card-shots">';
      for (var sh = 0; sh < cardShow; sh++) {
        var rest = shots.length - cardShow;
        h += '<div class="gac-shot-cell">' +
          '<img class="gac-shot" src="' + safeUrl(shots[sh].thumb) + '" data-full="' + safeUrl(shots[sh].full || shots[sh].thumb) +
          '" alt="' + escapeHtml((b.name || "游戏") + " 截图 " + (sh + 1)) + '" loading="lazy" referrerpolicy="no-referrer">' +
          (sh === cardShow - 1 && rest > 0 ? '<span class="gac-shot-more">+' + rest + "</span>" : "") +
          "</div>";
      }
      h += "</div>";
    }
    // 操作按钮：只留生成海报（预告片已由图集块内联播放，这里不再放外链按钮）
    h += '<div class="gac-card-actions">';
    h += '<button type="button" class="gac-card-btn gac-card-poster-btn">🖼️ 生成海报</button>';
    h += "</div></div></div>";
    return h;
  }

  /* ---------- 图片 / 预告片：媒体块 + 内联播放器 ----------
   * 数据全部来自 game.media（小黑盒详情），前端只负责渲染：
   *   - 截图：3 列网格，点击开灯箱（复用 openShots，左右切换 / Esc 关闭）
   *   - 预告片：封面图 + 播放按钮，点击才创建 <video>；m3u8 在 Safari 原生播，
   *     Chrome 等懒加载 hls.js（CDN 挂了就降级成"新窗口播放"链接，不影响其它内容）
   */
  var hlsLoading = null;
  function isVideoSrc(u) { return /\.(m3u8|mp4|webm|mov)([?#]|$)/i.test(String(u || "")); }

  function loadHlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsLoading) return hlsLoading;
    hlsLoading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
      s.async = true;
      s.onload = function () { window.Hls ? resolve(window.Hls) : reject(new Error("Hls 未定义")); };
      s.onerror = function () { hlsLoading = null; reject(new Error("hls.js 加载失败")); };
      document.head.appendChild(s);
    });
    return hlsLoading;
  }

  /** 在容器里挂一个 <video> 播放器（m3u8 走 hls.js，mp4 直接播） */
  function mountVideo(box, src, poster) {
    if (!box || !safeUrl(src)) return;
    var v = document.createElement("video");
    v.className = "gac-video-el";
    v.controls = true;
    v.autoplay = true;
    v.preload = "metadata";
    v.setAttribute("playsinline", "");
    v.setAttribute("referrerpolicy", "no-referrer");
    if (safeUrl(poster)) v.poster = safeUrl(poster);
    function useDirect() {
      v.src = src;
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
    }
    function fallbackLink(msg) {
      box.innerHTML = "";
      var a = document.createElement("a");
      a.className = "gac-video-fallback";
      a.href = src;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "▶ " + (msg || "在新窗口播放预告片");
      box.appendChild(a);
    }
    // 先把播放器放上去（有封面图，点击后立即有反馈）
    box.innerHTML = "";
    box.appendChild(v);
    if (!/\.m3u8([?#]|$)/i.test(src) || v.canPlayType("application/vnd.apple.mpegurl")) {
      useDirect();
      return;
    }
    loadHlsJs().then(function (Hls) {
      if (!Hls || !Hls.isSupported()) { useDirect(); return; }
      var h = new Hls({ maxBufferLength: 20 });
      h.on(Hls.Events.MANIFEST_PARSED, function () {
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      });
      h.on(Hls.Events.ERROR, function (_e, data) {
        if (data && data.fatal) fallbackLink("在新窗口播放预告片");
      });
      h.loadSource(src);
      h.attachMedia(v);
    }).catch(function () { fallbackLink("在新窗口播放预告片"); });
  }

  function mediaBlockHtml(b) {
    var name = escapeHtml(String((b && b.name) || "游戏"));
    var images = (b && Array.isArray(b.images) ? b.images : []).filter(function (x) { return x && safeUrl(x.thumb); });
    var videos = (b && Array.isArray(b.videos) ? b.videos : []).filter(function (x) { return x && safeUrl(x.url); });
    if (!images.length && !videos.length) return "";
    var h = '<div class="gac-media">';
    var meta = [];
    if (videos.length) meta.push("🎬 " + videos.length + " 个预告片");
    if (images.length) meta.push("🖼 " + images.length + " 张截图");
    h += '<div class="gac-media-head">' +
      '<span class="gac-media-title">' + name + " · 画面</span>" +
      '<span class="gac-media-meta">' + meta.join("　") + "</span></div>";
    if (videos.length) {
      // 只放一个主播放器（多个 16:9 大块叠在一起会把聊天窗撑成很长的滚动条），
      // 其余预告片用胶囊按钮切换播放源
      var tabs = [];
      for (var i = 0; i < videos.length; i++) {
        tabs.push({ src: safeUrl(videos[i].url), poster: safeUrl(videos[i].poster) });
      }
      h += '<div class="gac-video" data-src="' + tabs[0].src + '" data-poster="' + tabs[0].poster + '" data-tabs=\'' +
        escapeHtml(JSON.stringify(tabs)) + "'>";
      if (tabs[0].poster) {
        h += '<img class="gac-video-poster" src="' + tabs[0].poster + '" alt="' + name + ' 预告片封面" loading="lazy" referrerpolicy="no-referrer">';
      }
      h += '<button type="button" class="gac-video-btn">▶ 播放预告片' + (videos.length > 1 ? " 1" : "") + "</button></div>";
      if (videos.length > 1) {
        h += '<div class="gac-video-tabs">';
        for (var t = 0; t < videos.length; t++) {
          h += '<button type="button" class="gac-video-tab' + (t === 0 ? " active" : "") + '" data-i="' + t + '">预告片 ' + (t + 1) + "</button>";
        }
        h += "</div>";
      }
    }
    if (images.length) {
      // 最多 6 张（两排），其余用「+N」角标进灯箱看，保证媒体块不会长到需要滚很久
      var show = Math.min(images.length, 6);
      h += '<div class="gac-media-grid">';
      for (var j = 0; j < show; j++) {
        var left = images.length - show;
        h += '<div class="gac-shot-cell">' +
          '<img class="gac-shot" src="' + safeUrl(images[j].thumb) + '"' +
          ' data-full="' + safeUrl(images[j].full || images[j].thumb) + '"' +
          ' alt="' + name + " 截图 " + (j + 1) + '" loading="lazy" referrerpolicy="no-referrer">' +
          (j === show - 1 && left > 0 ? '<span class="gac-shot-more">+' + left + "</span>" : "") +
          "</div>";
      }
      h += "</div>";
    }
    return h + "</div>";
  }

  /** 媒体块交互：截图开灯箱、封面点击播放 */
  function bindMedia(scope, b) {
    var images = (b && Array.isArray(b.images) ? b.images : []).filter(function (x) { return x && safeUrl(x.thumb); });
    var nodes = scope.querySelectorAll(".gac-shot");
    for (var i = 0; i < nodes.length; i++) {
      (function (node, i) {
        node.addEventListener("error", function () { node.style.display = "none"; });
        node.addEventListener("click", function () { if (images.length) openShots(images, i); });
      })(nodes[i], i);
    }
    var vids = scope.querySelectorAll(".gac-video");
    for (var k = 0; k < vids.length; k++) {
      (function (node) {
        var btn = node.querySelector(".gac-video-btn");
        var posterImg = node.querySelector(".gac-video-poster");
        var tabs = [];
        try { tabs = JSON.parse(node.getAttribute("data-tabs") || "[]"); } catch (e) { tabs = []; }
        if (!tabs.length) tabs = [{ src: node.getAttribute("data-src"), poster: node.getAttribute("data-poster") }];
        var cur = 0;
        function go() {
          var t = tabs[cur] || {};
          mountVideo(node, t.src || node.getAttribute("data-src"), t.poster || node.getAttribute("data-poster"));
        }
        if (btn) btn.addEventListener("click", go);
        if (posterImg) posterImg.addEventListener("click", go);
        // 胶囊切换：换播放源；若已在播放则直接换台
        var tabBtns = scope.querySelectorAll(".gac-video-tab");
        for (var q = 0; q < tabBtns.length; q++) {
          (function (tb) {
            tb.addEventListener("click", function () {
              cur = parseInt(tb.getAttribute("data-i"), 10) || 0;
              for (var w = 0; w < tabBtns.length; w++) tabBtns[w].classList.toggle("active", w === cur);
              var t = tabs[cur] || {};
              var v = node.querySelector("video");
              if (v) {
                mountVideo(node, t.src, t.poster);
              } else {
                node.setAttribute("data-src", t.src || "");
                node.setAttribute("data-poster", t.poster || "");
                var pi = node.querySelector(".gac-video-poster");
                if (pi && t.poster) pi.src = t.poster;
                if (btn) btn.textContent = "▶ 播放预告片 " + (cur + 1);
              }
            });
          })(tabBtns[q]);
        }
      })(vids[k]);
    }
    scrollToBottom();
  }

  /** 回复正文里的 markdown 图片 / 视频（服务端已做 URL 白名单与清洗） */
  function bindMdMedia(scope) {
    var imgs = scope.querySelectorAll(".gac-md-img");
    if (imgs.length) {
      var list = [];
      for (var i = 0; i < imgs.length; i++) list.push({ thumb: imgs[i].src, full: imgs[i].src });
      for (var j = 0; j < imgs.length; j++) {
        (function (node, idx) {
          node.addEventListener("error", function () { node.style.display = "none"; });
          node.addEventListener("click", function () { openShots(list, idx); });
        })(imgs[j], j);
      }
    }
    var mvs = scope.querySelectorAll(".gac-md-video");
    for (var k = 0; k < mvs.length; k++) {
      (function (node) {
        var btn = node.querySelector(".gac-md-video-btn");
        if (btn) btn.addEventListener("click", function () { mountVideo(node, node.getAttribute("data-src"), ""); });
      })(mvs[k]);
    }
  }

  /* ---------- 海报：canvas 渲染 + 模态框（下载 PNG / 复制图片） ---------- */
  function loadImage(url, extraCovers, inlineData) {
    return new Promise(function (resolve) {
      // [{u, cors, clean}]：内联data → 直连CORS → 代理CORS → 直连非CORS
      var plan = coverCandidates(url, extraCovers, inlineData);
      if (!plan.length) { resolve(null); return; }
      var idx = 0;
      function next() {
        if (idx >= plan.length) { resolve(null); return; }
        var cand = plan[idx++];
        var img = new Image();
        if (cand.cors) img.crossOrigin = "anonymous";
        img.referrerPolicy = "no-referrer"; // 绕过 erbingeditor 等 CDN 的 Referer 防盗链(403)
        img.__corsOk = false;               // 加载成功后按候选类型置位（决定 canvas 能否导出 PNG）
        img.__src = cand.u;                 // 记录实际使用的 URL（兜底显示用）
        var done = false;
        img.onload = function () { if (done) return; done = true; img.__corsOk = !!cand.clean; resolve(img); };
        img.onerror = function () { if (done) return; done = true; setTimeout(next, 0); };
        img.src = cand.u;
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
  /* ===================== 海报引擎 v3：卡片版式 =====================
   * 用户反馈：卡片的排版最好看 → 海报直接沿用卡片的版式与配色：
   *   封面横幅（折扣角标 + 剩余时间）→ 标题行（左标题 / 右价格）→ 胶囊 chip 行 →
   *   特性标签行 → 史低行 → 平台价格两列网格（最低价高亮）→ 元信息行
   * 外层保留海报感：主题底色 + 卖点钩子 + 页脚；整块"卡片面板"浮在底色上。
   * 设计坐标恒 720 宽；所有尺寸＝卡片 CSS 尺寸 ×1.58（卡片宽 400 → 面板 632）。
   */
  var CP = {
    W: 720,                 // 设计宽
    MARGIN: 44,
    RADIUS: 22,
    PANEL_BG: "#1d222b",
    PANEL_BORDER: "#2e3642",
    NAME: "#ffffff",
    EN: "#8a93a3",
    TEXT: "#e8ecf2",
    MUTED: "#b9c2cf",
    PRICE: "#ffd23f",
    OFF: "#ff6b6b",
    CHIP_BG: "#2a313c",
    FEAT_FG: "#8fd0a8",
    FEAT_BG: "rgba(80,200,140,0.12)",
    FEAT_BORDER: "rgba(80,200,140,0.22)",
    BADGE_BG: "#e03333",
    AWARD_FG: "#ffd23f",
    AWARD_BG: "rgba(255,210,63,0.14)",
    AWARD_BORDER: "rgba(255,210,63,0.35)",
    BEST_BG: "rgba(255,210,63,0.10)",
    META: "#7f8794"
  };
  var CP_F = {
    name: 24, en: 16, price: 34, priceOld: 17, deadline: 16,
    chip: 18, chipH: 32, chipPad: 12,
    feat: 17, featH: 30, featPad: 10,
    plat: 18, platRow: 34, badge: 14,
    lowest: 19, meta: 16, hook: 30
  };

  /* ---------- 卡片内的基础绘图 ---------- */
  function cpPanel(ctx, x, y, w, h) {
    ctx.fillStyle = CP.PANEL_BG;
    roundRectPath(ctx, x, y, w, h, CP.RADIUS); ctx.fill();
    ctx.strokeStyle = CP.PANEL_BORDER; ctx.lineWidth = 2;
    roundRectPath(ctx, x, y, w, h, CP.RADIUS); ctx.stroke();
  }
  // 封面：等比裁剪 + 折扣角标（右上）+ 剩余时间角标（左下）
  function cpCover(ctx, img, x, y, w, h, off, remaining) {
    ctx.save();
    roundRectPath(ctx, x, y, w, h, CP.RADIUS);
    ctx.clip();
    mCover(ctx, img, x, y, w, h);
    // 底部渐隐，和卡片封面一致
    var f = ctx.createLinearGradient(0, y + h - 46, 0, y + h);
    f.addColorStop(0, "rgba(29,34,43,0)");
    f.addColorStop(1, "rgba(29,34,43,0.92)");
    ctx.fillStyle = f; ctx.fillRect(x, y + h - 46, w, 46);
    ctx.restore();
    if (off) {
      ctx.font = "800 22px 'PingFang SC',sans-serif";
      var bw = ctx.measureText(off).width + 26;
      ctx.save();
      ctx.translate(x + w - bw - 16, y + 16);
      ctx.rotate(3 * Math.PI / 180);
      ctx.fillStyle = CP.BADGE_BG;
      roundRectPath(ctx, 0, 0, bw, 40, 12); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(off, bw / 2, 21);
      ctx.restore();
    }
    if (remaining) {
      ctx.font = "700 18px 'PingFang SC',sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "rgba(255,214,160,0.95)";
      ctx.fillText("⏳ " + remaining, x + 18, y + h - 14);
    }
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  }
  // 标题行：左标题（名称+英文名）/ 右价格（划线原价 + 大字现价）
  function cpHead(ctx, x, y, w, th, D, dry) {
    var gap = 18;
    var priceW = 0;
    if (D.price > 0) {
      ctx.font = "900 " + CP_F.price + "px Arial,'PingFang SC',sans-serif";
      priceW = ctx.measureText("¥" + fmtPrice(D.price)).width;
      if (D.origin > 0) {
        ctx.font = "400 " + CP_F.priceOld + "px 'PingFang SC',sans-serif";
        priceW = Math.max(priceW, ctx.measureText("¥" + fmtPrice(D.origin)).width);
      }
    }
    var titleMax = w - priceW - (priceW ? gap : 0);
    ctx.font = "800 " + CP_F.name + "px 'PingFang SC',sans-serif";
    var name = String(D.name || "");
    while (ctx.measureText(name + "…").width > titleMax && Array.from(name).length > 2) name = Array.from(name).slice(0, -1).join("");
    if (name !== D.name) name += "…";
    var nameH = CP_F.name * 1.3;
    var enH = 0;
    var en = String(D.en || "");
    if (en) {
      ctx.font = "400 " + CP_F.en + "px Georgia,serif";
      while (ctx.measureText(en + "…").width > titleMax && Array.from(en).length > 2) en = Array.from(en).slice(0, -1).join("");
      if (en !== D.en) en += "…";
      enH = CP_F.en * 1.35;
    }
    // 折扣截止（小黑盒只在打折时给）：画在现价正下方，和卡片保持同一位置关系
    var dl = String(D.remaining || "");
    var dlH = dl ? Math.round(CP_F.deadline * 1.4) : 0;
    var h = Math.max(nameH + enH, CP_F.price + (D.origin > 0 ? CP_F.priceOld + 4 : 0)) + dlH;
    if (!dry) {
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = CP.NAME;
      ctx.font = "800 " + CP_F.name + "px 'PingFang SC',sans-serif";
      ctx.fillText(name, x, y + CP_F.name * 0.92);
      if (D.en) {
        ctx.fillStyle = CP.EN;
        ctx.font = "400 " + CP_F.en + "px Georgia,serif";
        ctx.fillText(en, x, y + nameH + CP_F.en * 0.86);
      }
      if (D.price > 0) {
        var px = x + w;
        if (D.origin > 0) {
          ctx.textAlign = "right";
          ctx.font = "400 " + CP_F.priceOld + "px 'PingFang SC',sans-serif";
          ctx.fillStyle = CP.EN;
          ctx.fillText("¥" + fmtPrice(D.origin), px, y + CP_F.priceOld * 0.95);
          var ow = ctx.measureText("¥" + fmtPrice(D.origin)).width;
          ctx.strokeStyle = CP.EN; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px - ow, y + CP_F.priceOld * 0.6); ctx.lineTo(px, y + CP_F.priceOld * 0.6); ctx.stroke();
        }
        ctx.textAlign = "right";
        ctx.font = "900 " + CP_F.price + "px Arial,'PingFang SC',sans-serif";
        ctx.fillStyle = CP.PRICE;
        ctx.fillText("¥" + fmtPrice(D.price), px, y + h - 2 - dlH);
        if (dl) {
          ctx.font = "700 " + CP_F.deadline + "px 'PingFang SC',sans-serif";
          ctx.fillStyle = CP.PRICE;
          ctx.fillText("⏳ " + dl, px, y + h - 3);
        }
      }
    }
    return h;
  }
  /* 胶囊行（chip / 特性标签 / 获奖）：通用换行绘制
   *   style: { bg, fg, border, h, font, pad }
   *   返回占用高度；超出行数上限时，末尾补一个「+N」 */
  function cpPills(ctx, x, y, w, items, style, maxRows, dry, align) {
    var list = (items || []).filter(function (it) { return it && it.text; });
    if (!list.length) return 0;
    ctx.font = style.font;
    var rows = [], cur = [], curW = 0;
    for (var i = 0; i < list.length; i++) {
      var pw = ctx.measureText(list[i].text).width + style.pad * 2;
      if (cur.length && curW + 8 + pw > w) { rows.push({ items: cur, w: curW }); cur = []; curW = 0; }
      cur.push({ text: list[i].text, kind: list[i].kind, w: pw });
      curW += (cur.length > 1 ? 8 : 0) + pw;
    }
    if (cur.length) rows.push({ items: cur, w: curW });
    var hidden = 0;
    if (rows.length > maxRows) {
      for (var r = maxRows; r < rows.length; r++) hidden += rows[r].items.length;
      rows = rows.slice(0, maxRows);
      var last = rows[maxRows - 1];
      last.items = last.items.slice(0, Math.max(1, last.items.length - 1));
      var moreItem = { text: "+" + hidden, kind: "more", w: 0 };
      last.items.push(moreItem);
    }
    if (!dry) {
      ctx.textBaseline = "middle";
      for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri], ry = y + ri * (style.h + 8);
        var rx = align === "left" ? x : x + Math.max(0, (w - row.w) / 2);
        for (var j = 0; j < row.items.length; j++) {
          var it = row.items[j];
          if (!it.w) { ctx.font = style.font; it.w = ctx.measureText(it.text).width + style.pad * 2; }
          var st = (it.kind === "award") ? { bg: CP.AWARD_BG, fg: CP.AWARD_FG, border: CP.AWARD_BORDER } : style;
          ctx.fillStyle = st.bg;
          roundRectPath(ctx, rx, ry, it.w, style.h, style.h / 2); ctx.fill();
          if (st.border) {
            ctx.strokeStyle = st.border; ctx.lineWidth = 1.5;
            roundRectPath(ctx, rx, ry, it.w, style.h, style.h / 2); ctx.stroke();
          }
          ctx.fillStyle = st.fg;
          ctx.font = style.font;
          ctx.textAlign = "center";
          ctx.fillText(it.text, rx + it.w / 2, ry + style.h / 2 + 1);
          rx += it.w + 8;
        }
      }
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    }
    return rows.length * style.h + Math.max(0, rows.length - 1) * 8;
  }
  /* 平台价格：两列网格（与卡片一致），最低价行高亮 + 「最低」角标 */
  function cpPlats(ctx, x, y, w, D, dry, maxRows) {
    var items = [];
    for (var i = 0; i < (D.plats || []).length; i++) {
      var it = D.plats[i];
      if (!it || !it.name) continue;
      var noP = it.no_price === true || !(parseFloat(it.price) > 0);
      items.push({
        name: String(it.name), price: parseFloat(it.price) || 0,
        originP: parseFloat(it.origin_price) || 0, offP: parseFloat(it.off_pct) || 0, noPrice: noP,
        remaining: String(it.remaining || "").trim(),  // 该平台折扣截止（各平台可能不同）
      });
    }
    if (!items.length) return 0;
    var minP = Infinity, priced = 0;
    for (i = 0; i < items.length; i++) {
      if (items[i].noPrice) continue;
      priced++;
      if (items[i].price < minP) minP = items[i].price;
    }
    for (i = 0; i < items.length; i++) {
      items[i].best = !items[i].noPrice && priced > 1 && items[i].price === minP;
    }
    var shown = items;
    var rest = 0;
    if (maxRows && items.length > maxRows * 2) {
      shown = items.slice(0, maxRows * 2 - 1);
      rest = items.length - shown.length;
    }
    var rows = Math.ceil((shown.length + (rest ? 1 : 0)) / 2);
    var rowH = CP_F.platRow;
    var gapX = 26;
    var cellW = (w - gapX) / 2;
    if (!dry) {
      ctx.textBaseline = "middle";
      for (var si = 0; si < shown.length + (rest ? 1 : 0); si++) {
        var col = si % 2, row = Math.floor(si / 2);
        var cx = x + col * (cellW + gapX);
        var cy = y + row * rowH + rowH / 2;
        if (rest && si === shown.length) {  // 末尾"还有 N 个平台"
          ctx.textAlign = "left";
          ctx.font = "600 " + CP_F.meta + "px 'PingFang SC',sans-serif";
          ctx.fillStyle = CP.META;
          ctx.fillText("还有 " + rest + " 个平台…", cx, cy);
          continue;
        }
        var s = shown[si];
        if (s.best) {
          ctx.fillStyle = CP.BEST_BG;
          roundRectPath(ctx, cx - 8, cy - rowH / 2 + 3, cellW + 16, rowH - 6, 8); ctx.fill();
        }
        // 价格组（右对齐）宽度先量
        ctx.font = "800 " + CP_F.plat + "px Arial,'PingFang SC',sans-serif";
        var nowT = s.noPrice ? "暂无价格" : "¥" + fmtPrice(s.price);
        var nowW = ctx.measureText(nowT).width;
        var offT = (!s.noPrice && s.offP > 0) ? "-" + s.offP + "%" : "";
        var offW = 0;
        if (offT) { ctx.font = "700 " + CP_F.badge + "px Arial,sans-serif"; offW = ctx.measureText(offT).width + 8; }
        var badgeT = s.best ? "最低" : "";
        var badgeW = 0;
        if (badgeT) { ctx.font = "700 " + CP_F.badge + "px 'PingFang SC',sans-serif"; badgeW = ctx.measureText(badgeT).width + 12; }
        // 逐平台折扣截止（最右，小字）；宽度不够时先让"最低"角标让位，再弃掉截止，绝不让行内溢出
        var dlT = (!s.noPrice && s.remaining) ? "⏳" + shortDeadline(s.remaining) : "";
        var dlW = 0;
        if (dlT) { ctx.font = "700 " + CP_F.badge + "px 'PingFang SC',sans-serif"; dlW = ctx.measureText(dlT).width + 10; }
        var nameMax = cellW - nowW - offW - badgeW - dlW - 16;
        if (nameMax < 40 && badgeW) { badgeW = 0; nameMax = cellW - nowW - offW - dlW - 16; }
        if (nameMax < 40 && dlW) { dlW = 0; dlT = ""; nameMax = cellW - nowW - offW - 16; }
        ctx.textAlign = "left";
        ctx.font = "600 " + CP_F.plat + "px 'PingFang SC',sans-serif";
        var nm = s.name;
        while (Array.from(nm).length > 1 && ctx.measureText(nm + "…").width > Math.max(30, nameMax)) nm = Array.from(nm).slice(0, -1).join("");
        if (nm !== s.name) nm += "…";
        ctx.fillStyle = s.noPrice ? CP.EN : (s.best ? CP.PRICE : CP.TEXT);
        ctx.fillText(nm, cx, cy);
        var nmW = ctx.measureText(nm).width;
        if (badgeW) {
          ctx.fillStyle = CP.BADGE_BG;
          roundRectPath(ctx, cx + nmW + 8, cy - CP_F.badge / 2 - 3, badgeW, CP_F.badge + 6, 5); ctx.fill();
          ctx.fillStyle = "#fff"; ctx.font = "700 " + CP_F.badge + "px 'PingFang SC',sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(badgeT, cx + nmW + 8 + badgeW / 2, cy + 1);
        }
        ctx.textAlign = "right";
        var rx = cx + cellW - dlW;   // 给最右的截止让位
        ctx.font = "800 " + CP_F.plat + "px Arial,'PingFang SC',sans-serif";
        ctx.fillStyle = s.noPrice ? CP.META : CP.PRICE;
        ctx.fillText(nowT, rx, cy);
        if (offT) {
          ctx.font = "700 " + CP_F.badge + "px Arial,sans-serif";
          ctx.fillStyle = CP.OFF;
          ctx.fillText(offT, rx - nowW - 8, cy);
        }
        if (dlT) {
          ctx.font = "700 " + CP_F.badge + "px 'PingFang SC',sans-serif";
          ctx.fillStyle = CP.OFF;
          ctx.textAlign = "right";
          ctx.fillText(dlT, cx + cellW, cy);
        }
      }
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    }
    return rows * rowH;
  }
  // 史低行 / 元信息行
  function cpLine(ctx, x, y, w, text, size, weight, color, dry, align) {
    if (!text) return 0;
    ctx.font = weight + " " + size + "px 'PingFang SC',sans-serif";
    var t = String(text);
    while (Array.from(t).length > 1 && ctx.measureText(t + "…").width > w) t = Array.from(t).slice(0, -1).join("");
    if (t !== text) t += "…";
    if (!dry) {
      ctx.textAlign = align === "center" ? "center" : "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = color;
      ctx.fillText(t, align === "center" ? x + w / 2 : x, y + size * 1.05);
    }
    return Math.round(size * 1.35);
  }

  // ===== 版式：设计坐标恒 720 宽，按输出尺寸整体缩放 =====
  var POSTER_DESIGN_W = 720;
  var POSTER_FORMS = [
    { key: "A34", w: 1080, h: 1440, dh: 960 },   // 3:4
    { key: "B45", w: 1080, h: 1350, dh: 900 }    // 4:5（默认）
  ];
  function pickForm() {
    var pref = String(CONFIG.posterAspect || "4:5");
    if (pref === "3:4") return POSTER_FORMS[0];
    if (pref === "auto") return POSTER_FORMS[Math.random() < 0.5 ? 0 : 1];
    return POSTER_FORMS[1];
  }

  /* ---------- 卡片内容装配（与卡片 DOM 一致的顺序与取舍） ---------- */
  function buildChips(D) {
    var chips = [], seen = {};
    function add(text, kind) {
      var t = String(text == null ? "" : text).trim();
      if (!t || seen[t]) return;
      seen[t] = 1;
      chips.push({ text: t, kind: kind });
    }
    if (D.rating) add("⭐ " + D.rating, "");
    if (D.platform) add(D.platform, "");
    if (D.dlcCount > 0) add("DLC × " + D.dlcCount, "");
    if (D.goodRate) add("好评率 " + D.goodRate, "");
    if (D.avgPlaytime) add("平均 " + D.avgPlaytime, "");
    if (D.follow) add("👥 " + D.follow, "");
    if ((D.awards || []).length) add("🏆 " + D.awards[0], "award");
    return chips;
  }
  function buildFeats(D) {
    var feats = [], seen = {};
    function add(t) {
      var v = String(t == null ? "" : t).trim();
      if (!v || seen[v]) return;
      seen[v] = 1;
      feats.push({ text: v });
    }
    for (var i = 0; i < (D.features || []).length; i++) add(D.features[i]);
    for (var j = 0; j < (D.tags || []).length; j++) add(D.tags[j]);
    return feats;
  }
  // 多维评分（卡片没有，但海报有空间时作为附加信息）
  function cpDims(ctx, x, y, w, dims, dry) {
    var list = (dims || []).filter(function (d) { return d && d.name && d.score; });
    if (!list.length) return 0;
    var ROW = 32, LABEL_W = 104, SCORE_W = 42, COL_GAP = 34;
    var colW = (w - COL_GAP) / 2;
    var BAR_MAX = Math.max(50, colW - LABEL_W - SCORE_W - 6);
    if (!dry) {
      ctx.textBaseline = "middle";
      for (var i = 0; i < list.length; i++) {
        var col = i % 2, row = Math.floor(i / 2);
        var cx = x + col * (colW + COL_GAP);
        var cy = y + row * ROW + ROW / 2;
        ctx.textAlign = "left";
        ctx.font = "600 17px 'PingFang SC',sans-serif";
        ctx.fillStyle = CP.MUTED;
        ctx.fillText(list[i].name, cx, cy);
        var bw = Math.max(8, Math.min(1, parseFloat(list[i].score) / 10) * BAR_MAX);
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        roundRectPath(ctx, cx + LABEL_W, cy - 5, BAR_MAX, 10, 5); ctx.fill();
        ctx.fillStyle = CP.PRICE;
        roundRectPath(ctx, cx + LABEL_W, cy - 5, bw, 10, 5); ctx.fill();
        ctx.font = "700 16px Arial,sans-serif";
        ctx.fillText(list[i].score, cx + LABEL_W + BAR_MAX + 8, cy + 1);
      }
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    }
    return Math.ceil(list.length / 2) * ROW;
  }

  /* 一排截图（借鉴卡片：等宽 16:9、圆角、cover 裁剪）。
     返回占用高度；传入 dry=true 时只量高度不画。 */
  function cpShotRow(ctx, x, y, w, imgs, count, dry) {
    var list = (imgs || []).filter(function (i) { return i && i.width; });
    if (!list.length || count <= 0) return 0;
    var cols = Math.max(1, Math.min(count, list.length));
    var gap = 8, cw = (w - gap * (cols - 1)) / cols, ch = cw * 9 / 16, r = 9;
    if (dry) return Math.ceil(ch) + 6;
    for (var i = 0; i < cols; i++) {
      var ix = x + i * (cw + gap);
      var im = list[i];
      // object-fit: cover —— 按目标比例从原图中心裁一块
      var target = cw / ch, sr = im.width / im.height;
      var sx = 0, sy = 0, sw = im.width, sh = im.height;
      if (sr > target) { sw = sh * target; sx = (im.width - sw) / 2; }
      else { sh = sw / target; sy = (im.height - sh) / 2; }
      ctx.save();
      roundRectPath(ctx, ix, y + 6, cw, ch, r);
      ctx.clip();
      try { ctx.drawImage(im, sx, sy, sw, sh, ix, y + 6, cw, ch); } catch (e) { /* 单张失败不影响其它 */ }
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1;
      roundRectPath(ctx, ix + 0.5, y + 6.5, cw - 1, ch - 1, r); ctx.stroke();
    }
    return Math.ceil(ch) + 6;
  }

  /* ---------- 卡片版式海报 ---------- */
  function renderCardPoster(ctx, D) {
    var W = POSTER_DESIGN_W, th = D.th;
    var M = CP.MARGIN, panelX = M, panelW = W - M * 2;
    var PADX = 22, PADT = 16, PADB = 18;
    var innerW = panelW - PADX * 2;
    var footerLine = D.h - 48;
    var coverH = D.coverImg ? Math.round(panelW * 0.295) : 0;
    var offTxt = D.off || "";
    var coverBadge = ""; // 折扣截止已改到价格旁边（cpHead），封面不再重复画

    var chips = buildChips(D);
    var feats = buildFeats(D);
    var shots = Array.isArray(D.shots) ? D.shots : [];
    var dims = Array.isArray(D.ratingDims) ? D.ratingDims : [];
    var lowestTxt = D.lowestPrice > 0
      ? "史低 ¥" + fmtPrice(D.lowestPrice) + (D.lowestDate ? "  ·  " + D.lowestDate : "") : "";
    var metaTxt = [D.developer, D.releaseDate, D.commentCount ? fmtCount(D.commentCount) + "评价" : ""]
      .filter(Boolean).join("  ·  ");

    var chipStyle = { bg: CP.CHIP_BG, fg: CP.MUTED, border: null, h: CP_F.chipH,
      font: "700 " + CP_F.chip + "px 'PingFang SC',sans-serif", pad: CP_F.chipPad };
    var featStyle = { bg: CP.FEAT_BG, fg: CP.FEAT_FG, border: CP.FEAT_BORDER, h: CP_F.featH,
      font: "700 " + CP_F.feat + "px 'PingFang SC',sans-serif", pad: CP_F.featPad };

    // 量出某档位的面板正文高度
    function bodyHeight(plan) {
      var y = PADT + 2;
      y += cpHead(ctx, 0, 0, innerW, th, D, true) + 14;
      var ch = chips.length ? cpPills(ctx, 0, 0, innerW, chips, chipStyle, plan.chipRows, true, "left") : 0;
      y += ch + (ch ? 12 : 0);
      var fh = (feats.length && plan.featRows > 0) ? cpPills(ctx, 0, 0, innerW, feats, featStyle, plan.featRows, true, "left") : 0;
      y += fh + (fh ? 12 : 0);
      if (plan.showLowest && lowestTxt) y += 28 + 10;
      var ph = cpPlats(ctx, 0, 0, innerW, D, true, plan.platRows);
      y += ph + (ph ? 14 : 0);
      if (plan.showDims && dims.length) y += cpDims(ctx, 0, 0, innerW, dims, true) + 12;
      // 与绘制路径保持一致：cpLine 的高度 = 字号 × 1.35，后面还跟 10px 间距（截图排在其下）
      if (plan.showMeta && metaTxt) y += Math.round(CP_F.meta * 1.35) + 10;
      // 截图一排（借鉴卡片：放在最底部）
      var sh2 = cpShotRow(ctx, 0, 0, innerW, shots, plan.shotCount || 0, true);
      if (sh2) y += sh2 + 8;
      return y + PADB - 2;
    }

    // 钩子（LLM 卖点）不再画在海报上方：整块直接由卡片面板构成，面板在页脚之上居中。
    // 数据仍随 block 下发（D.hook 保留），需要时可在卡片标题下方补一行。
    var topLimit = M;
    var botLimit = footerLine - 22;
    // shotCount：一排截图的张数（借用卡片观感）；内容多时逐级让位——先砍元信息/评分维度，
    // 再砍截图张数（3→2→1），最后才整排不画
    var plans = [
      { chipRows: 3, featRows: 2, showLowest: true,  showMeta: true,  showDims: true,  platRows: 8, shotCount: 3 },
      { chipRows: 3, featRows: 2, showLowest: true,  showMeta: true,  showDims: false, platRows: 8, shotCount: 3 },
      { chipRows: 2, featRows: 2, showLowest: true,  showMeta: true,  showDims: false, platRows: 6, shotCount: 3 },
      { chipRows: 2, featRows: 2, showLowest: true,  showMeta: false, showDims: false, platRows: 5, shotCount: 3 },
      { chipRows: 2, featRows: 1, showLowest: true,  showMeta: false, showDims: false, platRows: 4, shotCount: 2 },
      { chipRows: 2, featRows: 1, showLowest: true,  showMeta: false, showDims: false, platRows: 4, shotCount: 1 },
      { chipRows: 1, featRows: 1, showLowest: true,  showMeta: false, showDims: false, platRows: 3, shotCount: 1 },
      { chipRows: 1, featRows: 1, showLowest: false, showMeta: false, showDims: false, platRows: 3, shotCount: 0 },
      { chipRows: 1, featRows: 0, showLowest: false, showMeta: false, showDims: false, platRows: 3, shotCount: 0 }
    ];
    var chosen = plans[plans.length - 1], bodyH = 0;
    for (var pi = 0; pi < plans.length; pi++) {
      var p = plans[pi];
      bodyH = bodyHeight(p);
      var total = coverH + bodyH;
      chosen = p;
      if (total <= botLimit - topLimit) break;
    }

    // ---- 富余空间分配：① 封面横幅吃掉一部分（最多长到面板宽的 0.42，内容少时当主视觉）
    //      ② 剩下的上下平分，让整块（钩子 + 面板）在页脚之上居中，底部不留大片空白 ----
    var baseTotal = coverH + bodyH;
    var slack = Math.max(0, (botLimit - topLimit) - baseTotal);
    var maxCover = D.coverImg ? Math.round(panelW * 0.52) : 0;
    var coverGrow = D.coverImg ? Math.max(0, Math.min(maxCover - coverH, Math.round(slack * 0.55))) : 0;
    coverH += coverGrow;
    // 内容偏少时，卡片上下内边距也撑开一点（内部留白比底部空一大块好看）
    var airy = (slack - coverGrow) > 60 ? 8 : 0;
    bodyH += airy * 2;
    var rest = Math.max(0, slack - coverGrow - airy * 2);
    var padTop = Math.round(rest * 0.5);

    // ---- 绘制 ----
    var panelH = coverH + bodyH;
    var y = topLimit + padTop;

    // 面板
    cpPanel(ctx, panelX, y, panelW, panelH);
    if (D.coverImg) cpCover(ctx, D.coverImg, panelX, y, panelW, coverH, offTxt, coverBadge);
    var cy = y + coverH + PADT + 2 + airy;
    cy += cpHead(ctx, panelX + PADX, cy, innerW, th, D, false) + 14;
    if (chips.length) {
      cy += cpPills(ctx, panelX + PADX, cy, innerW, chips, chipStyle, chosen.chipRows, false, "left") + 12;
    }
    if (feats.length && chosen.featRows > 0) {
      cy += cpPills(ctx, panelX + PADX, cy, innerW, feats, featStyle, chosen.featRows, false, "left") + 12;
    }
    if (chosen.showLowest && lowestTxt) {
      cy += cpLine(ctx, panelX + PADX, cy, innerW, lowestTxt, CP_F.lowest, 800, CP.PRICE, false, "left") + 10;
    }
    var ph = cpPlats(ctx, panelX + PADX, cy, innerW, D, false, chosen.platRows);
    cy += ph + (ph ? 14 : 0);
    if (chosen.showDims && dims.length) cy += cpDims(ctx, panelX + PADX, cy, innerW, dims, false) + 12;
    if (chosen.showMeta && metaTxt) {
      cy += cpLine(ctx, panelX + PADX, cy, innerW, metaTxt, CP_F.meta, 500, CP.META, false, "left") + 10;
    }
    // 截图一排（借用卡片观感：等宽三张、圆角）
    if (shots.length && chosen.shotCount > 0) {
      cy += cpShotRow(ctx, panelX + PADX, cy, innerW, shots, chosen.shotCount, false) + 6;
    }
    // 页脚
    ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(M, footerLine); ctx.lineTo(W - M, footerLine); ctx.stroke();
    var d = new Date();
    var ds = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    ctx.font = "500 17px 'PingFang SC',sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(255,255,255,0.42)";
    ctx.fillText("由 Stray 查价生成 · 数据实时查询 · " + ds, W / 2, footerLine + 30);
  }

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
  /* 一次海报渲染的全部随机决策（主题 + 版式）打包成 plan，
     预览/下载/复制复用同一个 plan，配色与版式不会跳变 */
  function makePosterPlan(coverImg) {
    return { theme: pickTheme(coverImg), form: pickForm() };
  }
  /* 渲染海报：设计坐标恒为 720 宽，按版式尺寸整体缩放；scale=2 出高清图（逻辑坐标不变） */
  function drawPoster(canvas, b, coverImg, plan, scale) {
    var p = plan || {};
    var fm = p.form || pickForm();
    var th = p.theme || pickTheme(coverImg);
    var ratio = scale > 1 ? scale : 1;
    var s = ratio * (fm.w / POSTER_DESIGN_W);
    var W = POSTER_DESIGN_W, H = fm.dh;
    canvas.width = fm.w * ratio; canvas.height = fm.h * ratio;
    var ctx = canvas.getContext("2d");
    ctx.scale(s, s);                     // 之后所有绘制都用 720 宽的设计坐标
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
      w: W, h: H, th: th, align: fm.align, typo: !!fm.typo, form: fm.key,
      coverImg: fm.typo ? null : coverImg,   // 纯排版版式不画封面
      hook: b.hook ? String(b.hook) : "",
      tags: Array.isArray(b.tags) ? b.tags : undefined,
      awards: Array.isArray(b.awards) ? b.awards : undefined,
      dlcCount: parseInt(b.dlc_count, 10) || 0,
      releaseDate: b.release_date ? String(b.release_date) : "",
      developer: b.developer ? String(b.developer) : "",
      online: b.online ? String(b.online) : "",
      goodRate: b.good_rate ? String(b.good_rate) : "",
      commentCount: parseInt(b.comment_count, 10) || 0,
      avgPlaytime: b.avg_playtime ? String(b.avg_playtime) : "",
      ratingDims: Array.isArray(b.rating_dims) ? b.rating_dims : undefined,
      name: String(b.name || ""), en: b.en_name ? String(b.en_name) : "",
      rating: b.rating, remaining: b.remaining, plats: plats,
      features: Array.isArray(b.features) ? b.features : undefined,
      shots: (p.shots || []).filter(function (x) { return x && x.width; }),
      lowestPrice: b.lowest_price > 0 ? b.lowest_price : undefined,
      lowestDate: b.lowest_date ? String(b.lowest_date) : "",
      origin: best && best.origin_price ? best.origin_price : (b.origin_price || 0),
      price: best && best.price ? best.price : (b.price || 0)
    };
    D.off = "";
    if (D.origin > 0 && D.price > 0 && D.price < D.origin) D.off = "-" + Math.round((1 - D.price / D.origin) * 100) + "%";
    renderCardPoster(ctx, D);
    return p;
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
  function renderPoster(block, img, plan, scale) {
    var canvas = document.createElement("canvas");
    try { drawPoster(canvas, block, img, plan, scale || 1); } catch (e) { /* 保留空画布，按钮仍可用 */ }
    return canvas;
  }
  function exportCanvas(preview, block, img, plan) {
    if (!block) return preview;
    try {
      var hi = renderPoster(block, img, plan, 2);
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
    preparePoster(block).then(function (pre) {
      var usable = pre.img;                       // 不可导出时置 null → 走无封面纯排版版式
      var plan = pre.plan;                        // plan.shots 已带截图（与弹窗海报一致）
      var canvas = renderPoster(block, usable, plan, 1);
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
      try { pimg.src = canvas.toDataURL("image/png"); } catch (e) { pimg.src = safeUrl(block.cover) || ""; }
      bodyEl.appendChild(wrap);
      scrollToBottom();
      wrap.querySelector('[data-act="save"]').addEventListener("click", function () {
        downloadCanvas(exportCanvas(canvas, block, usable, plan));
      });
      wrap.querySelector('[data-act="copy"]').addEventListener("click", function () {
        copyCanvas(exportCanvas(canvas, block, usable, plan));
      });
      if (onDone) setTimeout(onDone, 150);
    });
  }
  /* 海报用截图：最多 3 张（借鉴卡片的一排三张），只要 CORS 安全的图
     —— 小黑盒图床不发 CORS 头，直连会把画布污染导致导不出 PNG，所以必须过网关代理；
     拿不到就少画这一排，绝不让整张海报导出失败。 */
  function loadPosterShots(block, max) {
    var shots = (block && Array.isArray(block.screenshots) ? block.screenshots : [])
      .filter(function (x) { return x && safeUrl(x.thumb); })
      .slice(0, max || 3);
    if (!shots.length) return Promise.resolve([]);
    return Promise.all(shots.map(function (sh) {
      return loadImage(safeUrl(sh.thumb), null, undefined).then(function (img) {
        return img && img.__corsOk !== false ? img : null;
      }).catch(function () { return null; });
    })).then(function (imgs) {
      return imgs.filter(Boolean);
    });
  }

  /* 海报素材准备：封面 + 最多 3 张截图（弹窗海报与内联海报共用，两条路必须一致） */
  function preparePoster(block) {
    return Promise.all([
      loadImage(safeUrl(block.cover), block.covers, block.cover_data),
      loadPosterShots(block, 3),
    ]).then(function (rs) {
      var usable = posterImageFor(rs[0]);
      var plan = makePosterPlan(usable);
      plan.shots = rs[1] || [];   // 随 plan 走，导出高清图时复用（不重新下载）
      return { img: usable, plan: plan };
    });
  }

  function openPoster(block) {
    preparePoster(block).then(function (pre) {
      var usable = pre.img;
      var plan = pre.plan;
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
        downloadCanvas(exportCanvas(canvas, block, usable, plan));
      });
      overlay.querySelector('[data-act="copy"]').addEventListener("click", function () {
        copyCanvas(exportCanvas(canvas, block, usable, plan));
      });
      try { drawPoster(canvas, block, usable, plan, 1); } catch (e) { /* 保留空画布，操作仍可用 */ }
    });
  }
  /* ---------- 截图大图查看（灯箱：左右切换 / Esc 关闭 / 点背景关闭） ---------- */
  function openShots(shots, startIndex) {
    var idx = Math.max(0, Math.min(startIndex || 0, shots.length - 1));
    var overlay = document.createElement("div");
    overlay.className = "gac-media-modal";
    overlay.innerHTML =
      '<div class="gac-media-box">' +
        '<img class="gac-media-img" alt="游戏截图" referrerpolicy="no-referrer">' +
        '<div class="gac-media-bar">' +
          '<button type="button" class="gac-media-act" data-act="prev">‹</button>' +
          '<span class="gac-media-idx"></span>' +
          '<button type="button" class="gac-media-act" data-act="next">›</button>' +
          '<button type="button" class="gac-media-act gac-media-close">✕</button>' +
        "</div>" +
      "</div>";
    var img = overlay.querySelector(".gac-media-img");
    var label = overlay.querySelector(".gac-media-idx");
    function show(i) {
      idx = (i + shots.length) % shots.length;
      img.src = shots[idx].full || shots[idx].thumb;
      label.textContent = (idx + 1) + " / " + shots.length;
    }
    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") show(idx - 1);
      else if (e.key === "ArrowRight") show(idx + 1);
    }
    overlay.querySelector('[data-act="prev"]').addEventListener("click", function (e) { e.stopPropagation(); show(idx - 1); });
    overlay.querySelector('[data-act="next"]').addEventListener("click", function (e) { e.stopPropagation(); show(idx + 1); });
    overlay.querySelector(".gac-media-close").addEventListener("click", close);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    show(idx);
  }
  /* 卡片内截图条的事件绑定（点击开灯箱；加载失败的缩略图直接移除） */
  function bindShots(scope, block) {
    var shots = Array.isArray(block.screenshots) ? block.screenshots.filter(function (x) { return x && safeUrl(x.thumb); }) : [];
    if (!shots.length) return;
    var nodes = scope.querySelectorAll(".gac-shot");
    for (var i = 0; i < nodes.length; i++) {
      (function (node, i) {
        node.addEventListener("error", function () { node.style.display = "none"; });
        node.addEventListener("click", function () { openShots(shots, i); });
      })(nodes[i], i);
    }
    scrollToBottom();
  }

  /* 单个富块 → DOM 节点（分段渲染与整批渲染共用同一套逻辑） */
  function blockNode(b, withEnter) {
    var div = document.createElement("div");
    div.className = "gac-block gac-block-" + (b && b.type ? escapeHtml(String(b.type)) : "unknown") +
      (withEnter ? " gac-part-in" : "");
    if (b && b.type === "game_media") {
      div.innerHTML = mediaBlockHtml(b);
      bindMedia(div, b);
    } else if (b && b.type === "game_card") {
      div.innerHTML = gameCardHtml(b);
      var btn = div.querySelector(".gac-card-poster-btn");
      if (btn) {
        btn.addEventListener("click", function () { openPoster(b); });
      }
      bindShots(div, b);
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
    return div;
  }

  function renderBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) return;
    var wrap = document.createElement("div");
    wrap.className = "gac-blocks";
    blocks.forEach(function (b) { wrap.appendChild(blockNode(b, false)); });
    bodyEl.appendChild(wrap);
    scrollToBottom();
  }

  /* ---------- 分段渲染：同一个回复框里 文字打字 → 卡片/图片块淡入 → 继续打字 ----------
   * parts 由后端按模型给的 [[card:游戏名]] / [[media:游戏名]] 标记切好顺序：
   *   [{type:"text",md:"先说结论"},{type:"game_card",...},{type:"text",md:"补充说明"}]
   */
  function typewriterInto(host, text, onDone) {
    var div = document.createElement("div");
    div.className = "gac-part-text";
    host.appendChild(div);
    var chars = Array.from(String(text || ""));
    if (!chars.length) { if (onDone) onDone(); return; }
    var totalMs = Math.max(220, Math.min(1500, chars.length * 12)); // 分段更短，节奏更利落
    var step = Math.max(1, Math.ceil(chars.length / (totalMs / 16)));
    var i = 0;
    var timer = setInterval(function () {
      i = Math.min(chars.length, i + step);
      div.innerHTML = renderMarkdown(chars.slice(0, i).join(""));
      scrollToBottom();
      if (i >= chars.length) {
        clearInterval(timer);
        if (onDone) onDone();
      }
    }, 16);
  }

  function renderParts(parts, onDone) {
    if (!Array.isArray(parts) || !parts.length) { if (onDone) onDone(); return null; }
    var host = document.createElement("div");
    host.className = "gac-msg agent gac-reply";
    bodyEl.appendChild(host);
    scrollToBottom();
    var i = 0;
    function step() {
      if (i >= parts.length) { if (onDone) onDone(); return; }
      var part = parts[i++];
      if (part && part.type === "text") {
        typewriterInto(host, part.md, function () { setTimeout(step, 110); });
      } else {
        host.appendChild(blockNode(part, true)); // 淡入 + 轻微上移
        scrollToBottom();
        setTimeout(step, 320); // 让卡片的入场动画走完再继续写字
      }
    }
    step();
    return host;
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
    if (typeof data.reply === "string") return { reply: data.reply, blocks: data.blocks || [], parts: data.parts };
    if (data.reply) return { reply: JSON.stringify(data.reply), blocks: [], parts: data.parts };
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
        if (typeof data.reply === "string") return { reply: data.reply, blocks: data.blocks || [], parts: data.parts };
        if (data.status === "done" && data.result) return { reply: data.result, blocks: [], parts: data.parts };
        lastErr = null; // 一次成功的轮询清除之前的瞬时错误
      } catch (e) {
        // 瞬时网络/CORS 抖动（如网关边缘偶发错误页）：继续轮询，不中断整个对话
        lastErr = e;
      }
    }
    // 超时：不要只把最后一个瞬时错误（如代理 502）抛给用户，给出可理解的说明
    if (lastErr) throw new Error("等待回复超时（" + lastErr.message + "），任务可能仍在处理，请稍后再试。");
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
    return "收到：「" + text + "」。\n（演示模式）真实网关尚未接入，接好后这里会返回 Stray 的实际回复。可以试试问我：红色沙漠现在多少钱 / 黑神话 二郎神怎么打。";
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
        // 后端给了分段且含富块（卡片/图片块）→ 在同一个回复框里依次 打字 → 淡入 → 续写。
        // 纯文字回复仍走下面原来的窄气泡，保持既有观感（Hug 内容而不是整宽）。
        var partsArr = Array.isArray(res.parts) ? res.parts : [];
        var hasRichPart = false;
        for (var pi = 0; pi < partsArr.length; pi++) {
          if (partsArr[pi] && partsArr[pi].type !== "text") { hasRichPart = true; break; }
        }
        if (hasRichPart) {
          renderParts(partsArr);
          statusEl.textContent = "· 在线";
          return;
        }
        var hasCard = firstCard !== null;
        // 兼容旧网关：有游戏卡片时【卡片先出、文字后打】（卡片承载结构化信息，文字做补充）
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