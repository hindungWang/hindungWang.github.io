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
    replyMode: "sync",
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
    div.textContent = text;
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
      return mockReply(text);
    }

    var url = CONFIG.baseUrl.replace(/\/+$/, "") + CONFIG.chatEndpoint;
    var resp = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ message: text })
    });

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
    if (typeof data.reply === "string") return data.reply;
    if (data.reply) return JSON.stringify(data.reply);
    if (data.error) throw new Error(data.error);
    return JSON.stringify(data);
  }

  async function pollReply(id) {
    if (!id) throw new Error("网关未返回任务 id");
    var url = CONFIG.baseUrl.replace(/\/+$/, "") + (CONFIG.replyEndpoint || CONFIG.chatEndpoint) + "?id=" + encodeURIComponent(id);
    var deadline = Date.now() + CONFIG.pollTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(CONFIG.pollIntervalMs);
      var resp = await fetch(url, { headers: headers() });
      if (!resp.ok) continue;
      var data = await resp.json().catch(function () { return {}; });
      if (typeof data.reply === "string") return data.reply;
      if (data.status === "done" && data.result) return data.result;
    }
    throw new Error("等待回复超时，请重试。");
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- 演示模式（网关未实现时的本地模拟回复） ---------- */
  function mockReply(text) {
    var t = text.toLowerCase();
    if (t.indexOf("start") !== -1 || t.indexOf("开始") !== -1 || t.indexOf("开局") !== -1 || t.indexOf("新一局") !== -1) {
      return "好的，新一局已开始，轮到你行动。直接告诉我你的第一步即可。\n（演示模式：接上真实网关后这里会是 Agent 的真实开局流程）";
    }
    if (t.indexOf("走") !== -1 || t.indexOf("棋") !== -1 || t.indexOf("move") !== -1 || t.indexOf("行动") !== -1) {
      return "收到，这一步有效。当前棋盘共 12 子，轮到你继续。\n（演示模式：仅展示交互效果，不落真子）";
    }
    if (t.indexOf("局面") !== -1 || t.indexOf("状态") !== -1 || t.indexOf("status") !== -1 || t.indexOf("多少") !== -1) {
      return "当前局面：双方势均力敌，Agent 综合胜率评估约 52%。\n建议：优先控制中心区域，保持两条进攻线路。\n（演示模式：评估结果为模拟数据）";
    }
    if (t.indexOf("教") !== -1 || t.indexOf("help") !== -1 || t.indexOf("怎么") !== -1 || t.indexOf("规则") !== -1) {
      return "基础规则：轮流行动，每次一步；先达成目标的一方获胜。\n战术建议：开局抢占中心、中期兼顾攻守。\n输入「走一步」或「当前局面怎么样」可以继续。";
    }
    return "收到：「" + text + "」。\n（演示模式）真实网关尚未接入，接好后这里会返回 Game Agent 的实际回复。";
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
      .then(function (reply) {
        typing.remove();
        appendMsg("agent", reply);
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

  sendBtn.addEventListener("click", onSend);
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  inputEl.addEventListener("input", autoGrow);
})();