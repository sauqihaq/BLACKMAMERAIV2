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

WEBSITE CONTINUATION:
If the user says something like "lanjutin", "lanjut", "terusin", or "continue" right after a website reply that was cut off mid-code:
- The ARTIFACT TERAKHIR is INCOMPLETE, not a finished website to revise.
- Continue writing exactly from where it stopped. Do not repeat code that was already shown.
- Do not restart the file or regenerate parts already provided.
- Keep the same fenced \`\`\`html code block convention for the continuation.

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

function getLatestUserText(messages = []) {
  const latest = [...messages]
    .reverse()
    .find((m) => m?.role === "user");

  return String(latest?.content || "").trim();
}

function isImageRequest(messages = []) {
  const text = getLatestUserText(messages).toLowerCase();

  if (!text) return false;

  return [
    "buat logo",
    "buatkan logo",
    "bikin logo",
    "bikinin logo",
    "generate logo",
    "buat gambar",
    "buatkan gambar",
    "bikin gambar",
    "bikinin gambar",
    "generate gambar",
    "generate image",
    "create image",
    "create a logo",
    "create logo",
    "gambarkan",
    "gambar dong",
    "buat foto",
    "bikin foto",
    "buatkan foto",
    "buat ilustrasi",
    "bikin ilustrasi",
    "buat icon",
    "bikin icon",
    "buat banner",
    "bikin banner",
    "buat thumbnail",
    "bikin thumbnail",
    "buat poster",
    "bikin poster",
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

  const finishReason =
    data?.choices?.[0]?.finish_reason ||
    data?.choices?.[0]?.finishReason ||
    null;

  return {
    ok: true,
    provider: provider.id,
    content: String(content),
    finishReason,
    raw: data,
  };
}

const IMAGE_MODEL = "gemini-2.5-flash-image";
const IMAGE_PROVIDER_URL = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`;

async function generateImage(prompt) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    return {
      ok: false,
      error:
        "GEMINI_API_KEY belum dikonfigurasi, jadi generate gambar belum bisa jalan.",
    };
  }

  let response;

  try {
    response = await fetchWithTimeout(
      IMAGE_PROVIDER_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
        }),
      },
      PROVIDER_TIMEOUT_MS
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: false,
        error: "Image provider timeout.",
      };
    }

    return {
      ok: false,
      error:
        error?.message ||
        "Gagal menghubungi image provider.",
    };
  }

  const raw = await response.text();

  if (!response.ok) {
    return {
      ok: false,
      error: classifyProviderError(response.status, raw)
        .message,
    };
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: "Response image provider bukan JSON valid.",
    };
  }

  const parts =
    data?.candidates?.[0]?.content?.parts || [];

  const imagePart = parts.find(
    (p) => p?.inlineData?.data
  );

  if (!imagePart) {
    return {
      ok: false,
      error: "Provider tidak mengembalikan gambar.",
    };
  }

  return {
    ok: true,
    mimeType: imagePart.inlineData.mimeType || "image/png",
    base64: imagePart.inlineData.data,
  };
}

function getProviderOrder(agent) {
  const normalized = String(agent || "auto")
    .trim()
    .toLowerCase();

  /*
   * User melihat nama model BlackMamer di UI, tapi ID yang
   * dikirim frontend adalah ID provider langsung (groq, gemini,
   * mistral, nvidia, openrouter) — lihat AGENTS[] di index.html.
   *
   * Jadi mapping fallback chain harus dikunci ke ID tersebut,
   * BUKAN ke label "bm xxx" (yang gak pernah dikirim frontend
   * dan bikin fallback ini mati / gak kepakai sama sekali).
   */

  const aliases = {
    groq: ["groq", "nvidia", "gemini", "mistral", "openrouter"], // BM Velocity
    gemini: ["gemini", "groq", "mistral", "openrouter", "nvidia"], // BM Aurora
    mistral: ["mistral", "groq", "gemini", "openrouter", "nvidia"], // BM Forge
    nvidia: ["nvidia", "groq", "gemini", "openrouter", "mistral"], // BM Titan
    openrouter: ["openrouter", "groq", "gemini", "mistral", "nvidia"], // BM Core

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
     * Deteksi image generation request.
     * Ini dicek DULUAN, sebelum website/text provider,
     * soalnya kalau user minta gambar/logo, kita gak mau
     * malah balikin kode SVG dari text model.
     */
    const imageRequest = isImageRequest(messages);

    if (imageRequest) {
      const prompt = getLatestUserText(messages);

      const imgResult = await generateImage(prompt);

      if (imgResult.ok) {
        const dataUrl = `data:${imgResult.mimeType};base64,${imgResult.base64}`;

        return json(res, 200, {
          ok: true,
          content: `Nih gambar yang lu minta:\n\n![Generated image](${dataUrl})`,
          provider: "gemini-image",
          agent,
          website: false,
          image: true,
        });
      }

      return json(res, 502, {
        ok: false,
        error: `Gagal generate gambar: ${imgResult.error}`,
        image: true,
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
     *
     * 4096 sering gak cukup buat HTML+CSS+JS lengkap
     * dalam satu file, apalagi kalau modelnya verbose —
     * makanya output suka kepotong di tengah CSS/JS.
     * Naikin ke 8192 (batas aman yang didukung semua
     * provider di PROVIDERS).
     */
    const maxTokens = websiteRequest
      ? 999999
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
        let finalContent = result.content;

        /*
         * Kalau provider berhenti karena kehabisan token
         * (bukan karena udah selesai), kasih tau user
         * secara eksplisit — jangan biarin dia nebak-nebak
         * kenapa kode-nya nanggung di tengah.
         */
        if (result.finishReason === "length") {
          /*
           * Kalau output kepotong di TENGAH code block
           * (jumlah ``` ganjil = fence belum ditutup),
           * tutup dulu fence-nya biar peringatan di bawah
           * gak ikut ke-render sebagai bagian dari kode.
           */
          const fenceCount = (
            finalContent.match(/```/g) || []
          ).length;

          if (fenceCount % 2 !== 0) {
            finalContent += "\n```";
          }

          finalContent +=
            "\n\n⚠️ **Kode di atas kepotong** karena kepanjangan buat sekali generate. Balas \"lanjutin\" biar gue sambungin dari situ.";
        }

        return json(res, 200, {
          ok: true,
          content: finalContent,
          provider: result.provider,
          agent,
          website: websiteRequest,
          truncated: result.finishReason === "length",
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
