/**
 * dsh-llm-workbuddy
 *
 * WorkBuddy LLM provider adapter for DeepSeek Harness.
 *
 * Routes the `workbuddy` provider to the local workbuddy2api proxy
 * (https://github.com/hawklithm/workbuddy2api), which converts CodeBuddy /
 * WorkBuddy's proprietary protocol into standard OpenAI chat completions.
 *
 * The proxy authenticates with the locally stored CodeBuddy/WorkBuddy login
 * session, so this adapter needs no API key: every request is sent without an
 * `Authorization` header unless one is explicitly configured.
 *
 * The adapter is a plain fetch + SSE implementation over the OpenAI-compatible
 * wire format; it emits the harness `StreamChunk` protocol. Model discovery
 * queries the proxy's `/v1/models` endpoint (cached, short TTL) and falls back
 * to a shipped static catalog when the proxy is not running.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, openSync, statSync, truncateSync, writeSync, closeSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
// Namespace imports for symbols that moved between harness releases. A named
// import of a symbol that no longer exists is an ESM load-time SyntaxError that
// takes the whole plugin down, so these resolve through the namespace object
// with a fallback instead.
import * as dshLlm from "@deepseek-ai/dsh-llm";
import * as dshSettings from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";

/**
 * Brand a tool-call id. Harness 0.1.1-rc.2 exports `CallId`; 0.1.5-rc.1 renamed
 * it to `ToolCallId`. Both brands are string-preserving, so the first one the
 * loaded harness provides is correct on either release.
 */
const CallId = dshLlm.CallId ?? dshLlm.ToolCallId;

/**
 * Validate a settings namespace. Harness 0.1.5-rc.1 stopped exporting
 * `settingsNamespace` and validates inside registration instead; this mirrors
 * the same lowercase-hyphenated grammar so a bad namespace still fails loudly.
 */
