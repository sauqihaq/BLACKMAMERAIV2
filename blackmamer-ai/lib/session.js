// lib/session.js — session cookie signing & shared in-memory stores
// Best-effort in-memory (per function instance). Cukup buat gating akses,
// bukan sistem auth enterprise.
import crypto from "node:crypto";
import nodemailer from "nodemailer";

const SECRET = process.env.SESSION_SECRET || "bm-ai-dev-secret-change-me";
const COOKIE_NAME = "bm_session";
const SESSION_DAYS = 30;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function signSession(email) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = b64url(JSON.stringify({ email, exp }));
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
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
  } catch (_) {
    return null;
  }
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

// ---------- OTP store (in-memory, per function instance) ----------
const otpStore = new Map(); // email -> { otp, expiresAt, attempts, lastSentAt }
const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;

export function issueOtp(email) {
  const now = Date.now();
  const existing = otpStore.get(email);
  if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    return { cooldown: Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000) };
  }
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  otpStore.set(email, { otp, expiresAt: now + OTP_TTL_MS, attempts: 0, lastSentAt: now });
  if (otpStore.size > 5000) otpStore.clear();
  return { otp };
}

export function checkOtp(email, code) {
  const entry = otpStore.get(email);
  if (!entry) return { ok: false, reason: "Belum ada kode OTP untuk email ini." };
  if (Date.now() > entry.expiresAt) {
    otpStore.delete(email);
    return { ok: false, reason: "Kode OTP sudah kedaluwarsa. Minta kode baru." };
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(email);
    return { ok: false, reason: "Terlalu banyak percobaan salah. Minta kode baru." };
  }
  entry.attempts += 1;
  if (entry.otp !== String(code).trim()) {
    return { ok: false, reason: "Kode OTP salah." };
  }
  otpStore.delete(email);
  return { ok: true };
}

const OTP_EMAIL_HTML = (otp) => `<div style="font-family:sans-serif;background:#0a0a0a;color:#fff;padding:32px;border-radius:16px">
  <p style="color:#fbbf24;letter-spacing:.2em;font-size:12px;margin:0 0 12px">BLACKMAMER AI</p>
  <h2 style="margin:0 0 8px">Kode verifikasi kamu</h2>
  <p style="color:#a3a3a3;margin:0 0 24px">Berlaku 5 menit. Jangan bagikan ke siapa pun.</p>
  <div style="font-size:36px;font-weight:800;letter-spacing:.3em;color:#fbbf24">${otp}</div>
</div>`;

let gmailTransporter; // cached across invocations dalam 1 function instance
function getGmailTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  }
  return gmailTransporter;
}

async function sendViaGmail(email, otp) {
  const transporter = getGmailTransporter();
  if (!transporter) return null; // GMAIL_USER/GMAIL_APP_PASSWORD belum diisi
  try {
    await transporter.sendMail({
      from: `"BlackMamer AI" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `${otp} — Kode verifikasi BlackMamer AI`,
      html: OTP_EMAIL_HTML(otp),
    });
    return { sent: true };
  } catch (e) {
    console.error("Gmail SMTP gagal:", e.message);
    return { sent: false };
  }
}

async function sendViaResend(email, otp) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null; // RESEND_API_KEY belum diisi
  const from = process.env.RESEND_FROM || "BlackMamer AI <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to: [email], subject: `${otp} — Kode verifikasi BlackMamer AI`, html: OTP_EMAIL_HTML(otp) }),
    });
    return { sent: r.ok };
  } catch (_) {
    return { sent: false };
  }
}

export async function sendOtpEmail(email, otp) {
  // Prioritas: Gmail SMTP (gratis, ke siapa aja) -> Resend (kalau dikonfig) -> mode dev.
  const viaGmail = await sendViaGmail(email, otp);
  if (viaGmail) return viaGmail;
  const viaResend = await sendViaResend(email, otp);
  if (viaResend) return viaResend;
  return { sent: false }; // dev mode — caller falls back to devOtp
}
