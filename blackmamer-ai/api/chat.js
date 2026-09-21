import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const MAX_HISTORY = 8;
const MAX_USER_CHARS = 5000;
const MAX_ASSISTANT_CHARS = 2200;
const MAX_CURRENT_CHARS = 9000;
const MAX_ARTIFACT_CHARS = 9000;

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_TEXT = 6000;

const PROVIDER_TIMEOUT_MS = 20000;
const MAX_REQUEST_BYTES = 120000;

const PROVIDERS = [
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
    model: "gemini-3.6-flash",
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

const SYSTEM_PROMPT = `
You are BlackMamer AI.

You are a general-purpose AI assistant built for BlackMamer Studio.

PERSONALITY:
- Speak naturally and casually.
- The user is Indonesian.
- You may use "lu", "gue", "lo", "bro", etc. when appropriate.
- Do not sound robotic.
- Be helpful, direct, and practical.
- If the user is casually talking or venting, respond like a supportive friend.
- Do not over-explain simple things.

IMPORTANT:
- Never mention the underlying provider, API provider, model provider, or internal routing unless the user explicitly asks about the technical implementation.
- The user-facing model names are BlackMamer AI models such as BM Nexus, BM Velocity, BM Aurora, BM Forge, BM Titan, and BM Core.
- Do not call yourself Groq, Gemini, Mistral, NVIDIA, OpenRouter, etc.

PROGRAMMING:
- Give complete working code when the user asks for code.
- Preserve existing architecture when modifying an existing project.
- Do not remove existing functionality unless requested.
- When debugging, identify the actual cause before proposing the fix.
- Prefer copy-paste-ready solutions.

WEBSITE CREATION:
When the user asks you to create a website:
- Actually generate the website.
- Prefer a complete single-file HTML document unless the user explicitly asks for multiple files.
- Include HTML, CSS, and JavaScript in the same file.
- Make it polished and production-oriented.
- Responsive for desktop and mobile.
- Avoid generic AI-looking layouts.
- Avoid unnecessary gradients, excessive glassmorphism, giant empty areas, excessive rounded cards, and repetitive card grids.
- Use deliberate typography, spacing, hierarchy, and interaction design.
- Do not add fake statistics, fake testimonials, fake reviews, or fake company claims unless the user explicitly requests placeholder content.
- Do not put huge amounts of unnecessary comments in generated code.
- Keep generated websites reasonably compact so they can be revised in later messages.

WEBSITE REVISIONS:
If an ARTIFACT TERAKHIR is supplied, treat it as the current source code of the website.
When the user asks for changes:
- Modify the existing artifact instead of creating an unrelated website.
- Preserve existing functionality unless the requested change requires otherwise.
- Return the complete updated website when practical.

OUTPUT:
- When generating a website, place the complete HTML inside a fenced \`\`\`html code block.
- Do not put the HTML outside the code block.
`;

function json(res, status, data) {
  res.status(status).json(data);
}

function safeString(value, max = 10000) {
  if (value == null) return "";
  return String(value).slice(0, max);
}

function isWebsiteRequest(messages = []) {
  const latest = [...messages]
    .reverse()
    .find((m) => m?.role === "user");

  const text = String(latest?.content || "").toLowerCase();

  return [
    "buat website",
    "bikin website",
    "buatkan website",
    "bikinin website",
    "create website",
    "build website",
    "website",
    "landing page",
    "web app",
    "web aplikasi",
    "website html",
    "html css js",
  ].some((keyword) => text.includes(keyword));
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];

  const recent = messages.slice(-MAX_HISTORY);

  return recent
    .filter((m) => {
      return (
        m &&
        (m.role === "user" ||
          m.role === "assistant" ||
          m.role === "system") &&
        typeof m.content === "string"
      );
    })
    .map((m) => {
      let content = m.content || "";

      /*
       * Jangan kirim ulang full website hasil AI ke provider.
       * Ini penyebab utama request membengkak ketika user
       * meminta revisi website berkali-kali.
       */
      if (
        m.role === "assistant" &&
        /```(?:html|html5)[\s\S]*```/i.test(content)
      ) {
        content =
          "[WEBSITE ARTIFACT — source disimpan terpisah di ARTIFACT TERAKHIR.]";
      } else if (m.role === "assistant") {
        content = content.slice(0, MAX_ASSISTANT_CHARS);
      } else if (m.role === "user") {
        content = content.slice(0, MAX_USER_CHARS);
      } else {
        content = content.slice(0, MAX_CURRENT_CHARS);
      }

      return {
        role: m.role,
        content,
      };
    });
}