const settingsNamespace = dshSettings.settingsNamespace ?? ((value) => {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match /^[a-z][a-z0-9-]*$/`);
  }
  return value;
});

/**
 * Wire this plugin's settings section to the optional settings service.
 * Harness 0.1.1-rc.2 exports the free function `installSettingsSection`;
 * 0.1.5-rc.1 replaced it with the `installSection` method on the settings
 * service, reached through `ctx.inject(["settings"], …)`. Both register the
 * plugin's composition config as the namespace base and fall back to it when
 * the service is absent, so behaviour is identical either way.
 */
function installSettingsSection(ctx, ns, schema, entry, hooks) {
  if (typeof dshSettings.installSettingsSection === "function") {
    return dshSettings.installSettingsSection(ctx, ns, schema, entry, hooks);
  }
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, ns, schema, entry, hooks);
  });
}

/** Plugin identity (Cordis convention). */
export const name = "llm-workbuddy";
// `llm` is a hard requirement (the adapter must always register). `webServer`
// is optional — headless profiles have no HTTP surface, so it must NOT be in
// `inject` (that would make the whole plugin PENDING forever in headless).
// We probe it at the use site instead. See cordis-tutorial/03-services.md.
export const inject = ["llm"];

/** The single provider route this plugin owns. */
export const PROVIDER = "workbuddy";

/** Settings namespace for the optional `llm-workbuddy:` user-settings section. */
const NS = settingsNamespace("llm-workbuddy");

/** Default local workbuddy2api proxy endpoint. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:8787/v1";

/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";

/** Default combined request/response context capacity. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Default per-request output-token cap. */
const DEFAULT_MAX_TOKENS = 32_000;

/** Usage ledger: one JSONL line per completed request, under DSH_HOME. */
const USAGE_DIR_NAME = "llm-workbuddy";
const USAGE_FILE_NAME = "usage.jsonl";
/** Cap on how many historical lines the ledger keeps (avoid unbounded growth). */
const USAGE_MAX_LINES = 20_000;

/** Live `/v1/models` discovery cache window and request timeout. */
const DISCOVERY_TTL_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 2_000;

/**
 * Static catalog shipped with the plugin — the conversational models of the
 * CodeBuddy/WorkBuddy platform (from workbuddy2api's models_config.json).
 * It is advisory and replaced by the live `/v1/models` answer whenever the
 * proxy is reachable; entries not announced by the proxy are still listed.
 *
 * `credits` is the platform's declared multiplier (`"x0.06 credits"`), shown
 * after the model name. The live answer wins when it carries one — this copy
 * only covers the proxy-down / discovery-off fallback.
 */
const DEFAULT_MODELS = [
  { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1_000_000, maxTokens: 50_000, inputModalities: ["text", "image"], reasoningEffort: "high" },
  { id: "deepseek-v4-pro", name: "Deepseek-V4-Pro", contextWindow: 1_000_000, maxTokens: 50_000, inputModalities: ["text", "image"], reasoningEffort: "high", credits: "x0.16 credits" },
  { id: "deepseek-v4-flash", name: "Deepseek-V4-Flash", contextWindow: 1_000_000, maxTokens: 50_000, inputModalities: ["text", "image"], reasoningEffort: "high", credits: "x0.06 credits" },
  { id: "deepseek-v3-2-volc", name: "DeepSeek-V3.2", contextWindow: 96_000, maxTokens: 32_000, reasoningEffort: "medium", credits: "x0.29 credits" },
  { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1_000_000, maxTokens: 48_000, inputModalities: ["text", "image"], reasoningEffort: "medium", credits: "x0.79 credits" },
  { id: "glm-5.1", name: "GLM-5.1", contextWindow: 200_000, maxTokens: 48_000, reasoningEffort: "medium", credits: "x0.79 credits" },
  { id: "glm-5v-turbo", name: "GLM-5v-Turbo", contextWindow: 200_000, maxTokens: 64_000, inputModalities: ["text", "image"], reasoningEffort: "medium", credits: "x0.95 credits" },
  { id: "kimi-k3-1", name: "Kimi-K3", contextWindow: 1_000_000, maxTokens: 32_000, inputModalities: ["text", "image"], reasoningEffort: "medium", credits: "x1.62 credits" },
  { id: "kimi-k2.7", name: "Kimi-K2.7-Code", contextWindow: 256_000, maxTokens: 32_000, inputModalities: ["text", "image"], reasoningEffort: "medium", credits: "x0.57 credits" },
  { id: "kimi-k2.6", name: "Kimi-K2.6", contextWindow: 256_000, maxTokens: 32_000, inputModalities: ["text", "image"], reasoningEffort: "medium", credits: "x0.52 credits" },
  { id: "kimi-k2.5", name: "Kimi-K2.5", contextWindow: 164_000, maxTokens: 32_000, inputModalities: ["text", "image"], reasoningEffort: "medium", credits: "x0.45 credits" },
  { id: "minimax-m3", name: "MiniMax-M3", contextWindow: 512_000, maxTokens: 128_000, inputModalities: ["text", "image"], reasoningEffort: "medium", credits: "x0.25 credits" },
  { id: "hy3", name: "Hy3", contextWindow: 192_000, maxTokens: 64_000, inputModalities: ["text", "image"], reasoningEffort: "high", credits: "x0.00 credits" },
  { id: "hunyuan-2.0-thinking", name: "Hunyuan-2.0-Thinking", contextWindow: 128_000, maxTokens: 24_000, reasoningEffort: "medium", credits: "x0.04 credits" },
  { id: "hunyuan-chat", name: "Hunyuan-Turbos", contextWindow: 200_000, maxTokens: 8_192 },
  { id: "auto", name: "Auto", contextWindow: 168_000, maxTokens: 32_000, inputModalities: ["text", "image"], reasoningEffort: "high" },
  { id: "default", name: "Default", contextWindow: 200_000, maxTokens: 24_000, credits: "x2.00 credits" },
];

/**
 * Models the proxy still announces but that the upstream platform rejects with
 * `service info not found` (each id re-probed 2026-09-10 against the live
 * endpoint). The catalog is no longer a whitelist — a model the platform
 * launches shows up after a refresh without a plugin update — so dead ids are
 * hidden here by name instead.
 */
const RETIRED_MODEL_IDS = new Set([
  "minimax-m2.5",
  "glm-5.0",
  "glm-4.7",
  "glm-4.6",
  "glm-4.6v",
  "kimi-k2-thinking",
  "deepseek-v3-1",
  "deepseek-v3-1-volc",
  "kimi-k2-instruct-taiji",
  "completion-gf",
  "default-1.1",
  "default-1.2",
]);

/** Selectable reasoning efforts exposed to the harness UI, in display order. */
const REASONING_EFFORTS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
];

/**
 * Adapter-owned reasoning-effort identifiers accepted by the wire. The harness
 * `ReasoningEffortId` is opaque; we keep the catalog default and the request
 * param in this vocabulary and map to/from the proxy as needed.
 */
const REASONING_EFFORT_IDS = new Set(["low", "medium", "high"]);

/**
 * Build the `reasoning` capability metadata for a model, per the dsh-llm
 * `LlmModelReasoningInfo` contract. `effort` is the model's platform default
 * (`high`/`medium`/`low`); absent means the model exposes no selectable
 * reasoning (the harness then hides the selector). When the platform does not
 * support per-request switching, callers may still omit an explicit effort and
 * the proxy uses its own default — publishing the default keeps the UI honest
 * about the level actually applied.
 * @returns the `reasoning` block, or `undefined` when the model has none.
 */
function modelReasoningInfo(effort) {
  if (effort === undefined || !REASONING_EFFORT_IDS.has(effort)) return undefined;
  return {
    efforts: REASONING_EFFORTS,
    defaultEffort: effort,
  };
}

/**
 * Extract a model's default reasoning effort from a live `/v1/models` entry.
 * The proxy reports `supported_reasoning_levels: [{ effort: 'High' }]` and
 * `default_reasoning_level: null`, so we fall back to the catalog's
 * `reasoningEffort` when the live answer is uninformative (as it currently is).
 * @returns a lowercased effort id (`low`/`medium`/`high`) or `undefined`.
 */
function liveReasoningEffort(entry, catalogEffort) {
  if (catalogEffort !== undefined) return catalogEffort;
  const levels = Array.isArray(entry?.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
  const wire = levels[0]?.effort;
  if (typeof wire !== "string") return undefined;
  const lower = wire.toLowerCase();
  return lower === "low" || lower === "medium" || lower === "high" ? lower : undefined;
}

/**
 * Extract validated input modalities from a live `/v1/models` entry
 * (`input_modalities`, codex format). Unknown or missing values degrade to
 * text-only, matching the official catalog's conservative default.
 */
function liveInputModalities(entry) {
  const mods = Array.isArray(entry?.input_modalities) ? entry.input_modalities : [];
  const valid = mods.filter((modality) => modality === "text" || modality === "image");
  return valid.length > 0 ? [...new Set(valid)] : ["text"];
}

/**
 * Parse the platform's credit declaration into the `×0.06` suffix appended to
 * a model name. The platform writes these as `"x0.06 credits"` (product.json /
 * models_config.json), and the proxy relays the string verbatim; a bare number
 * or an already-compact `×1.62` also parses. Anything without a recognizable
 * number yields `undefined`, so callers omit the suffix rather than guess —
 * an unknown multiplier must not be rendered as 0.
 */
function creditsMultiplier(value) {
  if (typeof value !== "string") return undefined;
  const match = /^[x×*]?\s*(\d+(?:\.\d+)?)\s*(?:credits?)?$/i.exec(value.trim());
  return match === null ? undefined : `×${match[1]}`;
}

/** Append the credit multiplier to a model's display name, when declared. */
function withCredits(name, credits) {
  const multiplier = creditsMultiplier(credits);
  return multiplier === undefined ? name : `${name} ${multiplier}`;
}


// #region serialize

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

/** Serialize one assistant message (text + tool calls). */
function serializeAssistant(message) {
  const text = flattenText(message.content);
  const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: block.arguments },
  }));
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Serialize the harness conversation into OpenAI chat-completions wire
 * messages. `tool-result` blocks become standalone `{role: 'tool'}` messages;
 * image blocks are read through the durable attachment service and emitted as
 * OpenAI `image_url` parts (`data:<mime>;base64,<bytes>`), which the
 * workbuddy2api proxy passes through to the upstream platform. When the
 * attachment service is unavailable, image input degrades to the stable
 * `UNSUPPORTED_CONTENT` error.
 */
async function serializeMessages(messages, attachments, signal) {
  const refs = new Map();
  for (const message of messages) collectImageRefs(message.content, refs);
  const requestImages = new Map();
  if (refs.size > 0) {
    if (attachments === undefined) {
      throw new LlmError("WorkBuddy image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
    }
    // Keep images small enough for the upstream platform: the proxy relays the
    // base64 body verbatim, and oversized payloads are dropped/ignored upstream
    // (models reply "no image attached"). Mirror the official adapter budgets.
    const policy = { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 };
    const ordered = [...refs.values()];
    const prepared = await Promise.all(ordered.map((ref) => attachments.readImageRequest(ref, policy, signal)));
    for (let index = 0; index < ordered.length; index += 1) {
      requestImages.set(ordered[index].attachmentId, prepared[index]);
    }
  }
  const wire = [];
  for (const message of messages) {
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const text = flattenText(message.content);
    const images = message.content.filter((block) => block.type === "image");
    if (text.length > 0 || toolResults.length === 0) {
      if (images.length > 0) {
        const parts = [];
        if (text.length > 0) parts.push({ type: "text", text });
        for (const block of images) {
          const version = requestImages.get(block.attachment.attachmentId);
          if (version === undefined) {
            throw new LlmError("WorkBuddy image input missing attachment bytes", "UNSUPPORTED_CONTENT");
          }
          parts.push({
            type: "image_url",
            image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString("base64")}` },
          });
        }
        wire.push({ role: "user", content: parts });
      } else {
        wire.push({ role: "user", content: text });
      }
    }
    for (const result of toolResults) {
      wire.push({ role: "tool", tool_call_id: result.toolCallId, content: flattenText(result.content) || "(no output)" });
    }
  }
  return wire;
}

/** Collect image attachment refs from a content block list (recursing into tool results). */
function collectImageRefs(blocks, refs) {
  for (const block of blocks) {
    if (block.type === "image") refs.set(block.attachment.attachmentId, block.attachment);
    else if (block.type === "tool-result") collectImageRefs(block.content, refs);
  }
}

/** Build the full wire request. Always streaming with usage reporting on. */
async function serializeRequest(options, attachments, signal) {
  const messages = [];
  if (options.system !== undefined) messages.push({ role: "system", content: options.system });
  messages.push(...await serializeMessages(options.messages, attachments, signal));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
    // reasoning_effort is opaque here (low|medium|high); the proxy passes it
    // through verbatim to the upstream /v2/chat/completions body.
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }),
  };
}

// #endregion

// #region sse

/**
 * Parse one SSE event block (lines separated by \n, fields `field: value`).
 * Returns the joined `data` payload, or `undefined` when the event carries no
 * data field. Comment lines (starting with `:`) are transport activity.
 */
function parseEvent(raw) {
  let data;
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /, "");
      data = data === undefined ? value : `${data}\n${value}`;
    }
  }
  return data;
}

/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it (truncated response — the model call cannot be trusted).
 */
async function* parseSse(stream, onComment) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = parseEvent(raw);
        if (data !== undefined) {
          if (onComment !== undefined) onComment();
          yield data;
          if (data === "[DONE]") return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new LlmError("WorkBuddy SSE stream ended without [DONE]", "STREAM_CLOSED");
}

// #endregion

// #region translate

/** Map the wire finish_reason vocabulary to the harness FinishReason. */
function mapFinishReason(reason) {
  switch (reason) {
    case "stop": return { kind: "stop" };
    case "tool_calls": return { kind: "tool-calls" };
    case "length": return { kind: "max-tokens" };
    default: return {
      kind: "error",
      failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
    };
  }
}

