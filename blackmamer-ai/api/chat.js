// api/chat.js — Vercel Function
// Urutan = prioritas (dipakai kalau agent="auto"). Provider tanpa key otomatis dilewati.
import { getSession } from "../lib/session.js";

const PROVIDERS = [
  {
    id: "groq",
    label: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY,
    model: "openai/gpt-oss-120b",
  },
  {
    id: "gemini",
    label: "Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    key: process.env.GEMINI_API_KEY,
    model: "gemini-2.5-flash",
  },
  {
    id: "mistral",
    label: "Mistral",
    url: "https://api.mistral.ai/v1/chat/completions",
    key: process.env.MISTRAL_API_KEY,
    model: "mistral-small-latest",
  },
  {
    id: "nvidia",
    label: "NVIDIA",
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    key: process.env.NVIDIA_API_KEY,
    model: "openai/gpt-oss-120b",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: process.env.OPENROUTER_API_KEY,
    model: "openai/gpt-oss-20b:free",
  },
];

const SYSTEM_PROMPT =
  "Kamu adalah BlackMamer AI, asisten yang jawabannya jelas, akurat, dan to the point. " +
  "Balas dalam bahasa yang dipakai user; kalau user pakai Indonesia, jawab Indonesia santai tapi rapi. " +
  "Kalau user minta kode, kasih kode lengkap yang siap dipakai di dalam code block, " +
  "lalu jelaskan singkat apa yang penting. Kalau kamu tidak yakin, bilang tidak yakin.";

const MAX_MESSAGES = 20;
const MAX_CHARS = 8000;
const PROVIDER_TIMEOUT_MS = 14000;

// Rate limit sederhana per IP. Best-effort: memori tiap instance function terpisah,
// jadi ini pagar kasar, bukan proteksi penuh.
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

function cleanMessages(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content !== "string" || !m.content.trim()) continue;
    out.push({ role: m.role, content: m.content.slice(0, MAX_CHARS) });
  }
  if (out.length === 0 || out[out.length - 1].role !== "user") return null;
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }

  // Wajib login — cegah orang luar ngabisin kuota API gratis.
  if (!getSession(req)) {
    return res.status(401).json({ error: "Sesi tidak valid. Silakan login lagi." });
  }

  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (limited(ip)) {
    return res.status(429).json({ error: "Terlalu banyak pesan. Tunggu semenit lalu coba lagi." });
  }

  const messages = cleanMessages(req.body?.messages);
  if (!messages) {
    return res.status(400).json({ error: "Pesan kosong atau formatnya salah." });
  }

  const requestedAgent = String(req.body?.agent || "auto").toLowerCase();
  const active = PROVIDERS.filter((p) => p.key);
  if (active.length === 0) {
    return res
      .status(500)
      .json({ error: "Belum ada API key. Isi minimal satu key di Environment Variables Vercel." });
  }

  let queue = active;
  let forcedOnly = false;
  if (requestedAgent !== "auto") {
    const forced = active.find((p) => p.id === requestedAgent);
    if (!forced) {
      return res.status(400).json({
        error: `Agent "${requestedAgent}" tidak tersedia (key belum diisi atau nama salah).`,
      });
    }
    queue = [forced];
    forcedOnly = true;
  }

  const payload = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
  const failures = [];

  for (const p of queue) {
    try {
      const r = await fetch(p.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.key}`,
        },
        body: JSON.stringify({ model: p.model, messages: payload, max_tokens: 2048 }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });

      if (!r.ok) {
        failures.push(`${p.id}:${r.status}`);
        continue; // limit habis / key salah / provider down -> coba berikutnya (kalau auto)
      }

      const data = await r.json();
      const reply = data?.choices?.[0]?.message?.content;
      if (typeof reply !== "string" || !reply.trim()) {
        failures.push(`${p.id}:kosong`);
        continue;
      }

      return res.status(200).json({ reply, provider: p.id });
    } catch (e) {
      failures.push(`${p.id}:${e.name === "TimeoutError" ? "timeout" : "error"}`);
    }
  }

  console.error("Semua provider gagal:", failures.join(", "));
  const msg = forcedOnly
    ? "Agent yang kamu pilih lagi bermasalah. Coba agent lain atau pakai Auto."
    : "Semua model gratis lagi penuh atau lambat. Coba kirim ulang sebentar lagi.";
  return res.status(503).json({ error: msg });
}