function buildAttachmentContext(attachments) {
  if (!Array.isArray(attachments)) return "";

  const usable = attachments
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => {
      const name = safeString(a?.name, 200);
      const type = safeString(a?.type, 120);
      const size = Number(a?.size || 0);

      const text = safeString(a?.text, MAX_ATTACHMENT_TEXT);

      let block =
        `FILE: ${name}\n` +
        `TYPE: ${type}\n` +
        `SIZE: ${size} bytes`;

      if (text) {
        block += `\nCONTENT:\n${text}`;
      }

      return block;
    })
    .filter(Boolean);

  if (!usable.length) return "";

  return (
    "\n\nATTACHMENTS:\n" +
    usable.join("\n\n--------------------\n\n")
  );
}

function buildMessages({
  messages,
  artifactContext,
  attachments,
}) {
  const cleaned = cleanMessages(messages);

  const result = cleaned.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  /*
   * Artifact website dikirim TERPISAH dari history.
   * Jadi history tetap kecil.
   */
  const artifact = safeString(
    artifactContext,
    MAX_ARTIFACT_CHARS
  );

  const attachmentContext = buildAttachmentContext(attachments);

  if (artifact || attachmentContext) {
    let extra = "";

    if (artifact) {
      extra +=
        "\n\nARTIFACT TERAKHIR (SOURCE WEBSITE):\n" +
        artifact;
    }

    if (attachmentContext) {
      extra += attachmentContext;
    }

    /*
     * Tempel context tambahan ke pesan user terakhir.
     */
    let lastUserIndex = -1;

    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    if (lastUserIndex >= 0) {
      result[lastUserIndex] = {
        ...result[lastUserIndex],
        content:
          String(result[lastUserIndex].content || "").slice(
            0,
            MAX_CURRENT_CHARS
          ) + extra.slice(0, MAX_CURRENT_CHARS),
      };
    } else {
      result.push({
        role: "user",
        content: extra.slice(0, MAX_CURRENT_CHARS),
      });
    }
  }

  return [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    ...result,
  ];
}

