// lib/apiKeys.js — personal API keys buat akses /api/v1/chat/completions
// dari luar (OpenCode, Cursor, Continue, dll).
//
// Tiap key ke-link ke SATU email. Isolasi antar user dijamin di sini:
// - verifyApiKey() cuma ngembaliin { email } punya key itu sendiri.
// - listApiKeys(email) cuma baca set milik email itu (user:<email>:apikeys).
// - Gak ada state/history yang digabung; tiap request ke /v1/chat/completions
//   stateless dan diproses independen per key (lihat api/v1/chat/completions.js).

import crypto from "node:crypto";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const KEY_PREFIX = "bm-sk-";
const MAX_KEYS_PER_USER = 10;

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

function genRawKey() {
  return KEY_PREFIX + crypto.randomBytes(24).toString("base64url");
}

export async function createApiKey(email, label) {
  const existing = await redis.smembers(`user:${email}:apikeys`);

  if (existing && existing.length >= MAX_KEYS_PER_USER) {
    return { ok: false, error: `Maksimal ${MAX_KEYS_PER_USER} API key per akun. Hapus salah satu dulu.` };
  }

  const rawKey = genRawKey();
  const hash = hashKey(rawKey);
  const createdAt = Date.now();
  const last4 = rawKey.slice(-4);

  const record = {
    email,
    label: String(label || "Untitled key").slice(0, 60),
    createdAt,
    last4,
    lastUsedAt: null,
  };

  await redis.set(`apikey:${hash}`, record);
  await redis.sadd(`user:${email}:apikeys`, hash);

  // rawKey cuma dikembalikan SEKALI, di sini. Server gak nyimpen bentuk mentahnya.
  return { ok: true, rawKey, ...record, hash };
}

export async function listApiKeys(email) {
  const hashes = (await redis.smembers(`user:${email}:apikeys`)) || [];
  if (!hashes.length) return [];

  const records = await Promise.all(
    hashes.map(async (hash) => {
      const rec = await redis.get(`apikey:${hash}`);
      if (!rec) return null;
      return { hash, label: rec.label, createdAt: rec.createdAt, last4: rec.last4, lastUsedAt: rec.lastUsedAt || null };
    })
  );

  return records.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

export async function revokeApiKey(email, hash) {
  const rec = await redis.get(`apikey:${hash}`);

  // Cek kepemilikan — jangan sampe user A bisa hapus key user B.
  if (!rec || rec.email !== email) {
    return { ok: false, error: "Key tidak ditemukan." };
  }

  await redis.del(`apikey:${hash}`);
  await redis.srem(`user:${email}:apikeys`, hash);

  return { ok: true };
}

// Dipanggil dari /api/v1/chat/completions.js buat autentikasi tiap request.
// Ngembaliin { email } kalau valid, null kalau enggak.
export async function verifyApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== "string" || !rawKey.startsWith(KEY_PREFIX)) {
    return null;
  }

  const hash = hashKey(rawKey);
  const rec = await redis.get(`apikey:${hash}`);

  if (!rec) return null;

  // Update lastUsedAt tanpa nge-block request (fire and forget).
  redis
    .set(`apikey:${hash}`, { ...rec, lastUsedAt: Date.now() })
    .catch(() => {});

  return { email: rec.email, hash };
}
