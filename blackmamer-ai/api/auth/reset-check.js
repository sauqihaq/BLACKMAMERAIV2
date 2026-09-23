// api/auth/reset-check.js — validasi token tanpa dikonsumsi
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak diizinkan." });

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ ok: false });

  const data = await redis.get(`reset:${String(token)}`);
  if (!data) return res.status(200).json({ ok: false, reason: "Token tidak valid atau sudah kedaluwarsa." });

  return res.status(200).json({ ok: true });
}
