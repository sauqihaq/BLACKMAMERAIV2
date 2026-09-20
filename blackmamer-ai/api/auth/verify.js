// api/auth/verify.js — verifikasi OTP, set session cookie
import { checkOtp, signSession, setSessionCookie } from "../../lib/session.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }

  const { email, code } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanCode = String(code || "").trim();

  if (!cleanEmail || !cleanCode) {
    return res.status(400).json({ error: "Email atau kode kosong." });
  }

  const result = await checkOtp(cleanEmail, cleanCode);
  if (!result.ok) {
    return res.status(401).json({ error: result.reason });
  }

  const token = signSession(cleanEmail);
  setSessionCookie(res, token);
  return res.status(200).json({ ok: true, email: cleanEmail });
}
