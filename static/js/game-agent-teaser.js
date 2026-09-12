/* 首页 Game Agent 演示卡 —— 自动播放脚本化对话（结论 → 迷你卡片），点击进入体验页。
   数据取自真实接口返回（双人成行 / 艾尔登法环），不联网、不依赖后端。 */
(function () {
  "use strict";

  var el = document.getElementById("game-agent-teaser");
  if (!el) return;
  var TARGET = "/game-agent/";

  var CARDS = {
    itt: {
      name: "双人成行", en: "It Takes Two",
      price: 59.4, origin: 198,
      chips: ["⭐ 9.8", "好评率 95%", "平均 20.6h", "🏆 TGA 2021 年度最佳游戏"],
      plats: [
        { name: "EPIC", price: 59.4, off: 70, best: true },
        { name: "STEAM", price: 198 },
        { name: "PS4", price: 272.83 }
      ],
      lowest: "史低 ¥39.6 · 2024-12-12"
    },
    er: {
      name: "艾尔登法环", en: "ELDEN RING",
      price: 152.08, origin: 298,
      chips: ["⭐ 9.6", "DLC × 6", "好评率 93%", "中文"],
      plats: [
        { name: "XBOX", price: 152.08, best: true },
        { name: "STEAM", price: 298 },
        { name: "PS4", price: 409.93 }
      ],
      lowest: "史低 ¥178.8 · 2023-12-22"
    }
  };

  /* 脚本：q=用户提问，say=agent 结论，card=要展示的卡片（真实数据） */
  var SCRIPT = [
    { q: "双人成行现在多少钱", say: "全平台最低 **¥59.4**（Epic 打 7 折），Steam 还是原价 ¥198。", card: "itt" },
    { q: "艾尔登法环呢", say: "最低 **¥152.08** 在 Xbox；Steam ¥298、PS4 ¥409.93 都没折。", card: "er" }
  ];

  var body = el.querySelector("#gact-body");
  var TYPE_MS = 14, HOLD_MS = 3200, FADE_MS = 420;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function elMsg(role) {
    var d = document.createElement("div");
    d.className = "gact-msg " + role;
    body.appendChild(d);
    scrollTeaser();
    return d;
  }

  function scrollTeaser() {
    /* 演示卡自身不滚动（固定高度），内容多了只显示最新的 */
    var max = 3;   // 同时只留 3 条：提问 → 结论 → 卡片（循环时旧的自动滚出）
    while (body.children.length > max) body.removeChild(body.firstChild);
  }

  async function typeInto(node, text, per) {
    var html = String(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    /* 逐字：按纯文本走，插入 <b> 时整段替换，避免拆坏标签 */
    var plain = String(text).replace(/\*\*/g, "");
    var step = per || TYPE_MS;
    var caret = document.createElement("span");
    caret.className = "gact-caret";
    node.appendChild(caret);
    for (var i = 1; i <= plain.length; i++) {
      var shown = plain.slice(0, i);
      /* 用纯文本逐字，结束后再套加粗（视觉上够用且稳定） */
      node.textContent = shown;
      node.appendChild(caret);
      await sleep(step);
    }
    node.innerHTML = html;
  }

  function cardNode(c) {
    var d = document.createElement("div");
    d.className = "gact-card";
    var off = c.origin > c.price ? "-" + Math.round((1 - c.price / c.origin) * 100) + "%" : "";
    var h = '<div class="gact-card-head">' +
      '<div class="gact-card-titles"><div class="gact-card-name">' + c.name + '</div>' +
      '<div class="gact-card-en">' + c.en + '</div></div>' +
      '<div class="gact-card-price"><span class="gact-card-old">¥' + c.origin + '</span>' +
      '<span class="gact-card-now">¥' + c.price + '</span></div></div>';
    h += '<div class="gact-card-chips">';
    for (var i = 0; i < c.chips.length; i++) {
      var cls = c.chips[i].indexOf("🏆") === 0 ? "gact-chip gact-chip-award" : "gact-chip";
      h += '<span class="' + cls + '">' + c.chips[i] + '</span>';
    }
    if (off) h += '<span class="gact-chip gact-chip-off">' + off + '</span>';
    h += "</div>";
    h += '<div class="gact-card-plats">';
    for (var j = 0; j < c.plats.length; j++) {
      var p = c.plats[j];
      h += '<div class="gact-plat' + (p.best ? " best" : "") + '">' +
        '<span class="gact-plat-name">' + p.name + '</span>' +
        (p.off ? '<span class="gact-plat-off">-' + p.off + '%</span>' : "") +
        '<span class="gact-plat-now">¥' + p.price + '</span>' +
        (p.best ? '<span class="gact-plat-best">最低</span>' : "") +
        "</div>";
    }
    h += "</div>";
    h += '<div class="gact-card-lowest">' + c.lowest + "</div>";
    d.innerHTML = h;
    return d;
  }

  async function playTurn(item) {
    var u = elMsg("user");
    await typeInto(u, item.q, 22);
    await sleep(260);
    var a = elMsg("agent");
    await sleep(300);
    await typeInto(a, item.say);
    if (item.card) {
      var c = cardNode(CARDS[item.card]);
      c.style.opacity = "0";
      body.appendChild(c);
      scrollTeaser();
      await sleep(60);
      c.style.transition = "opacity .35s ease, transform .35s ease";
      c.style.transform = "translateY(6px)";
      c.style.opacity = "1";
      c.style.transform = "none";
    }
  }

  async function play() {
    body.innerHTML = "";
    await sleep(420);
    for (var i = 0; i < SCRIPT.length; i++) await playTurn(SCRIPT[i]);
    await sleep(HOLD_MS);
    body.style.transition = "opacity " + FADE_MS + "ms";
    body.style.opacity = "0";
    await sleep(FADE_MS + 40);
    body.style.opacity = "";
    body.style.transition = "";
    play();
  }

  el.addEventListener("click", function () { location.href = TARGET; });
  el.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); location.href = TARGET; }
  });

  play();
})();
