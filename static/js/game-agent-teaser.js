/* 首页 Game Agent 演示卡 —— 自动播放脚本化对话，点击跳转体验页 */
(function () {
  "use strict";

  var el = document.getElementById("game-agent-teaser");
  if (!el) return;

  var TARGET = "/game-agent/";

  var SCRIPT = [
    { role: "user", text: "红色沙漠现在多少钱" },
    { role: "agent", text: "🎮 红色沙漠 价格信息\n\n💰 当前各平台售价：\n🔸 Steam：¥268\n🔸 Epic：¥268\n🔸 XSX|S：¥331.7\n🔸 PS5：¥492.3\n\n📊 游戏信息：\n⭐ 玩家评分：6.09（161条评论）\n🎯 媒体评分：二柄/Steam 7.9 | IGN 6 | GameSpot 7 | IGN日本 8\n\n⚠️ 目前没有折扣，都是原价\n\n📌 说实话评分有点低，口碑比较两极分化。如果你喜欢开放世界动作游戏，可以等等看后续更新和打折，或者先看看评测视频再决定要不要入手！" },
    { role: "user", text: "黑神话 二郎神怎么打" },
    { role: "agent", text: "二郎神杨戬是黑神话悟空的隐藏BOSS，难度不低，给你整理一份打法攻略👇\n\n📌 前置条件（解锁杨戬）\n▪️ 解锁四张隐藏地图：旧观音禅院、斯哈里国、紫云山、碧水洞\n▪️ 分别击败金池长老、蝜蝂、晦月魔君、避水金睛兽\n▪️ 在瓜田与翠笠武师对战并获胜\n▪️ 全部完成后回浮屠塔触发小弥勒剧情，即可解锁杨戬\n\n⚔️ 战斗阶段解析\n\n🔸 第一阶段（破盾+输出）\n▪️ 杨戬投技前摇明显，翻滚或格挡躲避\n▪️ 冲刺枪攻击：先拉开距离再翻滚，同时注意闪避他召唤的哮天犬扑击\n▪️ 杨戬释放定身术时，立刻用点满天赋的棍花全力输出，能打掉约70%护盾\n▪️ 剩余护盾用蓄力重击破除\n▪️ 芭蕉扇加速贴近 → 两套轻棍连击 → 蓄力重棍，第一阶段基本就能过\n\n🔸 第二阶段\n▪️ 杨戬攻击频率和范围增大，注意保持距离观察出招\n▪️ 用芭蕉扇龙卷风推着杨戬后退，配合搅棍打法连续打硬直\n▪️ 墙角压制效果极佳，戳棍搅阵流可以让杨戬起不来\n\n🔸 第三阶段\n▪️ 杨戬会开大招，伤害极高，务必留好闪避体力\n▪️ 可以召唤猴子猴孙分散火力（正义群殴流）\n▪️ 抓住硬直窗口集中爆发输出\n\n🎯 推荐流派\n\n🔹 芭蕉扇+重棍流（新手推荐）\n芭蕉扇加速贴脸 → 轻棍连击 → 蓄力重棍，循环往复\n\n🔹 戳棍搅阵流\n破盾后用戳棍搅阵压制，把杨戬堵墙角效果拉满\n\n🔹 禁字法无伤流\n高手向，纯靠闪避和普攻无伤通关\n\n📌 打完杨戬之后\n▪️ 触发CG动画，进入四天王战斗（相对简单）\n▪️ 之后推进主线击败大圣残躯\n▪️ 解锁隐藏结局“杨戬无金箍形态”\n▪️ 奖励包括石猿变身和杨戬武器，非常值得挑战💪\n\n核心思路就是破盾优先，芭蕉扇是神器，多用翻滚躲投技，别贪刀就行🎮" },
  ];

  var body = el.querySelector("#gact-body");
  var typingMs = 380;      // 打字指示停留
  var typeCharMs = 6;     // 逐字显示间隔
  var holdEndMs = 2600;    // 播完停留

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function clear() { body.innerHTML = ""; }

  function addNode(className) {
    var d = document.createElement("div");
    d.className = "gact-msg " + className;
    body.appendChild(d);
    return d;
  }

  async function typeInto(node, text, ms) {
    var step = ms == null ? typeCharMs : ms;
    for (var i = 0; i < text.length; i++) {
      node.textContent = text.slice(0, i + 1);
      await sleep(step);
    }
  }

  async function playTurn(item) {
    var node = addNode(item.role);
    // 用户消息也用打字机逐字呈现，节奏稍快
    var delay = item.role === "user" ? typeCharMs * 1.5 : 0;
    if (item.role === "user") {
      await typeInto(node, item.text, delay);
      await sleep(280);
      return;
    }
    await sleep(typingMs);
    await typeInto(node, item.text);
  }

  async function play() {
    clear();
    await sleep(400);
    for (var i = 0; i < SCRIPT.length; i++) {
      await playTurn(SCRIPT[i]);
    }
    await sleep(holdEndMs);
    // 淡出后重新播放（无限循环）
    body.style.opacity = "0";
    body.style.transition = "opacity 0.4s";
    await sleep(420);
    body.style.opacity = "";
    clear();
    play();
  }

  // 点击 / 回车 → 跳转体验页
  el.addEventListener("click", function () { location.href = TARGET; });
  el.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); location.href = TARGET; }
  });

  // 跟随主题深色模式
  (function watchTheme() {
    var themeLink = document.getElementById("dark-theme");
    function apply() {
      var dark = themeLink
        ? themeLink.disabled !== true
        : !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      el.classList.toggle("gact-dark", dark);
    }
    apply();
    if (themeLink) {
      new MutationObserver(apply).observe(themeLink, { attributes: true, attributeFilter: ["disabled"] });
    }
  })();

  play();
})();