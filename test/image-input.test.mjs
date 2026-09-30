/**
 * Regression tests for the image-input failure path.
 *
 * Background (实测 2026-09-30, dsh-llm-workbuddy 0.1.23/0.1.25): once an image
 * had entered the conversation history, *every* WorkBuddy request failed within
 * 10–20 ms — 6 attempts in one turn and 5 in the next, none of which ever
 * reached the local proxy — and the harness retried each one because the
 * failure was reported as `TRANSPORT`, which is inside its retry set
 * (`EMPTY_RESPONSE | RATE_LIMIT | SERVER | TIMEOUT | TRANSPORT`).
 *
 * Root cause: the harness attachment service raises `AttachmentError`, which
 * deliberately does **not** extend `LlmError`, while this adapter classified
 * failures with `instanceof LlmError` only. Attachment failures therefore fell
 * through to `stream()`'s last-resort branch, which labels anything left as a
 * retryable transport failure.
 *
 * These tests fail on 0.1.25 and pass with the classification fix.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { WorkBuddyAdapter } from "../lib/index.js";

/** An `AttachmentError` look-alike: stable `code`, and deliberately not an `LlmError`. */
class FakeAttachmentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

const CONNECTION = {
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "",
  maxTokens: 1024,
  defaultContextWindow: 100_000,
  models: [],
  streamIdleTimeoutMs: 300_000,
  discovery: false,
  autoCheckin: false,
  checkinAfterHour: 10,
};

const IMAGE_MESSAGE = {
  role: "user",
  content: [
    {
      type: "image",
      attachment: { attachmentId: "att-1", mediaType: "image/png", byteLength: 12 },
    },
  ],
};

function makeAdapter({ attachments, baseURL = CONNECTION.baseURL } = {}) {
  return new WorkBuddyAdapter({
    options: () => ({ ...CONNECTION, baseURL }),
    resolveAttachments: () => attachments,
  });
}

function requestOverrides({ messages = [IMAGE_MESSAGE], model = "deepseek-v4.1-flash" } = {}) {
  return { model, system: "", tools: [], messages };
}

/** Drain a stream so any failure surfaces as a rejection. */
async function drain(adapter, options = requestOverrides()) {
  for await (const _chunk of adapter.stream(options)) {
    // no-op: these tests only care about how failures are classified
  }
}

function assertUnsupportedInput(error, messagePattern) {
  assert.notEqual(
    error.code,
    "TRANSPORT",
    "an input failure must never be labelled a retryable transport failure",
  );
  assert.equal(error.code, "UNSUPPORTED_CONTENT");
  assert.match(error.message, /^WorkBuddy could not /);
  if (messagePattern !== undefined) assert.match(error.message, messagePattern);
  return true;
}

test("an attachment read failure is reported as unsupported input, not retryable TRANSPORT", async () => {
  const failure = new FakeAttachmentError("the attachment bytes are unavailable", "ATTACHMENT_NOT_FOUND");
  const adapter = makeAdapter({
    attachments: {
      readImageRequest: async () => {
        throw failure;
      },
      isAttachmentError: (error) => error === failure,
    },
  });

  await assert.rejects(drain(adapter), (error) => assertUnsupportedInput(error, /ATTACHMENT_NOT_FOUND/));
});

test("an image block without an attachment reference is classified, not a bare TypeError", async () => {
  const adapter = makeAdapter({
    attachments: {
      readImageRequest: async () => {
        throw new Error("must not be reached");
      },
      isAttachmentError: () => false,
    },
  });

  await assert.rejects(
    drain(adapter, requestOverrides({ messages: [{ role: "user", content: [{ type: "image" }] }] })),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_CONTENT");
      assert.match(error.message, /without an attachment reference/);
      assert.equal(error instanceof TypeError, false, "a bare TypeError used to be reported as TRANSPORT");
      return true;
    },
  );
});

test("prepared bytes that cannot be encoded are classified", async () => {
  const adapter = makeAdapter({
    attachments: {
      // No `data`: Buffer.from(undefined) throws, which used to end up as TRANSPORT.
      readImageRequest: async () => ({ mediaType: "image/png" }),
      isAttachmentError: () => false,
    },
  });

  await assert.rejects(drain(adapter), (error) =>
    assertUnsupportedInput(error, /encode an image attachment/));
});

test("a real transport failure is still TRANSPORT", async () => {
  // Nothing is expected to listen on 65534; a refused loopback connect is immediate.
  const adapter = makeAdapter({ attachments: undefined, baseURL: "http://127.0.0.1:65534/v1" });

  await assert.rejects(
    drain(adapter, requestOverrides({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })),
    (error) => {
      assert.equal(error.code, "TRANSPORT");
      assert.match(error.message, /proxy request to/);
      return true;
    },
  );
});

test("a healthy image attachment still reaches the wire as an image_url part", async () => {
  const adapter = makeAdapter({
    attachments: {
      readImageRequest: async () => ({ mediaType: "image/jpeg", data: new Uint8Array([1, 2, 3]) }),
      isAttachmentError: () => false,
    },
  });

  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    await drain(adapter);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const imagePart = sent.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((part) => part.type === "image_url");
  assert.ok(imagePart, "the request must carry the image as an image_url part");
  assert.equal(imagePart.image_url.url, "data:image/jpeg;base64,AQID");
});
