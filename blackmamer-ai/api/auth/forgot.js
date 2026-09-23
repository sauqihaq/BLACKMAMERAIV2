// api/auth/forgot.js — kirim link reset password ke email
import { issueResetToken, sendEmail, RESET_EMAIL_HTML } from "../../lib/session.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak diizinkan." });

  const { email } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();

  if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: "Format email tidak valid." });

  const result = await issueResetToken(cleanEmail);

  if (result.ok && result.token) {
    const baseUrl  = process.env.APP_URL || `https://${req.headers.host}`;
    const resetUrl = `${baseUrl}/reset-password?token=${result.token}`;
    await sendEmail(cleanEmail, "Reset password BlackMamer AI", RESET_EMAIL_HTML(resetUrl));
  }

  // Selalu balas ok — jangan kasih tau email terdaftar atau tidak (security)
  return res.status(200).json({ ok: true });
}