/**
 * Map wire usage fields to the harness DISJOINT TokenUsage convention
 * (cache reads are subtracted out of `inputTokens`).
 */
function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  // The upstream reports per-request `credit` consumption in the usage block
  // (e.g. deepseek-v4-pro → 0.02). Free/discounted models report 0, so we
  // only keep the field when it is a positive number — that is the real
  // 积分 spend we want to surface (the proxy exposes no balance endpoint).
  const credit = typeof usage.credit === "number" && usage.credit > 0 ? usage.credit : undefined;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(credit !== undefined ? { credit } : {}),
  };
}

// #region usage ledger

/** Resolve the usage ledger file under DSH_HOME (falls back to ~/.dsh). */
function usageLedgerPath() {
  const configured = process.env.DSH_HOME;
  if (configured !== undefined && configured.trim().length > 0) {
    return join(configured, USAGE_DIR_NAME, USAGE_FILE_NAME);
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".dsh", USAGE_DIR_NAME, USAGE_FILE_NAME);
}

/** Append one completed request's token usage to the ledger (best-effort). */
function recordUsage(model, usage) {
  if (usage === undefined) return;
  try {
    const file = usageLedgerPath();
    mkdirSync(dirname(file), { recursive: true });
    const line = JSON.stringify({
      ts: Date.now(),
      model,
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      reasoning: usage.reasoningTokens ?? 0,
      credit: usage.credit ?? 0,
    });
    appendFileSync(file, `${line}\n`);
    // Trim the ledger when it exceeds the cap: keep only the newest lines.
    const size = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
    if (size > USAGE_MAX_LINES) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-USAGE_MAX_LINES);
      const fd = openSync(file, "w");
      try { writeSync(fd, `${lines.join("\n")}\n`); } finally { closeSync(fd); }
    }
  } catch {
    // usage recording must never break the request path
  }
}

/** Read the ledger and aggregate into daily/model breakdowns. */
function readUsageLedger() {
  const file = usageLedgerPath();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const byModel = new Map();
  let todayInput = 0;
  let todayOutput = 0;
  let todayCredit = 0;
  let todayRequests = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCredit = 0;
  let totalRequests = 0;
  if (!existsSync(file)) {
    return { today: { inputTokens: 0, outputTokens: 0, credit: 0, requests: 0 }, byModel: [], total: { inputTokens: 0, outputTokens: 0, credit: 0, requests: 0 } };
  }
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const input = entry.input ?? 0;
    const output = entry.output ?? 0;
    const credit = entry.credit ?? 0;
    totalInput += input;
    totalOutput += output;
    totalCredit += credit;
    totalRequests += 1;
    if ((entry.ts ?? 0) >= todayMs) {
      todayInput += input;
      todayOutput += output;
      todayCredit += credit;
      todayRequests += 1;
    }
    const model = String(entry.model ?? "unknown");
    const agg = byModel.get(model) ?? { inputTokens: 0, outputTokens: 0, credit: 0, requests: 0 };
    agg.inputTokens += input;
    agg.outputTokens += output;
    agg.credit += credit;
    agg.requests += 1;
    byModel.set(model, agg);
  }
  const byModelList = [...byModel.entries()]
    .map(([model, agg]) => ({ model, ...agg }))
    .sort((a, b) => b.credit - a.credit || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  return {
    today: { inputTokens: todayInput, outputTokens: todayOutput, credit: todayCredit, requests: todayRequests },
    byModel: byModelList,
    total: { inputTokens: totalInput, outputTokens: totalOutput, credit: totalCredit, requests: totalRequests },
  };
}

