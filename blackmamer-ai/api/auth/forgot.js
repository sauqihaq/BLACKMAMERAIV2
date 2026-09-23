// api/auth/forgot.js — kirim link reset password ke email
import { issueResetToken, sendEmail, RESET_EMAIL_HTML } from "../../lib/session.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak diizinkan." });

  const { email } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();

  if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: "Format email tidak valid." });

  const result = await issueResetToken(cleanEmail);

  // Email tidak terdaftar — tetap balas ok (security: jangan kasih hint)
  if (!result.ok || !result.token) {
    return res.status(200).json({ ok: true });
  }

  const baseUrl  = process.env.APP_URL || `https://${req.headers.host}`;
  const resetUrl = `${baseUrl}/reset-password?token=${result.token}`;
  const { sent } = await sendEmail(cleanEmail, "Reset password BlackMamer AI", RESET_EMAIL_HTML(resetUrl));

  const payload = { ok: true };

  // Mode dev: kalau email provider belum dikonfig, balikkin URL-nya langsung
  if (!sent) {
    payload.devResetUrl = resetUrl;
  }

  return res.status(200).json(payload);
}
