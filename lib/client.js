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
       */
      apply: function () {
        startWidget();
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

/** 插件激活后、DOM 就绪时开始挂载 widget。 */
function startWidget() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runWidget, { once: true });
  } else {
    runWidget();
  }
}

/** 真正的 widget 逻辑：注入样式、渲染状态条、轮询、登录。 */
function runWidget() {
  var host = document.createElement("div");
  host.id = "wb-status-host";
  host.style.cssText =
    "position:fixed;right:12px;bottom:12px;z-index:2147483647;" +
    "font:12px/1.4 system-ui,-apple-system,sans-serif;";

  var style = document.createElement("style");
  style.textContent =
    ".wb-pill{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;" +
    "background:#111827;color:#e5e7eb;box-shadow:0 2px 8px rgba(0,0,0,.35);}" +
    ".wb-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af;}" +
    ".wb-pill--ok .wb-dot{background:#22c55e;}" +
    ".wb-pill--warn .wb-dot{background:#f59e0b;}" +
    ".wb-pill--bad .wb-dot{background:#ef4444;}" +
    ".wb-btn{margin-left:4px;border:0;border-radius:6px;background:#2563eb;color:#fff;" +
    "padding:3px 8px;cursor:pointer;font:inherit;}" +
    ".wb-btn:disabled{opacity:.6;cursor:default;}" +
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
  document.addEventListener("click", function (e) {
    if (!menuOpen) return;
    if (host.contains(e.target)) return;
    menuOpen = false;
    render();
  });

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
          html += '<div style="margin-top:8px;font-weight:700">重启命令（复制到终端执行）：</div>' +
            '<pre style="background:#1e293b;border-radius:6px;padding:8px;font-size:11px;overflow:auto;white-space:pre-wrap">' +
            esc(d.restartCommand) + "</pre>" +
            '<button class="wb-btn" id="wb-copy-cmd">复制重启命令</button>';
        }
        body.innerHTML = html;
        var copy = document.getElementById("wb-copy-cmd");
        if (copy) {
          copy.addEventListener("click", function (e) {
            e.stopPropagation();
            navigator.clipboard.writeText(d.restartCommand).then(function () {
              copy.textContent = "已复制 ✓";
              setTimeout(function () { copy.textContent = "复制重启命令"; }, 1500);
            });
          });
        }
      })
      .catch(function (err) {
        el.querySelector(".wb-panel-body").innerHTML =
          '<div style="font-weight:700;color:#f87171">诊断失败</div><div>' + esc(String(err && err.message || err)) + "</div>";
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
      })
      .catch(function (err) {
        el.querySelector(".wb-panel-body").innerHTML =
          '<div style="font-weight:700;color:#f87171">用量加载失败</div><div>' + esc(String(err && err.message || err)) + "</div>";
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
    var close = function () { el.remove(); document.removeEventListener("click", onDocClick, true); document.removeEventListener("keydown", onKey); };
    el.querySelector(".wb-close").addEventListener("click", close);
    var onDocClick = function (e) { if (!el.contains(e.target)) close(); };
    var onKey = function (e) { if (e.key === "Escape") close(); };
    // 用捕获阶段，避免被状态胶囊的 document 点击监听（菜单外部关闭）提前吞掉。
    setTimeout(function () {
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKey);
    }, 0);
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
}