// #endregion

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
  switch (block.kind) {
    case "text": return { type: "text", text: block.text };
    case "reasoning": return { type: "reasoning", text: block.text };
    case "tool-call": return {
      type: "tool-call",
      id: CallId(block.callId ?? ""),
      name: block.name ?? "",
      arguments: block.text,
    };
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Handles standard OpenAI streaming: `delta.content`, `delta.reasoning_content`
 * (DeepSeek-style thinking, surfaced by the proxy's DSML parsing) and
 * `delta.tool_calls` keyed by `call.index`. `block-end`s, `usage`, and
 * `finish` are all deferred to the `[DONE]` sentinel.
 */
async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;

  function open(kind) {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  }

  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      for (const block of order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      const reason = pendingFinish ?? { kind: "stop" };
      yield {
        type: "finish",
        reason: reason.kind === "stop" && order.length === 0
          ? { kind: "error", failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE } }
          : reason,
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        // The CodeBuddy upstream repeats `function.name: ""` (and omits `id`)
        // on every argument chunk after the first. Treat empty strings as
        // absent so the first captured id/name is never clobbered.
        if (typeof call.id === "string" && call.id.length > 0) block.callId = call.id;
        const toolName = call.function?.name;
        if (typeof toolName === "string" && toolName.length > 0) block.name = toolName;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: CallId(block.callId ?? ""),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        };
      }
      // Hy (Hunyuan) models emit `"finish_reason": ""` on every intermediate
      // chunk; only treat a non-empty vocabulary value as the real finish.
      if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  throw new LlmError("WorkBuddy SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}

// #endregion

// #region adapter

/** Display metadata for one catalog entry. */
function modelInfo(provider, model) {
  const reasoning = modelReasoningInfo(model.reasoningEffort);
  return {
    provider,
    id: model.id,
    name: withCredits(model.name ?? model.id, model.credits),
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: model.inputModalities ?? ["text"],
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/** Normalize a Retry-After header into milliseconds, when valid. */
function providerRetryAfterMs(value) {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

/** Opaque provider request id from response headers, when present. */
function requestId(headers) {
  const value = headers.get("x-request-id") ?? headers.get("x-deepseek-request-id");
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}

/** Map an HTTP status plus provider error detail to a stable LlmError code. */
function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 413) return "INVALID_REQUEST";
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/**
 * The WorkBuddy adapter: fetch + SSE against the OpenAI-compatible
 * workbuddy2api proxy, emitting harness StreamChunks. Connection facts arrive
 * through a thunk resolved once per operation, so the registering plugin owns
 * validation and layering.
 */
export class WorkBuddyAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
  }

  providerInfo(provider) {
    return { id: provider, name: "WorkBuddy" };
  }

  /** Drop the discovery cache so the next listModels re-fetches from the proxy. */
  refreshModels() {
    this._cache = undefined;
    this._liveMeta = undefined;
  }

  async listModels(provider) {
    const connection = this.config.options();
    if (!connection.discovery) return connection.models.map((model) => modelInfo(provider, model));
    try {
      const cached = this._cache;
      const now = Date.now();
      if (cached !== undefined && now - cached.at < DISCOVERY_TTL_MS) return cached.models;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
      let payload;
      try {
        const response = await fetch(`${connection.baseURL}/models`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        payload = await response.json();
      } finally {
        clearTimeout(timer);
      }
      const byId = new Map(connection.models.map((model) => [model.id, model]));
      // The workbuddy2api proxy answers `{"models": [...]}` with `display_name`
      // fields; plain OpenAI endpoints answer `{"data": [...]}` with `name`.
      const list = payload?.data ?? payload?.models ?? [];
      const live = list
        .map((entry) => ({
          id: String(entry.id),
          name: typeof entry.name === "string"
            ? entry.name
            : typeof entry.display_name === "string"
              ? entry.display_name
              : undefined,
          description: typeof entry.description === "string" && entry.description.length > 0
            ? entry.description
            : undefined,
          // Platform-declared credit multiplier, relayed by the proxy.
          credits: typeof entry.credits === "string" && entry.credits.trim().length > 0
            ? entry.credits.trim()
            : undefined,
          modalities: liveInputModalities(entry),
          contextWindow: Number.isInteger(entry.context_window) && entry.context_window > 0
            ? entry.context_window
            : undefined,
          maxTokens: Number.isInteger(entry.max_context_window) && entry.max_context_window > 0
            ? entry.max_context_window
            : undefined,
        }))
        .filter((entry) => entry.id.length > 0);
      const merged = [];
      const seen = new Set();
      const liveMeta = new Map();
      for (const entry of live) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const catalog = byId.get(entry.id);
        // Retired ids are hidden by name (RETIRED_MODEL_IDS) rather than by
        // absence from the catalog: the proxy still announces models upstream
        // rejects, but a model the platform launches must appear after a
        // refresh without waiting for a new plugin release. The catalog is now
        // only a metadata overlay plus a fallback for unannounced entries.
        if (RETIRED_MODEL_IDS.has(entry.id)) continue;
        const effort = liveReasoningEffort(entry, catalog?.reasoningEffort);
        const reasoning = modelReasoningInfo(effort);
        merged.push({
          provider,
          id: entry.id,
          // The proxy's multiplier tracks the platform; the catalog's is a
          // snapshot, so the live value wins and the catalog only fills gaps.
          name: withCredits(
            entry.name ?? catalog?.name ?? entry.id,
            entry.credits ?? catalog?.credits,
          ),
          ...(catalog?.description !== undefined || entry.description !== undefined
            ? { description: catalog?.description ?? entry.description }
            : {}),
          inputModalities: catalog?.inputModalities ?? entry.modalities,
          ...(reasoning === undefined ? {} : { reasoning }),
        });
        liveMeta.set(entry.id, { contextWindow: entry.contextWindow, maxTokens: entry.maxTokens });
      }
      // Catalog entries the proxy did not announce (e.g. unauthenticated or
      // partial listing) stay selectable.
      for (const model of connection.models) {
        if (seen.has(model.id)) continue;
        merged.push(modelInfo(provider, model));
      }
      const result = merged.length > 0 ? merged : connection.models.map((model) => modelInfo(provider, model));
      this._cache = { at: now, models: result };
      this._liveMeta = liveMeta;
      return result;
    } catch {
      return connection.models.map((model) => modelInfo(provider, model));
    }
  }

  resolveModel(provider, model, _signal) {
    const connection = this.config.options();
    const configured = connection.models.find((entry) => entry.id === model);
    // Models discovered live (proxy-announced, not in the configured catalog)
    // still get their platform-declared capacity from the last discovery.
    const live = this._liveMeta?.get(model);
    const base = configured === undefined
      ? { provider, id: model, name: model, inputModalities: ["text"] }
      : modelInfo(provider, configured);
    return Promise.resolve({
      ...base,
      context: {
        contextWindow: configured?.contextWindow ?? live?.contextWindow ?? connection.defaultContextWindow,
      },
      defaultMaxTokens: configured?.maxTokens ?? live?.maxTokens ?? connection.maxTokens,
    });
  }

  async *stream(options) {
    const connection = this.config.options();
    const consumer = new AbortController();
    const watchdog = idleWatchdog(
      options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]),
      connection.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
    );
    const iterator = this.request(options, watchdog.signal, connection, () => watchdog.pulse())[Symbol.asyncIterator]();
    let exhausted = false;
    let usage;
    try {
      while (true) {
        const result = await watchdog.next(iterator);
        if (result.done) {
          exhausted = true;
          if (usage !== undefined) recordUsage(options.model, usage);
          return;
        }
        if (result.value?.type === "usage") usage = result.value.usage;
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`WorkBuddy stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      }
      if (options.signal?.aborted) throw new LlmError("WorkBuddy request aborted by caller", "ABORTED", { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`WorkBuddy proxy stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    } finally {
      consumer.abort("WorkBuddy stream consumer stopped");
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return();
        } catch (_abortedTransportTeardown) {
          // transport teardown after abort is expected
        }
      }
    }
  }

  async *request(options, signal, connection, onComment) {
    const attachments = this.config.resolveAttachments?.();
    const body = await serializeRequest(options, attachments, signal);
    const headers = {
      "content-type": "application/json",
      "accept": "text/event-stream",
      ...attributionHeaders(),
      ...(connection.apiKey !== undefined && connection.apiKey.length > 0
        ? { authorization: `Bearer ${connection.apiKey}` }
        : {}),
    };
    let response;
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new LlmError(`WorkBuddy proxy request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    }
    if (!response.ok) {
      let message = `WorkBuddy proxy error (HTTP ${response.status})`;
      let providerError;
      try {
        providerError = (await response.json()).error;
        if (providerError?.message) message = providerError.message;
      } catch {
        // non-JSON error body; keep the generic message
      }
      const delay = providerRetryAfterMs(response.headers.get("retry-after"));
      const id = requestId(response.headers);
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        ...(id === undefined ? {} : { requestId: id }),
      });
    }
    if (!response.body) throw new LlmError("WorkBuddy proxy returned no response body", "EMPTY_RESPONSE");
    yield* translate(parseSse(response.body, onComment));
  }
}

// #endregion

// #region config

const MODEL_MODALITIES = ["text", "image"];

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text"]),
  reasoningEffort: z.string(),
  // Platform-declared credit multiplier, e.g. "x0.06 credits"; displayed after
  // the model name as "×0.06".
  credits: z.string(),
});

export const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKey: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  discovery: z.boolean().default(true),
  // Daily checkin: after `checkinAfterHour` local time, claim once per day if
  // the official activity says today is unclaimed. Disable to check in manually.
  autoCheckin: z.boolean().default(true),
  checkinAfterHour: z.number().step(1).min(0).max(23).default(10),
  // Optional path overrides for the login helper. When unset, the plugin uses
  // the login_workbuddy.py bundled with this package and the default session
  // file location (~/.codebuddy-session.json).
  loginScript: z.string(),
  sessionFile: z.string(),
});

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
  const seen = new Set();
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error("dsh-llm-workbuddy: catalog model ids must be non-empty");
    if (model.name !== undefined && model.name.length === 0) throw new Error(`dsh-llm-workbuddy: catalog model "${model.id}" has an empty name`);
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`dsh-llm-workbuddy: catalog model "${model.id}" contextWindow must be a positive integer`);
    }
    if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`dsh-llm-workbuddy: catalog model "${model.id}" maxTokens must be a positive integer`);
    }
    const inputModalities = model.inputModalities ?? ["text"];
    if (inputModalities.length === 0) throw new Error(`dsh-llm-workbuddy: catalog model "${model.id}" inputModalities must not be empty`);
    if (inputModalities.some((modality) => !MODEL_MODALITIES.includes(modality))) {
      throw new Error(`dsh-llm-workbuddy: catalog model "${model.id}" inputModalities must contain only "text" and "image"`);
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`dsh-llm-workbuddy: catalog model "${model.id}" inputModalities must not contain duplicates`);
    }
    if (seen.has(model.id)) throw new Error(`dsh-llm-workbuddy: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    const reasoningEffort = model.reasoningEffort;
    if (reasoningEffort !== undefined && !REASONING_EFFORT_IDS.has(reasoningEffort)) {
      throw new Error(`dsh-llm-workbuddy: catalog model "${model.id}" reasoningEffort must be one of low|medium|high`);
    }
    const credits = typeof model.credits === "string" ? model.credits.trim() : undefined;
    if (credits !== undefined && credits.length > 0 && creditsMultiplier(credits) === undefined) {
      throw new Error(`dsh-llm-workbuddy: catalog model "${model.id}" credits must read like "x0.06 credits"`);
    }
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      inputModalities: [...inputModalities],
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(credits === undefined || credits.length === 0 ? {} : { credits }),
    };
  });
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Judged at load (fail loud) and for each settings snapshot.
 */
