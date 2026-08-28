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
import { existsSync, mkdirSync, readFileSync, appendFileSync, openSync, truncateSync, writeSync, closeSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";

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
 */
const DEFAULT_MODELS = [
  { id: "deepseek-v4-pro", name: "Deepseek-V4-Pro", contextWindow: 1_000_000, maxTokens: 50_000, inputModalities: ["text", "image"], reasoningEffort: "high" },
  { id: "deepseek-v4-flash", name: "Deepseek-V4-Flash", contextWindow: 1_000_000, maxTokens: 50_000, inputModalities: ["text", "image"], reasoningEffort: "high" },
  { id: "deepseek-v3-2-volc", name: "DeepSeek-V3.2", contextWindow: 96_000, maxTokens: 32_000, reasoningEffort: "medium" },
  { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1_000_000, maxTokens: 48_000, inputModalities: ["text", "image"], reasoningEffort: "medium" },
  { id: "glm-5.1", name: "GLM-5.1", contextWindow: 200_000, maxTokens: 48_000, reasoningEffort: "medium" },
  { id: "glm-5v-turbo", name: "GLM-5v-Turbo", contextWindow: 200_000, maxTokens: 64_000, inputModalities: ["text", "image"], reasoningEffort: "medium" },
  { id: "kimi-k3-1", name: "Kimi-K3", contextWindow: 1_000_000, maxTokens: 32_000, inputModalities: ["text", "image"], reasoningEffort: "medium" },
  { id: "kimi-k2.7", name: "Kimi-K2.7-Code", contextWindow: 256_000, maxTokens: 32_000, inputModalities: ["text", "image"], reasoningEffort: "medium" },
  { id: "kimi-k2.6", name: "Kimi-K2.6", contextWindow: 256_000, maxTokens: 32_000, inputModalities: ["text", "image"], reasoningEffort: "medium" },
  { id: "kimi-k2.5", name: "Kimi-K2.5", contextWindow: 164_000, maxTokens: 32_000, inputModalities: ["text", "image"], reasoningEffort: "medium" },
  { id: "minimax-m3", name: "MiniMax-M3", contextWindow: 512_000, maxTokens: 128_000, inputModalities: ["text", "image"], reasoningEffort: "medium" },
  { id: "hy3", name: "Hy3", contextWindow: 192_000, maxTokens: 64_000, inputModalities: ["text", "image"], reasoningEffort: "high" },
  { id: "hunyuan-2.0-thinking", name: "Hunyuan-2.0-Thinking", contextWindow: 128_000, maxTokens: 24_000, reasoningEffort: "medium" },
  { id: "hunyuan-chat", name: "Hunyuan-Turbos", contextWindow: 200_000, maxTokens: 8_192 },
  { id: "auto", name: "Auto", contextWindow: 168_000, maxTokens: 32_000, inputModalities: ["text", "image"], reasoningEffort: "high" },
  { id: "default", name: "Default", contextWindow: 200_000, maxTokens: 24_000 },
];

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
    name: model.name ?? model.id,
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
        // The static catalog doubles as a whitelist. The proxy still announces
        // retired/legacy models (deepseek-v3-1, glm-4.6, glm-4.6v, kimi-k2,
        // kimi-k2-thinking, minimax-m2.5, hunyuan-image-v3.0, ...) that the
        // upstream rejects with `service info not found`. Drop any live entry
        // that is not in the catalog so those never reach the UI; the catalog
        // is the curated set that matches what the official client shows.
        if (catalog === undefined) continue;
        const effort = liveReasoningEffort(entry, catalog?.reasoningEffort);
        const reasoning = modelReasoningInfo(effort);
        merged.push({
          provider,
          id: entry.id,
          name: entry.name ?? catalog?.name ?? entry.id,
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
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      inputModalities: [...inputModalities],
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
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
 * claiming passes "POST". Returns the parsed body or an error shape.
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
      return { error: `HTTP ${response.status} (${method} ${path})`, ...(body ? { body } : {}) };
    }
    return body ?? { error: "empty response" };
  } catch (error) {
    return { error: String(error?.cause?.message ?? error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether an upstream claim rejection means "already claimed today". */
function alreadyClaimedMessage(msg) {
  return typeof msg === "string" && /(已签到|已经签到|already)/i.test(msg);
}

/**
 * Run one auto-claim pass. Idempotent per local calendar day:
 * - before `checkinAfterHour` (default 10:00) local time: no-op;
 * - already handled today (persisted state): no-op;
 * - official status says already checked in: mark handled, done;
 * - activity not open (no status data): mark handled so we stop retrying today;
 * - otherwise claim, persisting the reward (credit, streak) on success.
 * Concurrent invocations collapse into the first caller via `inFlight`.
 * @returns the resulting state snapshot, or undefined when skipped/in-flight.
 */
async function runCheckinOnce(baseURL, config, logger) {
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
 * Read the local WorkBuddy session file and derive its validity. Returns a
 * normalized status object the Web widget polls. Never throws — missing or
 * malformed state is reported as `authenticated: false` so the UI can prompt.
 */
function readSessionStatus(sessionFile) {
  if (!existsSync(sessionFile)) {
    return { sessionFile: false, authenticated: false, expiresAt: null, account: null };
  }
  try {
    const raw = JSON.parse(readFileSync(sessionFile, "utf-8"));
    const expiresAt = raw?.auth?.expiresAt ?? null;
    const now = Date.now();
    const expired = expiresAt !== null && expiresAt <= now;
    return {
      sessionFile: true,
      authenticated: !expired && Boolean(raw?.auth?.accessToken),
      expiresAt,
      account: raw?.account ?? null,
    };
  } catch {
    return { sessionFile: true, authenticated: false, expiresAt: null, account: null };
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
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.length > 0) {
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
    "# 拉取并运行代理（详见 README「安装代理」）",
    "git clone https://github.com/hawklithm/workbuddy2api.git && cd workbuddy2api",
    "uv run python -u -m codebuddy_proxy --desensitize \\",
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
        // 5s status poll with an upstream call.
        const checkinState = readCheckinState();
        const today = localDateStr();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ...session,
          ...proxy,
          loginScriptAvailable: existsSync(loginScript),
          checkin: {
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
        // Existing session is fine; no need to re-run the flow.
        const existing = readSessionStatus(sessionFile);
        if (existing.authenticated) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ alreadyLoggedIn: true, authUrl: null, ...existing }));
          return;
        }
        // login_workbuddy.py is dependency-free (stdlib only), so we invoke it
        // directly with the system Python — no uv runtime required.
        const args = ["-u", loginScript, "--session-file", sessionFile];
        const child = spawn("python3", args, { env: { ...process.env, PYTHONUNBUFFERED: "1" } });
        let stdout = "";
        let authUrl = null;
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
          const m = stdout.match(/https?:\/\/\S+/);
          if (m && authUrl === null) authUrl = m[0];
        });
        child.stderr.on("data", () => {});
        // The device flow blocks until login or timeout; we hand back the URL
        // immediately and let the widget poll /status for completion.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ authUrl, pending: true }));
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
          session: { file: session.sessionFile, authenticated: session.authenticated, expiresAt: session.expiresAt },
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
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
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
        const payload = claim?.upstream?.data;
        const ok = Boolean(payload) || alreadyClaimedMessage(claim?.upstream?.msg);
        const result = {
          ok,
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
