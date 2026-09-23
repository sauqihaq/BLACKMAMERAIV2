// lib/session.js — session cookie + user store (Redis) + password hashing
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { Redis } from "@upstash/redis";

const SECRET      = process.env.SESSION_SECRET || "bm-ai-dev-secret-change-me";
const COOKIE_NAME = "bm_session";
const SESSION_DAYS = 30;

// ─── Session JWT-lite ───────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function signSession(email) {
  const exp     = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = b64url(JSON.stringify({ email, exp }));
  const sig     = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.email || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (_) { return null; }
}

export function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function getSession(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[COOKIE_NAME]);
}

export function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === "production" ? "Secure; " : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; ${secure}SameSite=Lax`
  );
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

// ─── Redis ─────────────────────────────────────────────────────────────────

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// ─── Password hashing (scrypt — built-in Node, no extra deps) ──────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
  } catch (_) { return false; }
}

// ─── User store ────────────────────────────────────────────────────────────

const userKey = (email) => `user:${email.trim().toLowerCase()}`;

export async function createUser(email, name, password) {
  const key      = userKey(email);
  const existing = await redis.get(key);
  if (existing) return { error: "Email sudah terdaftar. Langsung login aja." };

  const passwordHash = hashPassword(password);
  const user = { email: email.trim().toLowerCase(), name, passwordHash, createdAt: Date.now() };
  await redis.set(key, user);
  return { ok: true, user };
}

export async function getUser(email) {
  return redis.get(userKey(email));
}

export async function checkPassword(email, password) {
  const user = await getUser(email);
  if (!user) return { ok: false, reason: "Email tidak ditemukan." };
  if (!verifyPassword(password, user.passwordHash)) {
    return { ok: false, reason: "Password salah." };
  }
  return { ok: true, user };
}

export async function updatePassword(email, newPassword) {
  const user = await getUser(email);
  if (!user) return { ok: false };
  user.passwordHash = hashPassword(newPassword);
  await redis.set(userKey(email), user);
  return { ok: true };
}

// ─── Reset password token ──────────────────────────────────────────────────

export async function issueResetToken(email) {
  const user = await getUser(email);
  // Selalu balas ok — jangan kasih hint email ada atau engga (security)
  if (!user) return { ok: true, sent: false };
  const token = crypto.randomBytes(32).toString("hex");
  await redis.set(`reset:${token}`, { email: user.email }, { ex: 3600 }); // 1 jam
  return { ok: true, token, email: user.email };
}

export async function consumeResetToken(token) {
  const data = await redis.get(`reset:${token}`);
  if (!data) return { ok: false, reason: "Link tidak valid atau sudah kedaluwarsa." };
  await redis.del(`reset:${token}`);
  return { ok: true, email: data.email };
}

// ─── OTP (tetap dipakai untuk flow lain jika dibutuhkan) ──────────────────

const OTP_TTL_SECONDS    = 5 * 60;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS       = 5;

export async function issueOtp(email) {
  const key      = `otp:${email}`;
  const existing = await redis.get(key);
  const now      = Date.now();
  if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    return { cooldown: Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000) };
  }
  const otp   = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const entry = { otp, attempts: 0, lastSentAt: now };
  await redis.set(key, entry, { ex: OTP_TTL_SECONDS });
  return { otp };
}

export async function checkOtp(email, code) {
  const key   = `otp:${email}`;
  const entry = await redis.get(key);
  if (!entry) return { ok: false, reason: "Belum ada kode OTP untuk email ini." };
  if (entry.attempts >= MAX_ATTEMPTS) {
    await redis.del(key);
    return { ok: false, reason: "Terlalu banyak percobaan salah. Minta kode baru." };
  }
  if (entry.otp !== String(code).trim()) {
    entry.attempts += 1;
    await redis.set(key, entry, { ex: OTP_TTL_SECONDS });
    return { ok: false, reason: "Kode OTP salah." };
  }
  await redis.del(key);
  return { ok: true };
}

// ─── Email helpers ─────────────────────────────────────────────────────────

const emailHtml = (title, body) => `
<div style="font-family:sans-serif;background:#0a0a0a;color:#fff;padding:32px;border-radius:16px;max-width:480px">
  <p style="color:#fbbf24;letter-spacing:.2em;font-size:12px;margin:0 0 12px">BLACKMAMER AI</p>
  <h2 style="margin:0 0 8px">${title}</h2>
  ${body}
</div>`;

export const OTP_EMAIL_HTML   = (otp)   => emailHtml("Kode verifikasi kamu",
  `<p style="color:#a3a3a3;margin:0 0 24px">Berlaku 5 menit. Jangan bagikan ke siapa pun.</p>
   <div style="font-size:36px;font-weight:800;letter-spacing:.3em;color:#fbbf24">${otp}</div>`);

export const RESET_EMAIL_HTML = (url)   => emailHtml("Reset password kamu",
  `<p style="color:#a3a3a3;margin:0 0 24px">Klik tombol di bawah untuk reset password. Link ini berlaku 1 jam.</p>
   <a href="${url}" style="display:inline-block;background:#d9ad5c;color:#1a1305;font-weight:700;padding:12px 28px;border-radius:10px;text-decoration:none">Reset Password</a>
   <p style="color:#666;font-size:12px;margin-top:20px">Kalau kamu tidak minta reset password, abaikan email ini.</p>`);

let gmailTransporter;
function getGmailTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  }
  return gmailTransporter;
}

async function sendViaGmail(to, subject, html) {
  const transporter = getGmailTransporter();
  if (!transporter) return null;
  try {
    await transporter.sendMail({ from: `"BlackMamer AI" <${process.env.GMAIL_USER}>`, to, subject, html });
    return { sent: true };
  } catch (e) { console.error("Gmail SMTP gagal:", e.message); return { sent: false }; }
}

async function sendViaResend(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  const from = process.env.RESEND_FROM || "BlackMamer AI <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    return { sent: r.ok };
  } catch (_) { return { sent: false }; }
}

export async function sendEmail(to, subject, html) {
  const viaGmail  = await sendViaGmail(to, subject, html);
  if (viaGmail)  return viaGmail;
  const viaResend = await sendViaResend(to, subject, html);
  if (viaResend) return viaResend;
  return { sent: false };
}

export async function sendOtpEmail(email, otp) {
  return sendEmail(email, `${otp} — Kode verifikasi BlackMamer AI`, OTP_EMAIL_HTML(otp));
}