export function resolveAdapterOptions(config) {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL;
  if (typeof baseURL !== "string" || baseURL.length === 0) throw new Error("dsh-llm-workbuddy: baseURL must be a non-empty string");
  if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error("dsh-llm-workbuddy: defaultContextWindow must be a positive integer");
  }
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error("dsh-llm-workbuddy: maxTokens must be a positive safe integer");
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-llm-workbuddy: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  const checkinAfterHour = config.checkinAfterHour ?? 10;
  if (!Number.isInteger(checkinAfterHour) || checkinAfterHour < 0 || checkinAfterHour > 23) {
    throw new Error("dsh-llm-workbuddy: checkinAfterHour must be an integer between 0 and 23");
  }
  return {
    baseURL,
    apiKey: config.apiKey,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    discovery: config.discovery ?? true,
    autoCheckin: config.autoCheckin ?? true,
    checkinAfterHour,
    loginScript: config.loginScript,
    sessionFile: config.sessionFile,
  };
}

// #endregion

// #region daily checkin

/** Checkin state file under DSH_HOME (same ledger dir as usage). */
const CHECKIN_FILE_NAME = "checkin.json";
/** How often the auto-claim scheduler wakes up. */
const CHECKIN_INTERVAL_MS = 30 * 60_000;
/** Request timeout for the proxy checkin endpoints. */
const CHECKIN_TIMEOUT_MS = 10_000;
/** How long the login route waits for the device-flow URL before giving up. */
const LOGIN_URL_TIMEOUT_MS = 15_000;

/** Resolve the checkin state file path (same convention as usageLedgerPath). */
function checkinStatePath() {
  const configured = process.env.DSH_HOME;
  if (configured !== undefined && configured.trim().length > 0) {
    return join(configured, USAGE_DIR_NAME, CHECKIN_FILE_NAME);
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".dsh", USAGE_DIR_NAME, CHECKIN_FILE_NAME);
}

/** Read the persisted checkin state. Never throws. */
function readCheckinState() {
  try {
    return JSON.parse(readFileSync(checkinStatePath(), "utf-8"));
  } catch {
    return {};
  }
}

/** Persist the checkin state (best-effort; failure must not break the caller). */
function writeCheckinState(state) {
  try {
    const file = checkinStatePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // persistence is advisory
  }
}

/** Local calendar date (`YYYY-MM-DD`) for "did we already handle today". */
function localDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Call a proxy checkin endpoint. `method` defaults to GET (status probe);
 * claiming passes "POST". Returns the parsed body (with the HTTP status under
 * `httpStatus`) or an error shape.
 *
 * `missing: true` marks the specific "this proxy does not implement the
 * checkin API" case (HTTP 404/405 on the probe). It is kept distinct from a
 * transport error because the two need opposite handling: a missing endpoint is
 * permanent for the running proxy (hide the feature), a transport error is
 * transient (retry later).
 */