function classifyProviderError(status, body) {
  const text = String(body || "").slice(0, 1000);

  if (status === 413) {
    return {
      code: 413,
      message:
        "Request terlalu besar untuk provider.",
    };
  }

  if (status === 429) {
    return {
      code: 429,
      message:
        "Provider sedang kena rate limit.",
    };
  }

  if (status === 401) {
    return {
      code: 401,
      message:
        "API key provider tidak valid atau belum terpasang.",
    };
  }

  if (status === 403) {
    return {
      code: 403,
      message:
        "Request ditolak oleh provider.",
    };
  }

  if (status === 400) {
    return {
      code: 400,
      message:
        "Provider menolak format request.",
    };
  }

  if (status >= 500) {
    return {
      code: status,
      message:
        "Provider sedang mengalami error server.",
    };
  }

  return {
    code: status,
    message:
      text || `Provider error HTTP ${status}.`,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function callProvider(provider, payload) {
  if (!provider.key) {
    return {
      ok: false,
      provider: provider.id,
      error: {
        code: 0,
        message: "API key belum dikonfigurasi.",
      },
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
      return {
        ok: false,
        provider: provider.id,
        error: {
          code: 408,
          message: "Provider timeout.",
        },
      };
    }

    return {
      ok: false,
      provider: provider.id,
      error: {
        code: 0,
        message:
          error?.message || "Gagal menghubungi provider.",
      },
    };
  }

  const raw = await response.text();

  if (!response.ok) {
    return {
      ok: false,
      provider: provider.id,
      error: classifyProviderError(
        response.status,
        raw
      ),
    };
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      provider: provider.id,
      error: {
        code: 502,
        message: "Response provider bukan JSON valid.",
      },
    };
  }

  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    "";

  if (!content) {
    return {
      ok: false,
      provider: provider.id,
      error: {
        code: 502,
        message:
          "Provider tidak mengembalikan content.",
      },
    };
  }

  return {
    ok: true,
    provider: provider.id,
    content: String(content),
    raw: data,
  };
}

function getProviderOrder(agent) {
  const normalized = String(agent || "auto")
    .trim()
    .toLowerCase();

  /*
   * User melihat nama model BlackMamer.
   * Backend yang menentukan provider sebenarnya.
   */

  const aliases = {
    "bm nexus": ["groq", "gemini", "mistral", "openrouter"],
    "bm velocity": ["groq", "nvidia", "gemini", "mistral"],
    "bm aurora": ["gemini", "groq", "mistral", "openrouter"],
    "bm forge": ["mistral", "groq", "gemini", "openrouter"],
    "bm titan": ["nvidia", "groq", "gemini", "openrouter"],
    "bm core": ["openrouter", "groq", "gemini", "mistral"],
  };

  if (normalized === "auto") {
    return [
      "groq",
      "gemini",
      "mistral",
      "nvidia",
      "openrouter",
    ];
  }

  if (aliases[normalized]) {
    return aliases[normalized];
  }

  if (
    [
      "groq",
      "gemini",
      "mistral",
      "nvidia",
      "openrouter",
    ].includes(normalized)
  ) {
    return [normalized];
  }

  return [
    "groq",
    "gemini",
    "mistral",
    "nvidia",
    "openrouter",
  ];
}

function getProvidersByOrder(agent) {
  const order = getProviderOrder(agent);

  const result = [];

  for (const id of order) {
    const provider = PROVIDERS.find(
      (p) => p.id === id
    );

    if (provider) result.push(provider);
  }

  return result;
}

function getClientIp(req) {
  const forwarded =
    req.headers["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded)
      .split(",")[0]
      .trim();
  }

  return (
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

async function checkRateLimit(ip) {
  /*
   * Redis rate limit sederhana.
   *
   * Kalau Redis belum tersedia, jangan bikin seluruh
   * endpoint mati hanya karena rate-limit storage.
   */
  try {
    const key = `bm-rate:${ip}`;

    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, 60);
    }

    /*
     * Batas internal request per menit.
     */
    if (current > 20) {
      return false;
    }

    return true;
  } catch {
    return true;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, {
      error: "Method Not Allowed",
    });
  }

  try {
    const ip = getClientIp(req);

    const allowed = await checkRateLimit(ip);

    if (!allowed) {
      return json(res, 429, {
        error:
          "Terlalu banyak request. Coba lagi sebentar.",
      });
    }

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const {
      messages = [],
      agent = "auto",
      attachments = [],
      artifactContext = "",
    } = body;

    if (!Array.isArray(messages)) {
      return json(res, 400, {
        error: "messages harus berupa array.",
      });
    }

    /*
     * Deteksi website request.
     */
    const websiteRequest =
      isWebsiteRequest(messages);

    /*
     * Build payload yang sudah dipangkas.
     */
    const providerMessages = buildMessages({
      messages,
      artifactContext,
      attachments,
    });

    /*
     * Untuk website kita beri output lebih panjang.
     * Request biasa tetap lebih hemat.
     */
    const maxTokens = websiteRequest
      ? 4096
      : 2048;

    const payload = {
      model: "",
      messages: providerMessages,
      max_tokens: maxTokens,
      temperature: websiteRequest
        ? 0.65
        : 0.7,
    };

    const serialized = JSON.stringify(payload);

    const requestBytes = new TextEncoder().encode(
      serialized
    ).length;

    /*
     * Safety guard:
     * jangan pernah mengirim payload raksasa ke provider.
     */
    if (requestBytes > MAX_REQUEST_BYTES) {
      return json(res, 413, {
        error:
          "Request website terlalu besar sebelum dikirim ke provider. Context sudah melebihi batas aman.",
        requestBytes,
        maxBytes: MAX_REQUEST_BYTES,
      });
    }

    const providers =
      getProvidersByOrder(agent);

    const failures = [];

    for (const provider of providers) {
      const providerPayload = {
        ...payload,
        model: provider.model,
      };

      const result = await callProvider(
        provider,
        providerPayload
      );

      if (result.ok) {
        return json(res, 200, {
          ok: true,
          content: result.content,
          provider: result.provider,
          agent,
          website: websiteRequest,
        });
      }

      failures.push({
        provider: result.provider,
        code: result.error?.code || 0,
        message:
          result.error?.message ||
          "Unknown provider error.",
      });
    }

    /*
     * Kalau semua provider gagal, tampilkan penyebab
     * yang sebenarnya. Jangan lagi kasih error generic
     * "semua model penuh".
     */
    const has413 = failures.some(
      (x) => x.code === 413
    );

    const has429 = failures.some(
      (x) => x.code === 429
    );

    const has401 = failures.some(
      (x) => x.code === 401
    );

    let userMessage =
      "Semua provider yang tersedia gagal memproses request.";

    if (has413) {
      userMessage =
        "Request website ini terlalu besar untuk dikirim ke provider. Gue sudah membatasi context otomatis; coba kirim ulang atau minta versi website yang lebih ringkas.";
    } else if (has429) {
      userMessage =
        "Provider sedang kena rate limit. Coba agent lain atau tunggu sebentar lalu kirim lagi.";
    } else if (has401) {
      userMessage =
        "API key provider belum valid atau belum terpasang. Cek environment variables di deployment lu.";
    }

    /*
     * Kalau user memilih agent tertentu,
     * tampilkan detail error untuk debugging.
     */
    const selectedAgent =
      String(agent || "auto").toLowerCase();

    const isForcedAgent =
      selectedAgent !== "auto";

    if (isForcedAgent) {
      const details = failures
        .map(
          (f) =>
            `${f.provider}: HTTP ${
              f.code || "ERR"
            } — ${f.message}`
        )
        .join(" | ");

      userMessage += ` Detail: ${details}`;
    }

    return json(res, 502, {
      ok: false,
      error: userMessage,
      website: websiteRequest,
      requestBytes,
      failures,
    });
  } catch (error) {
    console.error(
      "[BLACKMAMER AI ERROR]",
      error
    );

    return json(res, 500, {
      ok: false,
      error:
        error?.message ||
        "Internal server error.",
    });
  }
}
