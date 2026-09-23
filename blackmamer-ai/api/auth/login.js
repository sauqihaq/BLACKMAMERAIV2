// api/auth/login.js — login step 1: cek email + password, lalu kirim OTP (2FA)
// Session baru dibuat di api/auth/verify.js setelah OTP-nya benar.
import { checkPassword, issueOtp, sendOtpEmail } from "../../lib/session.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak diizinkan." });

  const { email, password } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();

  if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: "Format email tidak valid." });
  if (!password || String(password).length < 1) return res.status(400).json({ error: "Password tidak boleh kosong." });

  const result = await checkPassword(cleanEmail, String(password));
  if (!result.ok) return res.status(401).json({ error: result.reason });

  const issued = await issueOtp(cleanEmail);
  if (issued.cooldown) {
    return res.status(429).json({ error: `Tunggu ${issued.cooldown} detik sebelum minta kode lagi.` });
  }

  const { sent } = await sendOtpEmail(cleanEmail, issued.otp);

  const payload = { ok: true, otp: true, sent, email: cleanEmail, name: result.user?.name || "" };
  if (!sent) {
    // Mode dev: email provider belum dikonfig, jadi OTP dibalikin langsung biar bisa dites.
    payload.devOtp = issued.otp;
  }
  return res.status(200).json(payload);
}
