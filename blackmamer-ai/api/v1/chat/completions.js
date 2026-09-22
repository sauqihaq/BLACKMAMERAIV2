// api/v1/chat/completions.js — endpoint publik OpenAI-compatible.
// Ini yang dipasang orang di OpenCode/Cursor/Continue: Base URL =
// https://<domain-lu>/api/v1  , API Key = key yang mereka generate sendiri
// di dashboard (/api/keys).
//
// ISOLASI: tiap request diautentikasi lewat verifyApiKey() yang balikin
// email pemilik key. Gak ada history/context disimpen di server antar
// request — tiap panggilan stateless, jadi request dari key A gak akan
// pernah kecampur/ke-merge sama request dari key B. Rate limit juga
// di-key per API key hash, bukan digabung jadi satu kuota global.
import { Redis } from "@upstash/redis";
import { verifyApiKey } from "../../../lib/apiKeys.js";
import { getProvidersByModel, callProvider, streamProvidersOpenAI, listPublicModels } from "../../../lib/providers.js";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 20000;

function json(res, status, data) {
  res.status(status).json(data);
}

function openaiError(res, status, message, type = "invalid_request_error") {
  return json(res, status, { error: { message, type, code: status } });
}

async function checkRateLimit(keyHash) {
  try {
    const key = `bm-v1-rate:${keyHash}`;
    const current = await redis.incr(key);
    if (current === 1) await redis.expire(key, 60);
    // 30 request/menit per API key — longgar tapi ngelindungin quota provider.
    return current <= 30;
  } catch {
    return true;
  }
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return null;

  return messages
    .slice(-MAX_MESSAGES)
    .filter((m) => m && ["system", "user", "assistant"].includes(m.role))
    .map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content.slice(0, MAX_CHARS_PER_MESSAGE)
          : m.content, // biarin array content (vision) lewat apa adanya
    }));
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    // Kompatibel sama GET /v1/models yang dicek beberapa client sebelum connect.
    return json(res, 200, {
      object: "list",
      data: listPublicModels().map((id) => ({ id, object: "model", owned_by: "blackmamer" })),
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return openaiError(res, 405, "Method Not Allowed");
  }

  const authHeader = req.headers.authorization || "";
  const rawKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!rawKey) {
    return openaiError(res, 401, "Missing API key. Pass it as: Authorization: Bearer bm-sk-...", "authentication_error");
  }

  const auth = await verifyApiKey(rawKey);

  if (!auth) {
    return openaiError(res, 401, "Invalid API key.", "authentication_error");
  }

  const allowed = await checkRateLimit(auth.hash);
  if (!allowed) {
    return openaiError(res, 429, "Rate limit exceeded for this API key. Try again shortly.", "rate_limit_error");
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const messages = sanitizeMessages(body.messages);
    if (!messages || !messages.length) {
      return openaiError(res, 400, "messages must be a non-empty array.");
    }

    const model = body.model || "bm-auto";
    const providers = getProvidersByModel(model);

    const payload = {
      model: "",
      messages,
      max_tokens: Math.min(Number(body.max_tokens) || 4096, 8192),
      temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
    };

    const completionId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    if (body.stream === true) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      await streamProvidersOpenAI({ res, providers, payload, completionId, model });
      return res.end();
    }

    const failures = [];

    for (const provider of providers) {
      const result = await callProvider(provider, { ...payload, model: provider.model });

      if (result.ok) {
        return json(res, 200, {
          id: completionId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.content },
              finish_reason: result.finishReason || "stop",
            },
          ],
          usage: result.usage || undefined,
        });
      }

      failures.push({ provider: result.provider, code: result.error?.code || 0, message: result.error?.message });
    }

    return openaiError(res, 502, `All configured providers failed. Details: ${failures.map((f) => `${f.provider}: ${f.message}`).join(" | ")}`, "server_error");
  } catch (error) {
    console.error("[BLACKMAMER PUBLIC API ERROR]", error);
    return openaiError(res, 500, error?.message || "Internal server error.", "server_error");
  }
}