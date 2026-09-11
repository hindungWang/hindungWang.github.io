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
  function loadImage(url) {
    return new Promise(function (resolve) {
      if (!url) { resolve(null); return; }
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = url;
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
  function drawPoster(canvas, b, coverImg) {
    var W = 720, H = 960;
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    // 背景
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#241111"); g.addColorStop(0.55, "#120707"); g.addColorStop(1, "#0a0303");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (coverImg) {
      ctx.drawImage(coverImg, 0, 0, W, 340);
      var f = ctx.createLinearGradient(0, 240, 0, 360);
      f.addColorStop(0, "rgba(18,7,7,0)"); f.addColorStop(1, "rgba(18,7,7,1)");
      ctx.fillStyle = f; ctx.fillRect(0, 240, W, 120);
    }
    // 平台价格：best = 最大折扣
    var plats = (Array.isArray(b.prices) && b.prices.length) ? b.prices : [];
    var best = plats.length ? plats[0] : null;
    var origin = best && best.origin_price ? best.origin_price : (b.origin_price || 0);
    var price = best && best.price ? best.price : (b.price || 0);
    var off = "";
    if (origin > 0 && price > 0 && price < origin) off = "-" + Math.round((1 - price / origin) * 100) + "%";

    // 标题：自适应字号（≤2 行居中，不超 600）
    var name = String(b.name || "");
    function fitTitle() {
      for (var fs = 52; fs >= 28; fs -= 4) {
        ctx.font = "800 " + fs + "px 'PingFang SC',sans-serif";
        var ls = wrapText(ctx, name, 600);
        var mx = 0;
        for (var i = 0; i < ls.length; i++) mx = Math.max(mx, ctx.measureText(ls[i]).width);
        if (ls.length <= 2 && mx <= 600) return { size: fs, lines: ls };
      }
      ctx.font = "800 28px 'PingFang SC',sans-serif";
      return { size: 28, lines: wrapText(ctx, name, 600).slice(0, 2) };
    }
    var fit = fitTitle();
    var ty = 440;
    for (var ti = 0; ti < fit.lines.length; ti++) { ctx.fillStyle = "#fff"; ctx.fillText(fit.lines[ti], 360, ty + ti * (fit.size + 8)); }
    var blockBottom = ty + (fit.lines.length - 1) * (fit.size + 8);
    if (b.en_name) {
      var enTxt = String(b.en_name);
      ctx.fillStyle = "#d4af37"; ctx.font = "22px Georgia";
      if (ctx.measureText(enTxt).width > 560) { while (ctx.measureText(enTxt + "…").width > 560 && enTxt.length > 1) enTxt = enTxt.slice(0, -1); enTxt += "…"; }
      ctx.fillText(enTxt, 360, blockBottom + 32);
      blockBottom += 36;
    }
    // 主价格区
    var mainPriceY = Math.max(blockBottom + 40, 588);
    if (origin > 0) {
      ctx.font = "28px 'PingFang SC',sans-serif"; ctx.fillStyle = "#b5b5b5";
      ctx.fillText("¥" + origin, 360, mainPriceY);
      var w0 = ctx.measureText("¥" + origin).width;
      ctx.strokeStyle = "#b5b5b5"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(360 - w0 / 2, mainPriceY - 10); ctx.lineTo(360 + w0 / 2, mainPriceY - 10); ctx.stroke();
      mainPriceY += 70;
    }
    var pTxt = "";
    if (price > 0) {
      pTxt = "¥" + price;
      var pFs = pTxt.length > 7 ? 66 : 92;
      ctx.font = "900 " + pFs + "px Arial,'PingFang SC',sans-serif";
      ctx.fillStyle = "#ffd23f"; ctx.fillText(pTxt, 360, mainPriceY);
      // -XX% 斜红框：紧贴价格右侧，垂直对齐价格字高中间
      if (off) {
        var priceW = ctx.measureText(pTxt).width;
        ctx.save();
        ctx.translate(360 + priceW / 2 + 18, mainPriceY - (pFs > 70 ? 34 : 26));
        ctx.rotate(8 * Math.PI / 180);
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        var bg2 = ctx.createLinearGradient(0, -30, 0, 30);
        bg2.addColorStop(0, "#ff5f3a"); bg2.addColorStop(1, "#d92626");
        ctx.fillStyle = bg2; roundRectPath(ctx, -38, -28, 76, 56, 12); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.font = "900 30px Arial"; ctx.fillText(off, 0, 2);
        ctx.restore();
        ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      }
    }
    // 顶部 chips：金色文本星号评分 + 淡蓝剩余时间
    var chips = [];
    if (b.rating) chips.push({ text: "★ " + b.rating, color: "#ffd23f" });
    if (b.remaining) chips.push({ text: String(b.remaining), color: "#a8c7e8" });
    var chipY = mainPriceY + 42;
    if (chips.length) {
      ctx.font = "800 24px 'PingFang SC',sans-serif";
      var cws = [], ctw = 0;
      for (var ci = 0; ci < chips.length; ci++) { cws.push(ctx.measureText(chips[ci].text).width + 36); ctw += cws[ci] + 10; }
      var cxx = 360 - (ctw - 10) / 2;
      for (var cj = 0; cj < chips.length; cj++) {
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        roundRectPath(ctx, cxx, chipY - 24, cws[cj], 42, 21); ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1;
        roundRectPath(ctx, cxx, chipY - 24, cws[cj], 42, 21); ctx.stroke();
        ctx.fillStyle = chips[cj].color; ctx.fillText(chips[cj].text, cxx + cws[cj] / 2, chipY);
        cxx += cws[cj] + 10;
      }
    }
    // 平台价格：2 列网格面板（整齐不溢出）
    var bandTop = Math.max(chipY + 34, mainPriceY + 74);
    if (plats.length) {
      var items = [];
      for (var ik = 0; ik < plats.length; ik++) {
        var it = plats[ik];
        if (!it || !it.name) continue;
        items.push({ name: String(it.name), originP: it.origin_price || 0, price: it.price || 0, offP: it.off_pct || 0, best: ik === 0 });
      }
      var maxShow = 8, shown = items.slice(0, maxShow);
      var cols = 2, colGap = 40;
      var panelW = 560, cellW = (panelW - colGap) / 2; // 260
      var cellH = 40;
      var rows = Math.ceil(shown.length / cols);
      var panelH = rows * cellH;
      var panelX = 360 - panelW / 2;
      var panelY = bandTop;
      // 面板底
      ctx.fillStyle = "rgba(20,22,28,0.72)";
      roundRectPath(ctx, panelX - 14, panelY - 12, panelW + 28, panelH + 24, 14); ctx.fill();
      ctx.font = "22px 'PingFang SC',sans-serif";
      for (var ri = 0; ri < shown.length; ri++) {
        var itm = shown[ri];
        var cx = panelX + (ri % cols) * (cellW + colGap) + cellW / 2;
        var cy = panelY + Math.floor(ri / cols) * cellH + cellH / 2;
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        // 平台名（最多约 7 字，超长省略）
        var nameW = cellW * 0.42;
        var nm = itm.name;
        while (ctx.measureText(nm + "…").width > nameW && Array.from(nm).length > 1) nm = Array.from(nm).slice(0, -1).join("");
        if (nm !== itm.name) nm += "…";
        ctx.fillStyle = itm.best ? "#ffd23f" : "#e3e7ee";
        ctx.font = "800 " + (itm.best ? 23 : 21) + "px 'PingFang SC',sans-serif";
        var nameLeft = cx - cellW / 2 + 4;
        var nameWpx = ctx.measureText(nm).width; // 用名字当前字号量，避免切换字体后量错导致重叠
        ctx.fillText(nm, nameLeft, cy);
        if (itm.best && itm.offP > 0) {
          // 史低：红字无背景，紧跟名字右侧
          ctx.fillStyle = "#ff5252"; ctx.font = "800 14px 'PingFang SC',sans-serif";
          ctx.fillText("史低", nameLeft + nameWpx + 6, cy);
        }
        ctx.font = "22px 'PingFang SC',sans-serif";
        // 价格右对齐到 cell 右侧：now + old（不显示平台折扣百分比）
        var priceX = cx + cellW / 2 - 6;
        var px = priceX;
        ctx.fillStyle = "#ffd23f"; ctx.font = "800 21px Arial,'PingFang SC',sans-serif";
        var nowT = "¥" + itm.price;
        ctx.fillText(nowT, px - ctx.measureText(nowT).width, cy);
        px -= ctx.measureText(nowT).width + 10;
        if (itm.originP > 0 && itm.originP > itm.price) {
          ctx.font = "15px 'PingFang SC',sans-serif"; ctx.fillStyle = "#8a93a3";
          var oldT = "¥" + itm.originP;
          var ow = ctx.measureText(oldT).width;
          ctx.fillText(oldT, px - ow, cy);
          ctx.strokeStyle = "#8a93a3"; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px - ow, cy + 1); ctx.lineTo(px, cy + 1); ctx.stroke();
          px -= ow + 8;
        }
      }
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      bandTop = panelY + panelH + 8;
      if (items.length > maxShow) {
        ctx.font = "18px 'PingFang SC',sans-serif"; ctx.fillStyle = "#7a828e";
        ctx.fillText("…等 " + items.length + " 个平台在售", 360, bandTop + 14);
        bandTop += 26;
      }
    }
    // footer
    var fy = Math.max(bandTop + 4, 848);
    ctx.strokeStyle = "#3d2424"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(140, fy); ctx.lineTo(580, fy); ctx.stroke();
    ctx.fillStyle = "#6d6d6d"; ctx.font = "20px 'PingFang SC',sans-serif";
    ctx.fillText("由 Stray 查价生成 · 数据实时查询", 360, fy + 34);
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
    loadImage(safeUrl(block.cover)).then(function (img) {
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
      try { pimg.src = canvas.toDataURL("image/png"); } catch (e) { /* 忽略 */ }
      bodyEl.appendChild(wrap);
      scrollToBottom();
      wrap.querySelector('[data-act="save"]').addEventListener("click", function () { downloadCanvas(canvas); });
      wrap.querySelector('[data-act="copy"]').addEventListener("click", function () { copyCanvas(canvas); });
      if (onDone) setTimeout(onDone, 150);
    });
  }
  function openPoster(block) {
    loadImage(safeUrl(block.cover)).then(function (img) {
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