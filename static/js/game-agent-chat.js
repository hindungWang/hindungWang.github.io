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
    ctx.textBaseline = "alphabetic";
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
    // 平台价格（优先 prices 数组，最大折扣=第一个）
    var plats = Array.isArray(b.prices) && b.prices.length ? b.prices : [];
    var best = null;
    if (plats.length) best = plats[0];
    var origin = best && best.origin_price ? best.origin_price : (b.origin_price || 0);
    var price = best && best.price ? best.price : (b.price || 0);
    var off = "";
    if (origin > 0 && price > 0 && price < origin) off = "-" + Math.round((1 - price / origin) * 100) + "%";
    // 折扣角标
    if (off) {
      ctx.save(); ctx.translate(642, 96); ctx.rotate(8 * Math.PI / 180);
      var bg2 = ctx.createLinearGradient(0, -72, 0, 72);
      bg2.addColorStop(0, "#ff5f3a"); bg2.addColorStop(1, "#d92626");
      ctx.fillStyle = bg2; roundRectPath(ctx, -72, -72, 144, 144, 26); ctx.fill();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff"; ctx.font = "900 46px Arial"; ctx.fillText(off, 0, -8);
      ctx.fillStyle = "#ffe9e9"; ctx.font = "22px 'PingFang SC',sans-serif"; ctx.fillText("限时特惠", 0, 38);
      ctx.restore();
    }
    ctx.textBaseline = "alphabetic";
    // 标题（可换行）
    var name = String(b.name || "");
    var nameFont = Array.from(name).length > 12 ? 40 : 52;
    ctx.font = "800 " + nameFont + "px 'PingFang SC',sans-serif";
    var nameLines = wrapText(ctx, name, 640);
    if (nameLines.length > 1 && nameFont === 52) { nameFont = 40; ctx.font = "800 40px 'PingFang SC',sans-serif"; nameLines = wrapText(ctx, name, 640); }
    var ty = nameLines.length > 1 ? 430 : 462;
    for (var i = 0; i < nameLines.length; i++) { ctx.fillStyle = "#fff"; ctx.fillText(nameLines[i], 360, ty + i * (nameFont + 8)); }
    var blockBottom = ty + (nameLines.length - 1) * (nameFont + 8);
    // 英文名
    if (b.en_name) { ctx.fillStyle = "#d4af37"; ctx.font = "22px Georgia"; ctx.fillText(String(b.en_name), 360, blockBottom + 36); blockBottom += 40; }
    // 主价格：原价（划线）→ 现价大字
    var mainPriceY = Math.max(blockBottom + 46, 585);
    if (origin > 0) {
      ctx.font = "28px 'PingFang SC',sans-serif"; ctx.fillStyle = "#b5b5b5"; ctx.textAlign = "center";
      ctx.fillText("¥" + origin, 360, mainPriceY);
      var w0 = ctx.measureText("¥" + origin).width;
      ctx.strokeStyle = "#b5b5b5"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(360 - w0 / 2, mainPriceY - 10); ctx.lineTo(360 + w0 / 2, mainPriceY - 10); ctx.stroke();
      mainPriceY += 74;
    }
    if (price > 0) {
      ctx.font = "900 92px Arial,'PingFang SC',sans-serif"; ctx.fillStyle = "#ffd23f"; ctx.textAlign = "center";
      ctx.fillText("¥" + price, 360, mainPriceY);
    }
    // 顶部 chips：评分 + 剩余时间（平台移到底部胶囊区）
    var chips = [];
    if (b.rating) chips.push("⭐ " + b.rating);
    if (b.remaining) chips.push("⏳ " + b.remaining);
    var chipY = mainPriceY + 52;
    if (chips.length) {
      ctx.font = "24px 'PingFang SC',sans-serif";
      var tw = 0, cws = [];
      for (var ci = 0; ci < chips.length; ci++) { cws.push(Array.from(chips[ci]).length * 15 + 36); tw += cws[ci] + 10; }
      var cxx = 360 - (tw - 10) / 2;
      for (var cj = 0; cj < chips.length; cj++) {
        ctx.fillStyle = "#2a313c"; roundRectPath(ctx, cxx, chipY - 24, cws[cj], 40, 20); ctx.fill();
        ctx.fillStyle = "#e8e8e8"; ctx.textAlign = "center"; ctx.fillText(chips[cj], cxx + cws[cj] / 2, chipY);
        cxx += cws[cj] + 10;
      }
    }
    // 平台价格胶囊（流式换行，最大折扣金色高亮；非罗列）
    var bandY = Math.max(mainPriceY + 92, chipY + 34);
    if (plats.length) {
      ctx.font = "25px 'PingFang SC',sans-serif";
      var items = [];
      for (var k = 0; k < plats.length; k++) {
        var r = plats[k];
        if (!r || !r.name) continue;
        var txt = String(r.name) + " ¥" + (r.price || 0);
        items.push({ name: String(r.name), txt: txt, off: r.off_pct || 0, best: k === 0 });
      }
      // 流式换行：每行 ≤ 620 宽，行高 52
      var maxLineW = 620, pad = 26, gap = 14;
      var lines = [], line = [], lineW = 0;
      for (var li = 0; li < items.length; li++) {
        var it = items[li];
        var wIt = ctx.measureText(it.txt).width + pad * 2;
        if (line.length && lineW + gap + wIt > maxLineW) { lines.push({ items: line, w: lineW }); line = []; lineW = 0; }
        line.push(it); lineW += (line.length > 1 ? gap : 0) + wIt;
      }
      if (line.length) lines.push({ items: line, w: lineW });
      // 最多 3 行，超出截断
      var showLines = lines.slice(0, 3);
      var rowH = 54, startY = bandY;
      for (var ri = 0; ri < showLines.length; ri++) {
        var ln = showLines[ri];
        var x = 360 - ln.w / 2;
        for (var ii = 0; ii < ln.items.length; ii++) {
          var itm = ln.items[ii];
          var wP = ctx.measureText(itm.txt).width + pad * 2;
          ctx.fillStyle = itm.best ? "rgba(255,210,63,0.14)" : "#262b35";
          roundRectPath(ctx, x, startY, wP, 44, 22); ctx.fill();
          if (itm.best) { ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 2; roundRectPath(ctx, x, startY, wP, 44, 22); ctx.stroke(); }
          ctx.fillStyle = itm.best ? "#ffd23f" : "#d7dbe2"; ctx.textAlign = "left";
          ctx.fillText(itm.txt, x + pad, startY + 29);
          if (itm.off > 0) {
            var offTxt = "-" + itm.off + "%";
            var wx = x + pad + ctx.measureText(itm.txt).width + 10;
            ctx.fillStyle = "#ff6b6b"; ctx.font = "900 22px Arial";
            ctx.fillText(offTxt, wx, startY + 28);
            ctx.font = "25px 'PingFang SC',sans-serif";
          }
          x += wP + gap;
        }
        startY += rowH;
      }
      bandY = startY;
    }
    // footer
    ctx.textAlign = "center";
    var fy = Math.max(bandY + 8, 872);
    ctx.strokeStyle = "#3d2424"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(140, fy); ctx.lineTo(580, fy); ctx.stroke();
    ctx.fillStyle = "#6d6d6d"; ctx.font = "22px 'PingFang SC',sans-serif";
    ctx.fillText("由 Stray 查价生成 · 数据实时查询", 360, fy + 42);
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
      drawPoster(canvas, block, img);
      overlay.querySelector(".gac-poster-close").addEventListener("click", function () { overlay.remove(); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });
      overlay.querySelector('[data-act="save"]').addEventListener("click", function () {
        downloadCanvas(canvas);
      });
      overlay.querySelector('[data-act="copy"]').addEventListener("click", function () {
        copyCanvas(canvas);
      });
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