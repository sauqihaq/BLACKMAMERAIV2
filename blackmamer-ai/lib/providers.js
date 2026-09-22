// lib/providers.js — provider chain shared by /api/v1/chat/completions
// Dipisah dari api/chat.js sengaja: endpoint publik (dipakai lewat OpenCode dkk)
// butuh perilaku netral (gak ada persona/gimmick website-detection/image-hijack),
// jadi bukan sekadar re-export dari chat.js.

const PROVIDER_TIMEOUT_MS = 20000;

export const PROVIDERS = [
  {
    id: "groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY,
    model: "openai/gpt-oss-120b",
  },
  {
    id: "gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    key: process.env.GEMINI_API_KEY,
    model: "gemini-3.8-flash",
  },
  {
    id: "mistral",
    url: "https://api.mistral.ai/v1/chat/completions",
    key: process.env.MISTRAL_API_KEY,
    model: "mistral-small-latest",
  },
  {
    id: "nvidia",
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    key: process.env.NVIDIA_API_KEY,
    model: "openai/gpt-oss-120b",
  },
  {
    id: "openrouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: process.env.OPENROUTER_API_KEY,
    model: "openai/gpt-oss-20b:free",
  },
];

const ORDER_ALIASES = {
  groq: ["groq", "nvidia", "gemini", "mistral", "openrouter"],
  gemini: ["gemini", "groq", "mistral", "openrouter", "nvidia"],
  mistral: ["mistral", "groq", "gemini", "openrouter", "nvidia"],
  nvidia: ["nvidia", "groq", "gemini", "openrouter", "mistral"],
  openrouter: ["openrouter", "groq", "gemini", "mistral", "nvidia"],
};

const DEFAULT_ORDER = ["groq", "gemini", "mistral", "nvidia", "openrouter"];

// Model id publik -> urutan provider. "bm-auto" (atau apa aja yang gak
// dikenal) jatuh ke DEFAULT_ORDER.
export function getProvidersByModel(model) {
  const normalized = String(model || "bm-auto")
    .trim()
    .toLowerCase()
    .replace(/^bm-/, "");

  const order = ORDER_ALIASES[normalized] || DEFAULT_ORDER;

  return order
    .map((id) => PROVIDERS.find((p) => p.id === id))
    .filter(Boolean);
}

export function listPublicModels() {
  return [
    "bm-auto",
    "bm-groq",
    "bm-gemini",
    "bm-mistral",
    "bm-nvidia",
    "bm-openrouter",
  ];
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyProviderError(status, body) {
  const text = String(body || "").slice(0, 1000);
  if (status === 413) return { code: 413, message: "Request too large for provider." };
  if (status === 429) return { code: 429, message: "Provider rate limited." };
  if (status === 401) return { code: 401, message: "Provider API key invalid or missing." };
  if (status === 403) return { code: 403, message: "Provider rejected the request." };
  if (status === 400) return { code: 400, message: "Provider rejected the request format." };
  if (status >= 500) return { code: status, message: "Provider server error." };
  return { code: status, message: text || `Provider error HTTP ${status}.` };
}

export async function callProvider(provider, payload) {
  if (!provider.key) {
    return {
      ok: false,
      provider: provider.id,
      error: { code: 0, message: "API key not configured for this provider." },
    };
  }

  let response;
  try {
    response = await fetchWithTimeout(
      provider.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.key}`,
        },
        body: JSON.stringify(payload),
      },
      PROVIDER_TIMEOUT_MS
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, provider: provider.id, error: { code: 408, message: "Provider timeout." } };
    }
    return {
      ok: false,
      provider: provider.id,
      error: { code: 0, message: error?.message || "Failed to reach provider." },
    };
  }

  const raw = await response.text();

  if (!response.ok) {
    return { ok: false, provider: provider.id, error: classifyProviderError(response.status, raw) };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, provider: provider.id, error: { code: 502, message: "Provider returned invalid JSON." } };
  }

  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";

  if (!content) {
    return { ok: false, provider: provider.id, error: { code: 502, message: "Provider returned no content." } };
  }

  const finishReason =
    data?.choices?.[0]?.finish_reason || data?.choices?.[0]?.finishReason || "stop";

  const usage = data?.usage || null;

  return {
    ok: true,
    provider: provider.id,
    content: String(content),
    finishReason,
    usage,
  };
}

// Streaming: relay ke client dalam format OpenAI chat.completion.chunk asli,
// biar tools kayak OpenCode yang expect format OpenAI beneran bisa parse langsung.
export async function streamProvidersOpenAI({ res, providers, payload, completionId, model }) {
  const failures = [];

  for (const provider of providers) {
    if (!provider.key) {
      failures.push({ provider: provider.id, code: 0, message: "API key not configured." });
      continue;
    }

    const providerPayload = { ...payload, model: provider.model, stream: true };

    let response;
    try {
      response = await fetchWithTimeout(
        provider.url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${provider.key}`,
          },
          body: JSON.stringify(providerPayload),
        },
        PROVIDER_TIMEOUT_MS
      );
    } catch (error) {
      failures.push({
        provider: provider.id,
        code: error?.name === "AbortError" ? 408 : 0,
        message: error?.name === "AbortError" ? "Provider timeout." : error?.message || "Failed to reach provider.",
      });
      continue;
    }

    if (!response.ok || !response.body) {
      const raw = await response.text().catch(() => "");
      failures.push({ provider: provider.id, code: response.status, message: classifyProviderError(response.status, raw).message });
      continue;
    }

    // Provider mulai stream — dari sini gak fallback lagi.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const created = Math.floor(Date.now() / 1000);

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        const delta = parsed?.choices?.[0]?.delta?.content || "";
        const reason = parsed?.choices?.[0]?.finish_reason || null;

        res.write(
          `data: ${JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: delta ? { content: delta } : {}, finish_reason: reason }],
          })}\n\n`
        );
      }
    }

    res.write("data: [DONE]\n\n");
    return { ok: true, provider: provider.id };
  }

  res.write(
    `data: ${JSON.stringify({
      error: { message: "All configured providers failed.", failures },
    })}\n\n`
  );
  res.write("data: [DONE]\n\n");
  return { ok: false, failures };
}
