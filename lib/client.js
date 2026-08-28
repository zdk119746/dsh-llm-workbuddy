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
    ".wb-pill--bad .wb-dot{background:#ef4444;}" +
    ".wb-btn{margin-left:4px;border:0;border-radius:6px;background:#2563eb;color:#fff;" +
    "padding:3px 8px;cursor:pointer;font:inherit;}" +
    ".wb-btn:disabled{opacity:.6;cursor:default;}" +
    ".wb-warn{margin-left:6px;color:#f59e0b;font-size:11px;}";
  document.head.appendChild(style);
  document.body.appendChild(host);

  var status = null;
  var busy = false;
  var timer = null;

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
    var ok = status.authenticated && status.proxyUp;
    var label = ok
      ? "WorkBuddy · " + (status.account && (status.account.nickname || status.account.uid) || "已登录")
      : "WorkBuddy · 未登录";
    var html =
      '<div class="wb-pill ' + (ok ? "wb-pill--ok" : "wb-pill--bad") + '">' +
      '<span class="wb-dot"></span>' +
      '<span class="wb-label">' + label + "</span>";
    if (!ok) {
      var disabled = busy || !status.loginScriptAvailable ? " disabled" : "";
      html += '<button class="wb-btn" id="wb-login"' + disabled + ">" +
        (busy ? "登录中…" : "登录") + "</button>";
    }
    // 诊断按钮始终显示，便于随时自查真实健康状态。
    html += '<button class="wb-btn wb-diagnose" id="wb-diagnose" title="一键诊断">🔍</button>';
    // 用量按钮：查看今日/累计 token 用量与模型明细。
    html += '<button class="wb-btn wb-usage" id="wb-usage" title="用量统计">📊</button>';
    // 签到按钮：✅ 今日已处理 / 🎁 今日未处理（点击立即领取；10 点后也会自动领取）。
    var ck = status.checkin;
    if (ck) {
      var ckMsg = ck.lastResult && ck.lastResult.message ? "\n" + ck.lastResult.message : "";
      var ckTitle = ck.handledToday ? "今日已处理签到" + ckMsg : "今日还没签到（每天 10 点后自动领取）\n点击立即领取";
      var ckIcon = ck.handledToday && ck.lastResult && ck.lastResult.ok ? "✅" : "🎁";
      html += '<button class="wb-btn wb-checkin" id="wb-checkin" title="' + esc(ckTitle) + '">' + ckIcon + "</button>";
    }
    // 刷新模型按钮：从代理重读模型列表（跟随 WorkBuddy 应用更新）并让模型选择器立即重载。
    html += '<button class="wb-btn wb-models" id="wb-models" title="刷新模型列表">🔄</button>';
    if (!status.proxyUp) html += '<span class="wb-warn">代理未运行</span>';
    html += "</div>";
    host.innerHTML = html;
    var btn = host.querySelector("#wb-login");
    if (btn) btn.addEventListener("click", onLogin);
    var dg = host.querySelector("#wb-diagnose");
    if (dg) dg.addEventListener("click", onDiagnose);
    var us = host.querySelector("#wb-usage");
    if (us) us.addEventListener("click", onUsage);
    var ckBtn = host.querySelector("#wb-checkin");
    if (ckBtn) ckBtn.addEventListener("click", onCheckin);
    var mdBtn = host.querySelector("#wb-models");
    if (mdBtn) mdBtn.addEventListener("click", onRefreshModels);
  }

  function refresh() {
    return fetch("/api/workbuddy/status")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) { status = data; render(); }
      })
      .catch(function () { /* leave last known state on screen */ });
  }

  function onLogin() {
    if (busy) return;
    busy = true;
    render();
    fetch("/api/workbuddy/login", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.authUrl) {
          window.open(data.authUrl, "_blank", "noopener,noreferrer");
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
    var el = document.createElement("div");
    el.id = "wb-diagnose-panel";
    el.style.cssText =
      "position:fixed;right:12px;bottom:44px;z-index:2147483647;width:340px;max-height:340px;overflow:auto;" +
      "background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;" +
      "padding:10px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.5);";
    el.innerHTML = '<div class="wb-dg-title" style="font-weight:700;margin-bottom:6px">WorkBuddy 诊断中…</div>' +
      '<div class="wb-dg-body" style="white-space:pre-wrap;word-break:break-word;color:#94a3b8">正在探测…</div>';
    document.body.appendChild(el);

    fetch("/api/workbuddy/diagnose", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d) throw new Error("空响应");
        var title = d.ok ? "✅ 一切正常" : "⚠️ 发现问题";
        var lines = [];
        lines.push("登录状态: " + (d.session && d.session.authenticated ? "有效" : "无效"));
        lines.push("会话文件: " + (d.session && d.session.file ? "存在" : "缺失"));
        lines.push("代理进程: " + (d.health && d.health.proxyUp ? "在运行" : "未运行"));
        lines.push("登录令牌: " + (d.health && d.health.tokenValid ? "有效" : "无效"));
        lines.push("模型出字: " + (d.chat && d.chat.chatWorking ? "正常" : "失败"));
        if (d.chat && d.chat.chatError) lines.push("出字错误: " + d.chat.chatError);
        var html = '<div class="wb-dg-title" style="font-weight:700;margin-bottom:6px">' + title + '</div>' +
          '<div class="wb-dg-body" style="white-space:pre-wrap;word-break:break-word">' + lines.map(esc).join("\n") + "</div>";
        if (!d.ok && d.restartCommand) {
          html += '<div style="margin-top:8px;font-weight:700">重启命令（复制到终端执行）：</div>' +
            '<pre style="background:#1e293b;border-radius:6px;padding:8px;font-size:11px;overflow:auto;white-space:pre-wrap">' +
            esc(d.restartCommand) + "</pre>" +
            '<button class="wb-btn" id="wb-copy-cmd">复制重启命令</button>';
        }
        el.innerHTML = html;
        var copy = document.getElementById("wb-copy-cmd");
        if (copy) {
          copy.addEventListener("click", function () {
            navigator.clipboard.writeText(d.restartCommand).then(function () {
              copy.textContent = "已复制 ✓";
              setTimeout(function () { copy.textContent = "复制重启命令"; }, 1500);
            });
          });
        }
      })
      .catch(function (err) {
        el.innerHTML = '<div class="wb-dg-title" style="font-weight:700;color:#f87171">诊断失败</div>' +
          '<div class="wb-dg-body">' + esc(String(err && err.message || err)) + "</div>";
      });
  }

  /** 用量统计：读取 /api/workbuddy/usage 并展示今日/累计/模型明细。 */
  function onUsage() {
    var panel = document.getElementById("wb-usage-panel");
    if (panel) { panel.remove(); return; }
    var el = document.createElement("div");
    el.id = "wb-usage-panel";
    el.style.cssText =
      "position:fixed;right:12px;bottom:44px;z-index:2147483647;width:340px;max-height:340px;overflow:auto;" +
      "background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;" +
      "padding:10px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.5);";
    el.innerHTML = '<div class="wb-usage-title" style="font-weight:700;margin-bottom:6px">WorkBuddy 用量统计</div>' +
      '<div class="wb-usage-body" style="color:#94a3b8">加载中…</div>';
    document.body.appendChild(el);

    fetch("/api/workbuddy/usage")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) throw new Error("空响应");
        var lines = [];
        lines.push("今日：输入 " + d.today.inputTokens + " / 输出 " + d.today.outputTokens + " tokens（" + d.today.requests + " 次请求）");
        lines.push("累计：输入 " + d.total.inputTokens + " / 输出 " + d.total.outputTokens + " tokens（" + d.total.requests + " 次请求）");
        lines.push("");
        lines.push("按模型明细：");
        if (d.byModel.length === 0) lines.push("  暂无数据");
        for (var i = 0; i < d.byModel.length; i += 1) {
          var m = d.byModel[i];
          lines.push("  " + m.model + "：输入 " + m.inputTokens + " / 输出 " + m.outputTokens + "（" + m.requests + " 次）");
        }
        el.innerHTML = '<div class="wb-usage-title" style="font-weight:700;margin-bottom:6px">WorkBuddy 用量统计</div>' +
          '<div class="wb-usage-body" style="white-space:pre-wrap;word-break:break-word">' + esc(lines.join("\n")) + "</div>" +
          '<div style="margin-top:8px;color:#64748b;font-size:11px">数据来源：本地 token 用量台账（' + esc(d.total.requests) + " 次累计）</div>";
      })
      .catch(function (err) {
        el.innerHTML = '<div class="wb-usage-title" style="font-weight:700;color:#f87171">用量加载失败</div>' +
          '<div class="wb-usage-body">' + esc(String(err && err.message || err)) + "</div>";
      });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
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
