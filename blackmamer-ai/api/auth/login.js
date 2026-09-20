// api/auth/login.js — kirim OTP ke email (publik, siapa aja boleh daftar pake email sendiri)
import { issueOtp, sendOtpEmail } from "../../lib/session.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }

  const { email } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();

  if (!EMAIL_RE.test(cleanEmail)) {
    return res.status(400).json({ error: "Format email tidak valid." });
  }

  const issued = issueOtp(cleanEmail);
  if (issued.cooldown) {
    return res.status(429).json({ error: `Tunggu ${issued.cooldown} detik sebelum minta kode lagi.` });
  }

  const { sent } = await sendOtpEmail(cleanEmail, issued.otp);

  const payload = { ok: true, sent };
  if (!sent) {
    // Mode dev: RESEND_API_KEY belum diisi, jadi OTP dibalikin langsung biar bisa dites.
    payload.devOtp = issued.otp;
  }
  return res.status(200).json(payload);
}
