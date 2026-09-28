/**
 * dsh-llm-workbuddy — 浏览器端（客户端）插件
 *
 * DSH 会把一个声明了 `dsh.client`（platform: web）的包视作 client-module：
 * 它把本文件编译/服务为 /plugins/dsh-llm-workbuddy/client.js 并以 classic
 * script 注入。client-modules 加载器（@deepseek-ai/dsh-client-modules）要求
 * 这种 bundle 在脚本执行时只做一件事——调用
 * `window.__ModuleLoader__.load({ id, factory })` 注册自己（工厂是惰性的，
 * 不能执行副作用）。之后加载器会物化 factory，并调用其返回模块面的
 * `apply(ctx)` 来激活这个客户端插件。
 *
 * 因此这里用一个标准的 Cordis 客户端插件面（{ name, apply }）作为模块内容，
 * 最后用 __ModuleLoader__.load 把它注册给加载器——这是「无构建、零依赖」
 * 环境下最贴近官方 defineClient 产物的一种写法（官方构建产物本质上也是
 * 把 { name, apply } 包进 load 注册）。
 */
window.__ModuleLoader__.load({
  id: "dsh-llm-workbuddy",
  factory: function () {
    "use strict";

    return {
      /** 与服务器端插件同名，便于在浏览器端 Cordis 中辨识。 */
      name: "llm-workbuddy",

      /**
       * 客户端插件入口。DSH 在浏览器端激活本插件时调用。
       *
       * 负责在 Web GUI 右下角注入一个常驻状态小圆点：轮询
       * GET /api/workbuddy/status 显示绿/红登录态；点击「登录」会调用
       * POST /api/workbuddy/login，打开返回的 device-flow authUrl，并持续
       * 轮询直到会话 authenticated。
       *
       * 挂载与 DOM 清理都登记在 `ctx.effect` 上：客户端的 client-hmr 会在本
       * 文件改动后热重载插件并重新 apply()，没有清理就会叠出第二个胶囊和第二个
       * 轮询定时器。
       *
       * @param {object} ctx 浏览器端 Cordis 根 Context。只用来按需读取
       *   `sidebarRight` / `webTerminals`（内置终端）；不声明 inject，
       *   这样即使某个界面没有终端插件，登录胶囊依然可用。
       */
      apply: function (ctx) {
        if (ctx && typeof ctx.effect === "function") {
          ctx.effect(function () { return startWidget(ctx); }, "dsh-llm-workbuddy.widget");
          return;
        }
        startWidget(ctx);
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Widget 实现
// ---------------------------------------------------------------------------

var POLL_MS = 5000;
var LOGIN_POLL_MS = 2000;
var LOGIN_POLLS = 30;

/**
 * 插件激活后、DOM 就绪时开始挂载 widget。
 * @returns {function(): void} 卸载函数（DOM 未就绪时取消待挂载的监听）。
 */
function startWidget(ctx) {
  if (document.readyState === "loading") {
    var onReady = function () { runWidget(ctx); };
    document.addEventListener("DOMContentLoaded", onReady, { once: true });
    return function () { document.removeEventListener("DOMContentLoaded", onReady); };
  }
  return runWidget(ctx);
}

/**
 * 真正的 widget 逻辑：注入样式、渲染状态条、轮询、登录。
 * @returns {function(): void} 卸载函数：停轮询、摘监听、移除胶囊/样式/浮层。
 */
function runWidget(ctx) {
  // 上一次挂载若没走卸载（旧版本热重载）会留下同名节点，先清掉再挂，避免叠影。
  // 用 querySelectorAll 而不是 getElementById：历史上可能已经叠了不止一个。
  var staleHosts = document.querySelectorAll("#wb-status-host");
  for (var i = 0; i < staleHosts.length; i += 1) staleHosts[i].remove();
  var staleStyles = document.querySelectorAll("#wb-status-style");
  for (var j = 0; j < staleStyles.length; j += 1) staleStyles[j].remove();

  var host = document.createElement("div");
  host.id = "wb-status-host";
  host.style.cssText =
    "position:fixed;right:12px;bottom:12px;z-index:2147483647;" +
    "font:12px/1.4 system-ui,-apple-system,sans-serif;";

  var style = document.createElement("style");
  style.id = "wb-status-style";
  style.textContent =
    ".wb-pill{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;" +
    "background:#111827;color:#e5e7eb;box-shadow:0 2px 8px rgba(0,0,0,.35);" +
    // 胶囊本身就是拖动手柄：光标与 touch-action 都在这里声明，按钮单独恢复成 pointer。
    "cursor:grab;touch-action:none;-webkit-user-select:none;user-select:none;}" +
    "#wb-status-host.wb-host--dragging .wb-pill{cursor:grabbing;}" +
    ".wb-pill button{cursor:pointer;}" +
    ".wb-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af;}" +
    ".wb-pill--ok .wb-dot{background:#22c55e;}" +
    ".wb-pill--warn .wb-dot{background:#f59e0b;}" +
    ".wb-pill--bad .wb-dot{background:#ef4444;}" +
    ".wb-btn{margin-left:4px;border:0;border-radius:6px;background:#2563eb;color:#fff;" +
    "padding:3px 8px;cursor:pointer;font:inherit;}" +
    ".wb-btn:disabled{opacity:.6;cursor:default;}" +
    ".wb-actions{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;}" +
    ".wb-actions .wb-btn{margin-left:0;}" +
    ".wb-warn{margin-left:6px;color:#f59e0b;font-size:11px;}" +
    ".wb-settle{position:relative;}" +
    ".wb-setbtn{margin-left:4px;border:0;border-radius:6px;background:#374151;color:#e5e7eb;" +
    "padding:3px 8px;cursor:pointer;font:inherit;}" +
    ".wb-menu{position:absolute;right:0;bottom:38px;display:flex;flex-direction:column;gap:4px;" +
    "background:#0f172a;border:1px solid #334155;border-radius:8px;padding:6px;min-width:148px;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.5);}" +
    ".wb-menu .wb-item{display:flex;align-items:center;gap:6px;width:100%;text-align:left;" +
    "border:0;border-radius:6px;background:#1e293b;color:#e2e8f0;padding:6px 8px;cursor:pointer;" +
    "font:inherit;white-space:nowrap;}" +
    ".wb-menu .wb-item:hover{background:#334155;}" +
    ".wb-menu .wb-item .wb-ico{font-size:13px;}" +
    ".wb-menu .wb-item:disabled{opacity:.6;cursor:default;}" +
    ".wb-panel{position:fixed;right:12px;bottom:44px;z-index:2147483647;width:340px;max-height:340px;overflow:auto;" +
    "background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:10px;" +
    "font:12px/1.5 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.5);}" +
    ".wb-panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}" +
    ".wb-panel-head .wb-ttl{font-weight:700;}" +
    ".wb-panel .wb-close{border:0;background:transparent;color:#94a3b8;cursor:pointer;" +
    "font-size:14px;line-height:1;padding:2px 6px;border-radius:4px;}" +
    ".wb-panel .wb-close:hover{background:#1e293b;color:#e2e8f0;}";
  document.head.appendChild(style);
  document.body.appendChild(host);

  var status = null;
  var busy = false;
  var timer = null;
  var menuOpen = false;
  /** 当前打开的浮层关闭函数（卸载时统一关掉，避免留下孤儿浮层）。 */
  var openPanels = [];

  function fmtExpiry(expiresAt) {
    if (!expiresAt) return "";
    try { return new Date(expiresAt).toLocaleString(); }
    catch (e) { return ""; }
  }

  function render() {
    if (!status) {
      host.innerHTML = '<div class="wb-pill wb-pill--bad">WorkBuddy · …</div>';
      return;
    }
    var authed = Boolean(status.authenticated);
    var proxyUp = Boolean(status.proxyUp);
    // 三态：会话无效 = 红色「未登录」；会话有效但代理没响应 = 黄色「代理未响应」。
    // 旧版把这两种情况都写成「未登录」，一次 2 秒的探测抖动就会误报成掉登录。
    var state = !authed ? "bad" : proxyUp ? "ok" : "warn";
    var label = state === "ok"
      ? "WorkBuddy · " + (status.account && (status.account.nickname || status.account.uid) || "已登录")
      : state === "warn"
        ? "WorkBuddy · 代理未响应"
        : "WorkBuddy · 未登录";
    var html =
      '<div class="wb-pill wb-pill--' + state + '">' +
      '<span class="wb-dot"></span>' +
      '<span class="wb-label">' + label + "</span>";
    if (state === "bad") {
      var disabled = busy || !status.loginScriptAvailable ? " disabled" : "";
      html += '<button class="wb-btn" id="wb-login"' + disabled + ">" +
        (busy ? "登录中…" : "登录") + "</button>";
    }
    // 只外显一个设置按钮：点击展开诊断/用量/签到/刷新模型四个操作。
    html += '<span class="wb-settle">' +
      '<button class="wb-setbtn" id="wb-settings" title="WorkBuddy 设置（诊断 / 用量 / 签到 / 刷新模型 / 重新登录）">⚙️</button>';
    if (menuOpen) {
      var items =
        '<button class="wb-item" id="wb-diagnose" title="一键诊断：真实探测登录、代理、令牌与模型出字状态">🔍 诊断</button>' +
        '<button class="wb-item" id="wb-usage" title="用量统计：查看今日/累计 token 与积分消耗、按模型明细">📊 用量</button>';
      // 签到按钮只在此代理真的实现了签到接口时出现。workbuddy2api 从未提供
      // /checkin-status 与 /checkin，显示一个必然 404 的入口只会误导用户；
      // supported 为 null 表示还没探测出结论（代理未启动等），此时保守隐藏。
      var ck = status.checkin;
      if (ck && ck.supported === true) {
        // ✅ 今日已处理 / 🎁 今日未处理（点击立即领取；10 点后也会自动领取）。
        var ckTitle = "今日还没签到（每天 10 点后自动领取）\n点击立即领取";
        var ckIcon = "🎁";
        var ckDisabled = "";
        var ckMsg = ck.lastResult && ck.lastResult.message ? "\n" + ck.lastResult.message : "";
        ckTitle = ck.handledToday ? "今日已处理签到" + ckMsg : ckTitle;
        ckIcon = ck.handledToday && ck.lastResult && ck.lastResult.ok ? "✅" : "🎁";
        ckDisabled = ck.handledToday ? " disabled" : "";
        items += '<button class="wb-item" id="wb-checkin" title="' + esc(ckTitle) + '"' + ckDisabled + '>' + ckIcon + " 签到</button>";
      }
      items +=
        '<button class="wb-item" id="wb-models" title="刷新模型列表：从代理重读模型并让模型选择器立即重载">🔄 刷新模型</button>';
      // 强制重登入口**始终存在**：本地判定是从会话文件推导的启发式（代理写入
      // 的 session.json 根本没有 expiresAt），token 在有效期内被吊销时判定仍是
      // "有效"，此时普通「登录」只会拿到 alreadyLoggedIn。若把入口做成有条件的，
      // "判定错误 → 无法恢复"的耦合就依然存在，所以这里不做条件渲染，只在
      // 判定不可靠时用 title 提示"建议"。
      items += '<button class="wb-item" id="wb-relogin" title="强制重新登录：忽略本地会话判定，重跑设备流登录' +
        (status.reloginRecommended ? '（当前建议执行：本地判定不可靠）' : '') + '">🔑 重新登录</button>';
      html += '<span class="wb-menu">' + items + "</span>";
    }
    html += "</span>";
    if (!proxyUp) {
      // 代理没响应但登录态还在：这是「探测失败/被占用」，不是掉登录，别让
      // 用户去点登录（点了也只会拿到 alreadyLoggedIn，还多占一次上游）。
      var why = status.lastProbeError ? "：" + esc(status.lastProbeError) : "";
      var n = status.consecutiveProbeFailures;
      html += '<span class="wb-warn" title="本地 workbuddy2api 代理未响应（连续 ' +
        (typeof n === "number" ? n : 1) + ' 次探测失败）' + esc(why) +
        '；登录会话本身仍然有效">代理未响应</span>';
    }
    html += "</div>";
    host.innerHTML = html;
    var btn = host.querySelector("#wb-login");
    if (btn) btn.addEventListener("click", onLogin);
    var setBtn = host.querySelector("#wb-settings");
    if (setBtn) setBtn.addEventListener("click", function (e) {
      // 阻止冒泡：render() 会重建 host 的 DOM，被点按钮随即脱离文档，
      // 否则 document 的外部点击监听器会误判为"点在外面"而立刻关掉菜单。
      e.stopPropagation();
      menuOpen = !menuOpen;
      render();
    });
    var dg = host.querySelector("#wb-diagnose");
    if (dg) dg.addEventListener("click", function () { menuOpen = false; render(); onDiagnose(); });
    var us = host.querySelector("#wb-usage");
    if (us) us.addEventListener("click", function () { menuOpen = false; render(); onUsage(); });
    var ckBtn = host.querySelector("#wb-checkin");
    if (ckBtn) ckBtn.addEventListener("click", function () { menuOpen = false; render(); onCheckin(); });
    var mdBtn = host.querySelector("#wb-models");
    if (mdBtn) mdBtn.addEventListener("click", function () { menuOpen = false; render(); onRefreshModels(); });
    var rlBtn = host.querySelector("#wb-relogin");
    if (rlBtn) rlBtn.addEventListener("click", function () { menuOpen = false; render(); onLogin(true); });
  }

  // 点击页面其它位置关闭设置菜单。
  var onDocClick = function (e) {
    if (!menuOpen) return;
    if (host.contains(e.target)) return;
    menuOpen = false;
    render();
  };
  document.addEventListener("click", onDocClick);

  // -------------------------------------------------------------------------
  // 拖动：默认停在右下角（CSS 的 right/bottom），用户拖走后改成固定 left/top。
  // 位置**刻意不持久化**——刷新页面即回到右下角，这是需求而不是省略。
  // -------------------------------------------------------------------------

  var drag = null;

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.max(min, Math.min(value, max));
  }

  /** 浮层跟随胶囊：优先贴在胶囊上方，上方放不下就放到下方，并夹在视口内。 */
  function placePanels() {
    var panels = document.querySelectorAll(".wb-panel");
    if (panels.length === 0) return;
    var rect = host.getBoundingClientRect();
    for (var i = 0; i < panels.length; i += 1) {
      var p = panels[i];
      var w = p.offsetWidth || 340;
      var h = p.offsetHeight || 220;
      var left = clamp(rect.right - w, 8, window.innerWidth - w - 8);
      var top = rect.top - h - 8;
      if (top < 8) top = clamp(rect.bottom + 8, 8, window.innerHeight - h - 8);
      p.style.left = Math.round(left) + "px";
      p.style.top = Math.round(top) + "px";
      p.style.right = "auto";
      p.style.bottom = "auto";
    }
  }

  /** 把胶囊从"右下角"钉到具体坐标上（只在第一次真正开始拖动时调用）。 */
  function pinPosition(rect) {
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.left = Math.round(rect.left) + "px";
    host.style.top = Math.round(rect.top) + "px";
  }

  host.addEventListener("pointerdown", function (e) {
    // 按钮是操作目标而不是拖动手柄：从按钮上按下时一律不进入拖动，
    // 否则一次"点一下登录"会被阈值判定吃掉。
    if (e.button !== 0) return;
    var target = e.target;
    if (target && typeof target.closest === "function" && target.closest("button") !== null) return;
    drag = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: host.getBoundingClientRect(),
      moved: false,
    };
    if (typeof host.setPointerCapture === "function") host.setPointerCapture(e.pointerId);
  });

  host.addEventListener("pointermove", function (e) {
    if (drag === null || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.startX;
    var dy = e.clientY - drag.startY;
    if (!drag.moved) {
      // 4px 阈值：小于它仍算点击（避免手抖把"点一下"变成拖动）。
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      drag.moved = true;
      pinPosition(drag.origin);
      host.classList.add("wb-host--dragging");
    }
    var w = host.offsetWidth;
    var h = host.offsetHeight;
    host.style.left = Math.round(clamp(drag.origin.left + dx, 0, window.innerWidth - w)) + "px";
    host.style.top = Math.round(clamp(drag.origin.top + dy, 0, window.innerHeight - h)) + "px";
    placePanels();
  });

  function endDrag(e) {
    if (drag === null || e.pointerId !== drag.id) return;
    host.classList.remove("wb-host--dragging");
    drag = null;
  }
  host.addEventListener("pointerup", endDrag);
  host.addEventListener("pointercancel", endDrag);

  // 窗口变化后把胶囊和浮层拉回视口内，避免缩窗后"拖没了"。
  var onResize = function () {
    if (host.style.left === "") return;
    var w = host.offsetWidth;
    var h = host.offsetHeight;
    host.style.left = Math.round(clamp(parseFloat(host.style.left) || 0, 0, window.innerWidth - w)) + "px";
    host.style.top = Math.round(clamp(parseFloat(host.style.top) || 0, 0, window.innerHeight - h)) + "px";
    placePanels();
  };
  window.addEventListener("resize", onResize);

  function refresh() {
    return fetch("/api/workbuddy/status")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) { status = data; render(); }
      })
      .catch(function () { /* leave last known state on screen */ });
  }

  /**
   * 触发登录。`force` 为真时忽略本地会话判定，强制重跑设备流——用于
   * 本地判定为"仍有效"但 token 实际已失效（被吊销）的场景，否则用户点了
   * 登录只会拿到 alreadyLoggedIn，没有任何恢复手段。
   */
  function onLogin(force) {
    if (busy) return;
    busy = true;
    render();
    fetch("/api/workbuddy/login" + (force ? "?force=1" : ""), { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.authUrl) {
          window.open(data.authUrl, "_blank", "noopener,noreferrer");
        } else if (data && data.error) {
          // e.g. no python3, or no URL within the timeout: surface it instead
          // of silently doing nothing (the old "点了没反应" symptom).
          busy = false;
          render();
          window.alert("WorkBuddy 登录失败：" + data.error);
          return;
        }
        var i = 0;
        var tick = function () {
          refresh().then(function () {
            if ((status && status.authenticated) || i >= LOGIN_POLLS) {
              busy = false;
              render();
              return;
            }
            i++;
            setTimeout(tick, LOGIN_POLL_MS);
          });
        };
        tick();
      })
      .catch(function () {
        busy = false;
        render();
      });
  }

  /** 复制文本到剪贴板。返回 Promise，便于在失败时给出提示。 */
  function copyCommand(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error("浏览器不支持剪贴板 API"));
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * 轮询 `probe()` 直到它返回真值或超时。
   * @returns {Promise<*>} 命中时的返回值；超时则是最后一次（假值）结果。
   */
  function waitFor(probe, timeoutMs, intervalMs) {
    var deadline = Date.now() + timeoutMs;
    function attempt() {
      var value = probe();
      if (value || Date.now() >= deadline) return Promise.resolve(value);
      return delay(intervalMs).then(attempt);
    }
    return attempt();
  }

  /** 新开的终端标签页：`tabsIn` 里第一个不在 `before` 里的 terminal 标签。 */
  function newTerminalTab(sidebar, sessionId, before) {
    var tabs = sidebar.tabsIn(sessionId);
    for (var i = 0; i < tabs.length; i += 1) {
      if (tabs[i].kind === "terminal" && !before[tabs[i].id]) return tabs[i];
    }
    return undefined;
  }

  /**
   * 取某个终端标签页的模型。必须和侧边栏面板拿到**同一个实例**：模型按
   * `key`（标签 id）存放，若 contentId 或 key 对不上就会新建一个没有挂载、
   * 没有输入控制权的影子对象，`write()` 会静默丢弃。所以这里照抄官方终端插件
   * （@deepseek-ai/dsh-client-ui-sidebar-terminal）的算法——
   * key = 标签 id，contentId = 该标签的 navigation address，terminalId /
   * shellPath 取自同一份 navigation params。
   */
  function terminalViewFor(sidebar, terminals, sessionId, tabId) {
    var nav = sidebar.tabDomain.occurrence(sessionId, { id: tabId }).navigation.getSnapshot();
    var params = nav.params;
    var terminalId = params && typeof params === "object" && "terminalId" in params ? params.terminalId : undefined;
    var shellPath = params && typeof params === "object" && "shellPath" in params ? params.shellPath : undefined;
    return terminals.view(sessionId, tabId, nav.address, terminalId, shellPath);
  }

  /**
   * 在 DSH 内置终端（>= 0.1.7）里执行命令：开一个终端标签页 → 等它连上并拿到
   * 输入控制权 → 把整条命令敲进去并回车。
   *
   * 只依赖两个客户端服务（sidebarRight / webTerminals），并且用 ctx.get 惰性
   * 读取：界面里没有终端插件时这里会 reject，由调用方退回"复制命令"，登录胶囊
   * 本身不受影响。
   */
  function runInTerminal(command) {
    // 包一层 Promise.resolve().then：任何同步异常都变成 rejection，
    // 调用方只需要处理一条失败路径。
    return Promise.resolve().then(function () {
      var sidebar = ctx && typeof ctx.get === "function" ? ctx.get("sidebarRight") : undefined;
      var terminals = ctx && typeof ctx.get === "function" ? ctx.get("webTerminals") : undefined;
      if (!sidebar || !terminals) throw new Error("当前界面没有内置终端（缺少 sidebarRight / webTerminals 服务）");
      var sessionId = sidebar.mounted.getSnapshot();
      if (sessionId === undefined) throw new Error("请先打开一个会话，再在终端里执行");

      var before = {};
      var existing = sidebar.tabsIn(sessionId);
      for (var i = 0; i < existing.length; i += 1) before[existing[i].id] = true;
      sidebar.openTab("terminal");

      return waitFor(function () { return newTerminalTab(sidebar, sessionId, before); }, 4000, 60)
        .then(function (tab) {
          if (tab === undefined) throw new Error("终端标签页没有打开");
          var view = terminalViewFor(sidebar, terminals, sessionId, tab.id);
          return waitFor(function () {
            var state = view.state.getSnapshot();
            if (state.phase === "failed") throw new Error(state.error || "终端启动失败");
            // writable 要求"终端进程在跑"且"输入控制权在本页面"同时成立；
            // 刚 openTab 时它还是 false，所以必须等，不能立刻 write。
            return state.phase === "connected" && state.writable ? view : undefined;
          }, 20000, 120).then(function (ready) {
            if (!ready) throw new Error("终端已打开，但一直没拿到输入控制权");
            ready.write(command + "\r");
          });
        });
    });
  }

  /** 一键诊断：真实探测代理健康，必要时给出可复制的重启命令。 */
  function onDiagnose() {
    var panel = document.getElementById("wb-diagnose-panel");
    if (panel) { panel.remove(); return; }
    var el = makePanel("wb-diagnose-panel", "WorkBuddy 诊断");

    fetch("/api/workbuddy/diagnose", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d) throw new Error("空响应");
        var title = d.ok ? "✅ 一切正常" : "⚠️ 发现问题";
        var lines = [];
        lines.push("登录状态: " + (d.session && d.session.authenticated ? "有效" : "无效"));
        lines.push("会话文件: " + (d.session && d.session.file ? "存在" : "缺失"));
        // 过期时间是多源推导出来的（代理写入的 session.json 没有 expiresAt），
        // 把来源一并显示，便于判断"未知"到底是没探测到还是真的没写。
        var exp = d.session && d.session.expiresAt;
        lines.push("令牌过期: " + (exp
          ? fmtExpiry(exp) + "（来源: " + ((d.session && d.session.expiresAtSource) || "?") + "）"
          : "未知（无法从会话文件推导）"));
        lines.push("代理进程: " + (d.health && d.health.proxyUp ? "在运行" : "未响应"));
        lines.push("登录令牌: " + (d.health && d.health.tokenValid === true
          ? "有效"
          : d.health && d.health.tokenValid === false ? "无效" : "未知（探测失败，未取到）"));
        if (d.health && d.health.degraded) {
          lines.push("探测异常: 连续 " + d.health.consecutiveProbeFailures + " 次失败" +
            (d.health.lastProbeError ? "（" + d.health.lastProbeError + "）" : ""));
        }
        lines.push("模型出字: " + (d.chat && d.chat.chatWorking ? "正常" : "失败"));
        if (d.chat && d.chat.chatError) lines.push("出字错误: " + d.chat.chatError);
        if (d.session && d.session.reloginRecommended) {
          lines.push("提示: 建议点 ⚙️ → 🔑 重新登录（本地判定不可靠，可强制重跑登录）");
        }
        var body = el.querySelector(".wb-panel-body");
        var html = '<div style="font-weight:700;margin-bottom:4px">' + esc(title) + '</div>' +
          '<div>' + lines.map(esc).join("\n") + "</div>";
        if (!d.ok && d.restartCommand) {
          html += '<div style="margin-top:8px;font-weight:700">重启命令：</div>' +
            '<pre style="background:#1e293b;border-radius:6px;padding:8px;font-size:11px;overflow:auto;white-space:pre-wrap">' +
            esc(d.restartCommand) + "</pre>" +
            '<div class="wb-actions">' +
            '<button class="wb-btn" id="wb-copy-cmd">复制重启命令</button>' +
            // 内置终端（DSH >= 0.1.7）可用时，直接开一个终端把命令跑起来。
            (d.terminalCommand
              ? '<button class="wb-btn" id="wb-run-cmd" title="在 DSH 内置终端里打开并执行这条命令">▶ 在终端执行</button>'
              : "") +
            "</div>";
        }
        body.innerHTML = html;
        // 内容从"加载中…"变成完整报告后高度会变，重新贴一次，避免面板长高后
        // 压住胶囊（placePanels 是按当前高度把面板贴在胶囊上方的）。
        placePanels();
        var copy = document.getElementById("wb-copy-cmd");
        if (copy) {
          copy.addEventListener("click", function (e) {
            e.stopPropagation();
            copyCommand(d.restartCommand).then(function () {
              copy.textContent = "已复制 ✓";
              setTimeout(function () { copy.textContent = "复制重启命令"; }, 1500);
            });
          });
        }
        var run = document.getElementById("wb-run-cmd");
        if (run) {
          run.addEventListener("click", function (e) {
            e.stopPropagation();
            if (run.dataset.busy) return;
            run.dataset.busy = "1";
            run.disabled = true;
            run.textContent = "启动终端…";
            runInTerminal(d.terminalCommand).then(function () {
              delete run.dataset.busy;
              run.textContent = "已在终端执行 ✓";
              setTimeout(function () {
                if (!run.dataset.busy) { run.textContent = "▶ 在终端执行"; run.disabled = false; }
              }, 2500);
            }, function (err) {
              // 终端不可用时不留死路：把命令放进剪贴板，用户可自行粘贴执行。
              delete run.dataset.busy;
              run.textContent = "▶ 在终端执行";
              run.disabled = false;
              var why = String(err && err.message || err);
              copyCommand(d.terminalCommand).then(function () {
                window.alert("无法自动在终端执行：" + why + "\n\n命令已复制到剪贴板，可手动粘贴执行。");
              }, function () {
                window.alert("无法自动在终端执行：" + why);
              });
            });
          });
        }
      })
      .catch(function (err) {
        el.querySelector(".wb-panel-body").innerHTML =
          '<div style="font-weight:700;color:#f87171">诊断失败</div><div>' + esc(String(err && err.message || err)) + "</div>";
        placePanels();
      });
  }

  /** 用量统计：读取 /api/workbuddy/usage 并展示今日/累计/模型明细。 */
  function onUsage() {
    var panel = document.getElementById("wb-usage-panel");
    if (panel) { panel.remove(); return; }
    var el = makePanel("wb-usage-panel", "WorkBuddy 用量统计");

    fetch("/api/workbuddy/usage")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) throw new Error("空响应");
        var hasCredit = (d.total.credit || 0) > 0;
        var lines = [];
        lines.push("今日：输入 " + d.today.inputTokens + " / 输出 " + d.today.outputTokens + " tokens（" + d.today.requests + " 次请求）");
        lines.push("累计：输入 " + d.total.inputTokens + " / 输出 " + d.total.outputTokens + " tokens（" + d.total.requests + " 次请求）");
        if (hasCredit) {
          lines.push("今日积分消耗：" + fmtCredit(d.today.credit) + " ｜ 累计：" + fmtCredit(d.total.credit));
        }
        lines.push("");
        lines.push("按模型明细：");
        if (d.byModel.length === 0) lines.push("  暂无数据");
        for (var i = 0; i < d.byModel.length; i += 1) {
          var m = d.byModel[i];
          var extra = (m.credit || 0) > 0 ? "，积分 " + fmtCredit(m.credit) : "";
          lines.push("  " + m.model + "：输入 " + m.inputTokens + " / 输出 " + m.outputTokens + "（" + m.requests + " 次" + extra + "）");
        }
        var note = hasCredit
          ? "数据来源：本地用量台账（含上游每次返回的积分消耗；代理不暴露余额接口，无法显示剩余积分）"
          : "数据来源：本地 token 用量台账（" + d.total.requests + " 次累计）；当前模型为免费/折扣档，上游回报积分为 0";
        el.querySelector(".wb-panel-body").innerHTML =
          esc(lines.join("\n")) + '<div style="margin-top:8px;color:#64748b;font-size:11px">' + esc(note) + "</div>";
        placePanels();
      })
      .catch(function (err) {
        el.querySelector(".wb-panel-body").innerHTML =
          '<div style="font-weight:700;color:#f87171">用量加载失败</div><div>' + esc(String(err && err.message || err)) + "</div>";
        placePanels();
      });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /** 格式化积分消耗：保留 2 位小数，去掉无意义的尾零。 */
  function fmtCredit(n) {
    var v = Number(n) || 0;
    return (Math.round(v * 100) / 100).toString();
  }

  /**
   * 创建一个可关闭的浮层（诊断/用量面板共用）。右上角带 ❌，点击浮层外区域或按
   * Esc 均可关闭。返回的 el 由调用方填充内容；再次点击对应菜单项也可关闭
   * （调用方已对 getElementById(id) 做了存在即 remove 的处理）。
   * @param {string} id  浮层 DOM id（如 "wb-usage-panel"）
   * @param {string} title 标题文字
   * @returns {HTMLElement}
   */
  function makePanel(id, title) {
    var el = document.createElement("div");
    el.id = id;
    el.className = "wb-panel";
    el.innerHTML =
      '<div class="wb-panel-head"><span class="wb-ttl">' + esc(title) + "</span>" +
      '<button class="wb-close" title="关闭">✕</button></div>' +
      '<div class="wb-panel-body" style="white-space:pre-wrap;word-break:break-word;color:#94a3b8">加载中…</div>';
    document.body.appendChild(el);
    // 浮层贴在胶囊旁边（胶囊被拖走后不再固定出现在右下角）。
    placePanels();
    var attachTimer = null;
    var close = function () {
      if (attachTimer !== null) { clearTimeout(attachTimer); attachTimer = null; }
      el.remove();
      document.removeEventListener("click", onPanelClick, true);
      document.removeEventListener("keydown", onKey);
      var at = openPanels.indexOf(close);
      if (at >= 0) openPanels.splice(at, 1);
    };
    el.querySelector(".wb-close").addEventListener("click", close);
    var onPanelClick = function (e) { if (!el.contains(e.target)) close(); };
    var onKey = function (e) { if (e.key === "Escape") close(); };
    // 用捕获阶段，避免被状态胶囊的 document 点击监听（菜单外部关闭）提前吞掉。
    attachTimer = setTimeout(function () {
      attachTimer = null;
      document.addEventListener("click", onPanelClick, true);
      document.addEventListener("keydown", onKey);
    }, 0);
    openPanels.push(close);
    return el;
  }

  /** 手动领取今日签到（幂等：官方对已签到返回业务拒绝，不会出错）。 */
  function onCheckin() {
    var btn = host.querySelector("#wb-checkin");
    if (!btn || btn.dataset.busy) return;
    btn.dataset.busy = "1";
    btn.textContent = "⏳";
    fetch("/api/workbuddy/checkin", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // 代理没实现签到接口：刷新状态让入口按 supported 自行消失，
        // 而不是留一个点了就报错的按钮。
        if (d && d.supported === false) { refresh(); return; }
        btn.textContent = d && d.ok ? "✅" : "🎁";
        btn.title = (d && d.message) || "签到结果未知";
        refresh();
      })
      .catch(function () {
        btn.textContent = "🎁";
        btn.title = "签到请求失败（代理未运行？）";
      })
      .then(function () { delete btn.dataset.busy; });
  }

  /** 刷新模型列表：清插件发现缓存 + 触发模型选择器立即重载。 */
  function onRefreshModels() {
    var btn = host.querySelector("#wb-models");
    if (!btn || btn.dataset.busy) return;
    btn.dataset.busy = "1";
    btn.textContent = "…";
    fetch("/api/workbuddy/refresh-models", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.textContent = d && typeof d.count === "number" ? d.count + "✓" : "✓";
        btn.title = d && d.announced
          ? "已刷新：" + d.count + " 个模型（模型选择器已更新）"
          : "已刷新模型缓存（事件通知失败，重开设置页可见新列表）";
        setTimeout(function () { btn.textContent = "🔄"; }, 2000);
      })
      .catch(function () {
        btn.textContent = "🔄";
        btn.title = "刷新失败（代理未运行？）";
      })
      .then(function () { delete btn.dataset.busy; });
  }

  refresh();
  timer = setInterval(refresh, POLL_MS);

  /** 卸载：停轮询、摘全局监听、关浮层、移除胶囊与样式。 */
  return function dispose() {
    if (timer !== null) { clearInterval(timer); timer = null; }
    document.removeEventListener("click", onDocClick);
    window.removeEventListener("resize", onResize);
    while (openPanels.length > 0) openPanels[openPanels.length - 1]();
    host.remove();
    style.remove();
  };
}