async function proxyCheckinCall(baseURL, path, method = "GET") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECKIN_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}${path}`, {
      method,
      ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const missing = response.status === 404 || response.status === 405;
      return {
        httpStatus: response.status,
        error: `HTTP ${response.status} (${method} ${path})`,
        ...(missing ? { missing: true } : {}),
        // Body fields ride along both flattened and under `body`: the old shape
        // kept them under `body`, and `runCheckinOnce` still reads
        // `claim.body.detail` for its failure message.
        ...(body !== null && typeof body === "object" ? body : {}),
        ...(body !== null && typeof body === "object" ? { body } : {}),
      };
    }
    // `httpStatus` rides along even on success so callers can classify the
    // endpoint by HTTP status rather than by "did an error string appear".
    // It must NOT be named `status`: the proxy's own checkin body already has a
    // `status: "ok"` field that would clobber it when spread.
    return body !== null && typeof body === "object"
      ? { httpStatus: response.status, ...body }
      : { httpStatus: response.status, error: "empty response" };
  } catch (error) {
    return { error: String(error?.cause?.message ?? error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cached answer to "does this proxy implement the checkin API at all?".
 *
 * workbuddy2api has never shipped `/checkin-status` / `/checkin` on any branch
 * or PyPI release, so the plugin probes once (and then at most every
 * {@link CHECKIN_CAPABILITY_TTL_MS}) and hides the feature instead of
 * hammering a 404 and recording a fresh failure every day.
 *
 * `supported` is tri-state: `true` (endpoint answered, whatever the status),
 * `false` (404/405 — the route does not exist), `null` (never probed, or the
 * proxy was unreachable so the answer is genuinely unknown).
 */
const CHECKIN_CAPABILITY_TTL_MS = 30 * 60_000;
let _checkinCapability = { supported: null, error: null, checkedAt: 0 };

/** Last known checkin-support verdict, without touching the network. */
function checkinCapability() {
  return _checkinCapability;
}

/** Probe checkin support, reusing the cached verdict until it goes stale. */
async function probeCheckinCapability(baseURL, options = {}) {
  const { force = false } = options;
  const cached = _checkinCapability;
  if (!force && cached.checkedAt > 0 && Date.now() - cached.checkedAt < CHECKIN_CAPABILITY_TTL_MS) {
    return cached;
  }
  const probe = await proxyCheckinCall(baseURL, "/checkin-status");
  // Classify by HTTP status, not by the presence of an error string:
  // - 404/405 → the route does not exist on this proxy (conclusive);
  // - any other HTTP status (including 401/503 from an unauthenticated proxy)
  //   proves the endpoint exists, so the feature stays offered;
  // - no status at all → transport failure; the answer is unknown, and a
  //   transient outage must never permanently hide the feature.
  const supported = probe?.missing === true
    ? false
    : typeof probe?.httpStatus === "number"
      ? true
      : null;
  _checkinCapability = {
    supported,
    error: supported === false ? probe.error : null,
    checkedAt: Date.now(),
  };
  return _checkinCapability;
}

/** Whether an upstream claim rejection means "already claimed today". */
function alreadyClaimedMessage(msg) {
  return typeof msg === "string" && /(已签到|已经签到|already)/i.test(msg);
}

/**
 * Run one auto-claim pass. Idempotent per local calendar day:
 * - before `checkinAfterHour` (default 10:00) local time: no-op;
 * - proxy does not implement the checkin API (404/405): no-op, no state change;
 * - already handled today (persisted state): no-op;
 * - official status says already checked in: mark handled, done;
 * - activity not open (no status data): mark handled so we stop retrying today;
 * - otherwise claim, persisting the reward (credit, streak) on success.
 * Concurrent invocations collapse into the first caller via `inFlight`.
 * @returns the resulting state snapshot, or undefined when skipped/in-flight.
 */
async function runCheckinOnce(baseURL, config, logger) {
  // Learn whether this proxy can check in at all *before* any gate: the verdict
  // is what the widget uses to decide whether to offer the 「签到」 entry, so it
  // must be populated on startup — and also when auto-claim is disabled, where
  // this pass does nothing else. The probe is cached (30 min), so this is at
  // most one cheap GET per scheduler tick.
  const capability = await probeCheckinCapability(baseURL);
  if (capability.supported === false) {
    logger?.debug?.(`dsh-llm-workbuddy: checkin API unavailable on this proxy (${capability.error})`);
    return undefined;
  }
  if (!config.autoCheckin) return undefined;
  const now = new Date();
  if (now.getHours() < config.checkinAfterHour) return undefined;
  const today = localDateStr(now);
  const state = readCheckinState();
  if (state.handledDate === today) return state;
  if (runCheckinOnce._inFlight) return undefined;
  runCheckinOnce._inFlight = true;
  try {
    const status = await proxyCheckinCall(baseURL, "/checkin-status");
    // The probe can disagree with the cached verdict (older proxy, route added
    // mid-flight): trust the live 404 and stop instead of recording a failure.
    if (status?.missing === true) {
      _checkinCapability = { supported: false, error: status.error, checkedAt: Date.now() };
      logger?.debug?.(`dsh-llm-workbuddy: checkin API unavailable on this proxy (${status.error})`);
      return undefined;
    }
    const data = status?.upstream?.data;
    if (!data) {
      // Activity closed / proxy unreachable / not authenticated: stop for today.
      const next = {
        ...state,
        handledDate: today,
        lastResult: { ok: false, message: status?.error ?? status?.upstream?.msg ?? "签到活动不可用", at: now.getTime() },
      };
      writeCheckinState(next);
      logger?.debug?.(`dsh-llm-workbuddy: checkin skipped today (${next.lastResult.message})`);
      return next;
    }
    if (data.today_checked_in) {
      const next = {
        ...state,
        handledDate: today,
        lastResult: { ok: true, message: "今日已签到（官方确认）", streakDays: data.streak_days, at: now.getTime() },
      };
      writeCheckinState(next);
      return next;
    }
    const claim = await proxyCheckinCall(baseURL, "/checkin", "POST");
    const payload = claim?.upstream?.data;
    // "Already claimed" rejections count as handled (the goal is covered).
    const ok = Boolean(payload) || alreadyClaimedMessage(claim?.upstream?.msg);
    const failureDetail = [claim?.upstream?.msg, claim?.error, claim?.body?.detail]
      .filter(Boolean).join(" ") || "签到失败";
    const next = {
      ...state,
      handledDate: today,
      lastResult: {
        ok,
        message: ok
          ? payload?.credit !== undefined
            ? `自动签到成功：+${payload.credit} 积分`
            : "今日已签到"
          : failureDetail,
        ...(payload?.credit !== undefined ? { credit: payload.credit } : {}),
        ...(payload?.streak_days !== undefined ? { streakDays: payload.streak_days } : {}),
        at: now.getTime(),
      },
    };
    writeCheckinState(next);
    logger?.info?.(`dsh-llm-workbuddy: ${next.lastResult.message}`);
    return next;
  } finally {
    runCheckinOnce._inFlight = false;
  }
}

/**
 * Start the auto-claim scheduler: one immediate pass plus a low-frequency
 * interval. The interval survives plugin-lifetime only (disposed with the
 * fiber), and every pass re-reads the live config so settings hot-edit
 * (autoCheckin / checkinAfterHour) applies to the very next pass.
 */
function startCheckinScheduler(ctx, options) {
  const tick = () => {
    const connection = options();
    runCheckinOnce(connection.baseURL, connection, ctx.logger).catch((error) => {
      ctx.logger.warn("dsh-llm-workbuddy: auto checkin pass failed");
      ctx.logger.warn(error);
    });
  };
  tick();
  const timer = setInterval(tick, CHECKIN_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// #endregion

// #region login status web API

/**
 * Resolve the runtime paths for the login helper and session file.
 *
 * Precedence:
 *   1. explicit `loginScript` / `sessionFile` config (paths may be absolute
 *      or relative to the process CWD);
 *   2. bundled `login_workbuddy.py` (this package ships a copy) and the
 *      conventional `~/.codebuddy-session.json`;
 *   3. legacy fallback: the monorepo layout `dsh-workbuddy/` (two levels up
 *      from the plugin dir) that held `login_workbuddy.py` and
 *      `.workbuddy/session.json`.
 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

function defaultSessionFile() {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return home ? resolve(home, ".codebuddy-session.json") : resolve(PLUGIN_DIR, ".codebuddy-session.json");
}

function resolveLoginPaths(config) {
  const configSession = config?.sessionFile;
  const configScript = config?.loginScript;

  let sessionFile;
  if (typeof configSession === "string" && configSession.length > 0) {
    sessionFile = resolve(configSession);
  } else {
    // Legacy monorepo layout: dsh-workbuddy/.workbuddy/session.json
    const legacyRoot = resolve(PLUGIN_DIR, "..", "..");
    const legacySession = resolve(legacyRoot, ".workbuddy", "session.json");
    sessionFile = existsSync(legacySession) ? legacySession : defaultSessionFile();
  }

  let loginScript;
  if (typeof configScript === "string" && configScript.length > 0) {
    loginScript = resolve(configScript);
  } else {
    // Bundled copy ships at the package root (dsh-llm-workbuddy/login_workbuddy.py).
    loginScript = resolve(PLUGIN_DIR, "..", "login_workbuddy.py");
  }

  return { sessionFile, loginScript };
}

/**
 * Decode a JWT payload without verifying its signature. The session's tokens
 * are issued by the WorkBuddy IdP and we only read claims (`exp`) to recover an
 * expiry the writer omitted — never to trust the token. Returns null for an
 * opaque (non-JWT) or malformed token.
 */
function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    const claims = JSON.parse(json);
    return claims !== null && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a numeric instant to epoch milliseconds. Values below this floor
 * cannot be a millisecond epoch this century, so the writer must have used
 * seconds (the IdP's own unit for JWT `exp`).
 */
function toEpochMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e11 ? Math.round(value * 1000) : value;
}

/** A JWT's `exp` claim, in epoch ms. Null when absent/opaque. */
function jwtExpiresAt(token) {
  return toEpochMs(decodeJwtPayload(token)?.exp);
}

/**
 * Derive when the stored session actually stops working.
 *
 * The proxy (workbuddy2api) writes the IdP token payload verbatim, which has no
 * `expiresAt` — judging "no expiresAt ⇒ still valid" made the login state
 * permanently green. Sources are tried most authoritative first:
 *
 *   1. the **refresh** token's JWT `exp` — the proxy refreshes an expired access
 *      token automatically, so the refresh token's lifetime is what really
 *      bounds the session. Judging by the access token alone would turn the
 *      capsule red while requests still succeed;
 *   2. `auth.expiresAt` — written by this plugin's own login script (also the
 *      access token's lifetime, hence below the refresh bound);
 *   3. the **access** token's JWT `exp`;
 *   4. `auth.expiresIn` counted from the session file's mtime — the last resort
 *      for opaque tokens; the mtime is refreshed whenever the proxy re-writes
 *      the session, so this can only under-estimate, never over-estimate.
 *
 * Yielding no instant at all means the validity is genuinely unknown
 * (`source: null`) and must be reported as such rather than assumed valid.
 */
function resolveSessionExpiry(raw, sessionFile) {
  const accessJwt = jwtExpiresAt(raw?.auth?.accessToken);
  const refreshJwt = jwtExpiresAt(raw?.auth?.refreshToken);
  const explicit = toEpochMs(raw?.auth?.expiresAt);

  if (refreshJwt !== null) {
    return { accessExpiresAt: accessJwt ?? explicit, refreshExpiresAt: refreshJwt, expiresAt: refreshJwt, source: "jwt-refresh" };
  }
  if (explicit !== null) {
    return { accessExpiresAt: explicit, refreshExpiresAt: null, expiresAt: explicit, source: "expiresAt" };
  }
  if (accessJwt !== null) {
    return { accessExpiresAt: accessJwt, refreshExpiresAt: null, expiresAt: accessJwt, source: "jwt" };
  }

  const expiresIn = raw?.auth?.expiresIn;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    try {
      const fromMtime = Math.round(statSync(sessionFile).mtimeMs) + expiresIn * 1000;
      return { accessExpiresAt: fromMtime, refreshExpiresAt: null, expiresAt: fromMtime, source: "expiresIn" };
    } catch {
      // fall through to "unknown"
    }
  }

  return { accessExpiresAt: null, refreshExpiresAt: null, expiresAt: null, source: null };
}

/**
 * Read the local WorkBuddy session file and derive its validity. Returns a
 * normalized status object the Web widget polls. Never throws — missing or
 * malformed state is reported as `authenticated: false` so the UI can prompt.
 *
 * `expiresAt` is the instant that bounds the session (see
 * {@link resolveSessionExpiry}); `expiryKnown: false` means no expiry could be
 * derived, and `reloginRecommended` is the recovery hint the widget shows.
 */
function readSessionStatus(sessionFile) {
  const empty = {
    sessionFile: false,
    authenticated: false,
    expiresAt: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
    expiresAtSource: null,
    expiryKnown: false,
    expired: false,
    tokenPresent: false,
    reloginRecommended: true,
    account: null,
  };
  if (!existsSync(sessionFile)) return empty;
  try {
    const raw = JSON.parse(readFileSync(sessionFile, "utf-8"));
    const tokenPresent = Boolean(raw?.auth?.accessToken);
    const expiry = resolveSessionExpiry(raw, sessionFile);
    const expired = expiry.expiresAt !== null && expiry.expiresAt <= Date.now();
    return {
      sessionFile: true,
      authenticated: tokenPresent && !expired,
      expiresAt: expiry.expiresAt,
      accessExpiresAt: expiry.accessExpiresAt,
      refreshExpiresAt: expiry.refreshExpiresAt,
      expiresAtSource: expiry.source,
      expiryKnown: expiry.expiresAt !== null,
      expired,
      tokenPresent,
      // The login button must stay a way out: no token, a passed expiry, or an
      // expiry we cannot derive all mean "offer a re-login".
      reloginRecommended: !tokenPresent || expired || expiry.expiresAt === null,
      account: raw?.account ?? null,
    };
  } catch {
    return { ...empty, sessionFile: true };
  }
}

/**
 * Probe the local workbuddy2api proxy health endpoint. Returns
 * `{ proxyUp, tokenValid }`; a missing/unreachable proxy is reported as
 * `proxyUp: false` without throwing, so the widget can show a clear state.
 */
async function probeProxy(baseURL) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${baseURL.replace(/\/v1\/?$/, "")}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return { proxyUp: true, tokenValid: false };
    const body = await response.json().catch(() => ({}));
    return { proxyUp: true, tokenValid: Boolean(body?.authenticated ?? body?.token_valid) };
  } catch {
    return { proxyUp: false, tokenValid: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe whether the proxy can actually complete a chat completion, not just
 * answer `/health`. `/health` reflects the proxy process alone — it stays
 * `authenticated: true` even when the process points at a deleted/old path
 * and every model request fails with `[Errno 2] No such file or directory`.
 * Sending one minimal request is the only probe that catches that class of
 * "capsule shows green but models are all down" false positive.
 * @returns `{ chatWorking, chatError? }` where `chatWorking` is true only
 * when the proxy returned a non-streamed completion.
 */
async function probeChatWorking(baseURL) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const endpoint = `${baseURL.replace(/\/v1\/?$/, "")}/v1/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "hy3",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { chatWorking: false, chatError: `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }
    const body = await response.json().catch(() => null);
    const choice = body?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === "string" && content.length > 0) {
      return { chatWorking: true };
    }
    // A reasoning model spends the whole 4-token cap on thinking and answers
    // with `content: ""` + `finish_reason: "length"` — that is a healthy proxy,
    // not an empty response (probed against hy3, which is all-thinking at this
    // cap). Any billed completion token proves the upstream round trip worked.
    const completionTokens = body?.usage?.completion_tokens;
    if (choice !== undefined && typeof completionTokens === "number" && completionTokens > 0) {
      return { chatWorking: true };
    }
    return { chatWorking: false, chatError: "代理返回了空响应" };
  } catch (error) {
    return { chatWorking: false, chatError: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The restart command shown by the diagnose route. It adapts to two layouts:
 * - Local monorepo dev: the plugin sits inside a `dsh-workbuddy/` checkout with
 *   `start-workbuddy.sh` two levels up — use the workspace-local script.
 * - Standard install (any other machine): no `start-workbuddy.sh`, so show the
 *   upstream README command for running the workbuddy2api proxy via uv.
 */
function diagnoseRestartCommand() {
  const workspaceRoot = resolve(PLUGIN_DIR, "..", "..");
  const localScript = resolve(workspaceRoot, "start-workbuddy.sh");
  if (existsSync(localScript)) {
    return [
      "# 检测到本机 monorepo 布局（dsh-workbuddy/），用仓库脚本重启代理",
      "# 停掉旧代理（若 8787 被占用）",
      "lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill",
      "",
      "# 重启代理（脚本路径自动定位到本仓库）",
      `cd ${workspaceRoot} && ./start-workbuddy.sh`,
    ].join("\n");
  }
  return [
    "# 用 workbuddy2api 代理（标准安装）重启：",
    "# 停掉旧代理（若 8787 被占用）",
    "lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill",
    "",
    "# 安装/升级代理（需 >= 2.0.4；详见 README「安装代理」）",
    "uv tool install -U workbuddy2api",
    "workbuddy2api --desensitize \\",
    "  --session-file ~/.codebuddy-session.json --log-file ~/.codebuddy-proxy.jsonl",
  ].join("\n");
}

/**
 * Register the WorkBuddy web API routes on the DSH web server:
 * - `GET  /api/workbuddy/status`         login/proxy health + checkin digest;
 * - `POST /api/workbuddy/login`          device-flow login kick-off;
 * - `POST /api/workbuddy/diagnose`       real end-to-end health probe;
 * - `GET  /api/workbuddy/usage`          token usage ledger;
 * - `POST /api/workbuddy/refresh-models` drop the discovery cache, re-read the
 *   proxy model list (which tracks the official WorkBuddy app), and announce
 *   `llm/adapters-updated` so open model pickers reload immediately;
 * - `GET  /api/workbuddy/checkin`        today's checkin state (official query);
 * - `POST /api/workbuddy/checkin`        claim now (idempotent upstream).
 */
function registerWorkbuddyRoutes(ctx, config, adapter, providersHandle) {
  // Delay registration until the webServer service exists. The plugin keeps
  // `webServer` OUT of `inject` so headless profiles (no HTTP surface) still
  // load — but a synchronous `ctx.get("webServer")` probe at apply time races
  // the webserver plugin's own mount and can observe the service before it is
  // provided, silently dropping the routes. `ctx.inject` runs this callback
  // only once webServer is available, and skips it entirely when the service
  // never appears (headless), preserving the original intent.
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;
    const baseURL = config_baseURL();
    const { sessionFile, loginScript } = resolveLoginPaths(config);
    // The register() call returns a disposer. Wrapping it in ctx.effect ties
    // it to the plugin fiber so config hot-edit / reload cleans the routes up
    // instead of leaking them (a leaked route makes a duplicate re-register
    // throw). Method filtering must be done inside the handler — the route API
    // only accepts `{ kind, path, handler }`.
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/api/workbuddy/status",
      async handler(req, res) {
        if (req.method !== "GET") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        const session = readSessionStatus(sessionFile);
        const proxy = await probeProxy(baseURL);
        // Checkin digest comes from the persisted state only — never block the
        // 5s status poll with an upstream call. Support comes from the cached
        // capability verdict (also populated by the scheduler and the checkin
        // route), so the widget can hide an entry this proxy cannot serve.
        const checkinState = readCheckinState();
        const capability = checkinCapability();
        const today = localDateStr();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ...session,
          ...proxy,
          loginScriptAvailable: existsSync(loginScript),
          checkin: {
            supported: capability.supported,
            autoEnabled: config?.autoCheckin ?? true,
            handledToday: checkinState.handledDate === today,
            lastResult: checkinState.lastResult ?? null,
          },
        }));
      },
    }));
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/api/workbuddy/login",
      async handler(req, res) {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        if (!existsSync(loginScript)) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "login_workbuddy.py not found" }));
          return;
        }
        // `force` re-runs the device flow even when the stored session still
        // looks valid. Status judgement is a heuristic (the proxy's session
        // file carries no `expiresAt`), so the login button must never be a
        // dead end when a token is wrong/revoked but still not-yet-expired.
        let force = false;
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
        } catch {
          // malformed URL: treat as non-forced
        }
        // Existing session is fine; no need to re-run the flow.
        const existing = readSessionStatus(sessionFile);
        if (existing.authenticated && !force) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ alreadyLoggedIn: true, authUrl: null, ...existing }));
          return;
        }
        // login_workbuddy.py is dependency-free (stdlib only), so we invoke it
        // directly with the system Python — no uv runtime required.
        const args = ["-u", loginScript, "--session-file", sessionFile];
        const child = spawn("python3", args, { env: { ...process.env, PYTHONUNBUFFERED: "1" } });
        let stdout = "";

        // The device-flow URL is printed as soon as the flow starts (before the
        // long poll for completion), but it is never available synchronously —
        // answering immediately always returned `authUrl: null`, which the
        // widget turned into "clicked login, nothing happened". Resolve on the
        // first URL, on child exit, or on the timeout, whichever comes first.
        const outcome = await new Promise((resolve) => {
          let done = false;
          const finish = (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(value);
          };
          // Bounded wait. This timer is deliberately NOT unref'd: it is the only
          // thing guaranteeing the route answers even when nothing else holds
          // the event loop open. It is cleared the moment the child answers, so
          // it never outlives the request.
          const timer = setTimeout(
            () => finish({ authUrl: null, error: `登录脚本未在 ${Math.round(LOGIN_URL_TIMEOUT_MS / 1000)} 秒内输出授权链接（检查系统 python3 是否可用）` }),
            LOGIN_URL_TIMEOUT_MS,
          );
          child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
            const m = stdout.match(/https?:\/\/\S+/);
            if (m) finish({ authUrl: m[0] });
          });
          child.stderr.on("data", () => {});
          child.on("error", (error) => {
            finish({ authUrl: null, error: `无法启动 python3：${String(error?.message ?? error)}` });
          });
          child.on("close", (code) => {
            finish({
              authUrl: null,
              error: code === 0
                ? "登录脚本已结束，但没有输出授权链接"
                : `登录脚本异常退出（exit code ${code}）`,
            });
          });
          // Keep the pipe drained so a chatty child cannot block on a full
          // stdout buffer after we have answered.
          child.stdout.resume();
          child.unref?.();
        });

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(outcome.authUrl === null
          ? { authUrl: null, pending: false, error: outcome.error }
          : { authUrl: outcome.authUrl, pending: true }));
      },
    }));
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/api/workbuddy/diagnose",
      async handler(req, res) {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        // Real health: probe /health AND actually complete a chat. /health
        // alone stays green even when the proxy points at a deleted path and
        // every model request 500s — the exact "capsule green but models dead"
        // false positive the diagnose button exists to surface.
        const session = readSessionStatus(sessionFile);
        const health = await probeProxy(baseURL);
        const chat = await probeChatWorking(baseURL);
        const ok = Boolean(health.proxyUp && health.tokenValid && session.authenticated && chat.chatWorking);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok,
          session: {
            file: session.sessionFile,
            authenticated: session.authenticated,
            expiresAt: session.expiresAt,
            expiresAtSource: session.expiresAtSource,
            expiryKnown: session.expiryKnown,
            refreshExpiresAt: session.refreshExpiresAt,
            reloginRecommended: session.reloginRecommended,
          },
          health,
          chat,
          loginScriptAvailable: existsSync(loginScript),
          restartCommand: ok ? null : diagnoseRestartCommand(),
        }));
      },
    }));
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/api/workbuddy/usage",
      async handler(req, res) {
        if (req.method !== "GET") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(readUsageLedger()));
      },
    }));
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/api/workbuddy/refresh-models",
      async handler(req, res) {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        // Drop the discovery cache so listModels re-reads the proxy, then
        // re-commit the (unchanged) configurable-provider entries: commit is
        // the one mutation point that publishes `llm/adapters-updated`, which
        // makes every open model picker reload immediately.
        adapter.refreshModels();
        let announced = true;
        try {
          providersHandle?.replace?.([{ provider: PROVIDER, displayName: "WorkBuddy", settingsNs: NS, settingsPath: [] }]);
        } catch (error) {
          announced = false;
          ctx.logger.warn("dsh-llm-workbuddy: failed to announce adapters-updated");
          ctx.logger.warn(error);
        }
        const models = await adapter.listModels(PROVIDER).catch(() => []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, announced, count: models.length, models }));
      },
    }));
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/api/workbuddy/checkin",
      async handler(req, res) {
        // GET: today's persisted state plus a fresh official status probe.
        if (req.method === "GET") {
          const state = readCheckinState();
          const upstream = await proxyCheckinCall(baseURL, "/checkin-status");
          const data = upstream?.upstream?.data ?? null;
          // A 404/405 proves the running proxy has no checkin API at all; the
          // widget hides the entry rather than offering a button that can only
          // fail.
          const supported = upstream?.missing === true ? false : true;
          _checkinCapability = { supported, error: supported ? null : upstream.error, checkedAt: Date.now() };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            supported,
            handledToday: state.handledDate === localDateStr(),
            lastResult: state.lastResult ?? null,
            official: data === null ? null : {
              active: Boolean(data.active),
              todayCheckedIn: Boolean(data.today_checked_in),
              streakDays: data.streak_days ?? null,
              todayCredit: data.today_credit ?? null,
              streakBonusDays: data.streak_bonus_days ?? null,
              streakBonusCredit: data.streak_bonus_credit ?? null,
            },
            ...(upstream?.error ? { error: upstream.error } : {}),
          }));
          return;
        }
        // POST: claim now. Idempotent — upstream reports "already checked in"
        // as a business result rather than an error.
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        const claim = await proxyCheckinCall(baseURL, "/checkin", "POST");
        if (claim?.missing === true) {
          // Not a failure to report: this proxy simply has no checkin API
          // (workbuddy2api never shipped one). Mark it unsupported so the UI
          // hides the entry and stop writing failure records.
          _checkinCapability = { supported: false, error: claim.error, checkedAt: Date.now() };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            supported: false,
            message: `当前代理未实现签到接口（${claim.error}）`,
          }));
          return;
        }
        const payload = claim?.upstream?.data;
        const ok = Boolean(payload) || alreadyClaimedMessage(claim?.upstream?.msg);
        const result = {
          ok,
          supported: true,
          message: ok
            ? payload?.credit !== undefined
              ? `签到成功：+${payload.credit} 积分`
              : "今日已签到"
            : claim?.upstream?.msg ?? claim?.error ?? "签到失败",
          ...(payload ?? {}),
        };
        if (ok || claim?.upstream?.msg) {
          writeCheckinState({
            ...readCheckinState(),
            handledDate: ok ? localDateStr() : readCheckinState().handledDate,
            lastResult: { ok, message: result.message, at: Date.now() },
          });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      },
    }));
  });
}

/** Lazily resolve the configured proxy base URL for the health probe. */
let _baseURL = DEFAULT_BASE_URL;
function config_baseURL() {
  return _baseURL;
}

// #endregion

// #region internals (exported for tests)

/**
 * Internals exposed for the test suite only. They are not part of the plugin's
 * public surface and may change without a major bump.
 */
export const __internals = {
  readSessionStatus,
  resolveSessionExpiry,
  decodeJwtPayload,
  runCheckinOnce,
  probeCheckinCapability,
  checkinCapability,
  resetCheckinCapability: () => { _checkinCapability = { supported: null, error: null, checkedAt: 0 }; },
  registerWorkbuddyRoutes,
  // The routes read the module-level proxy URL that `apply()` commits, so a
  // test that mounts them directly must point it somewhere first.
  setBaseURL: (value) => { _baseURL = value; },
};

// #endregion

// #region plugin

/**
 * Register a {@link WorkBuddyAdapter} for the `workbuddy` provider route on
 * `ctx.llm`. Connection facts resolve per request instead of freezing at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-workbuddy` user-settings section (`ctx.settings`), so a changed base
 * URL or catalog reaches the very next request without restarting anything.
 */
export function apply(ctx, config) {
  _baseURL = resolveAdapterOptions(config).baseURL;
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveAdapterOptions(raw);
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error("dsh-llm-workbuddy: keeping the last good configuration after an invalid settings section");
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();
  const adapter = new WorkBuddyAdapter({
    options,
    resolveAttachments: () => ctx.get("attachments"),
  });
  const providersHandle = ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: "WorkBuddy",
    settingsNs: NS,
    settingsPath: [],
  }]);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  registerWorkbuddyRoutes(ctx, config, adapter, providersHandle);
  ctx.effect(() => startCheckinScheduler(ctx, options));
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {
      // no registration-level facts are derived from the source; nothing to re-judge
    },
  });
}

// #endregion
