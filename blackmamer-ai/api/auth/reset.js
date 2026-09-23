// api/auth/reset.js — consume reset token dan update password baru
import { consumeResetToken, updatePassword, signSession, setSessionCookie } from "../../lib/session.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak diizinkan." });

  const { token, password } = req.body || {};
  if (!token)                         return res.status(400).json({ error: "Token tidak ada." });
  if (!password || String(password).length < 8) return res.status(400).json({ error: "Password minimal 8 karakter." });

  const result = await consumeResetToken(String(token));
  if (!result.ok) return res.status(400).json({ error: result.reason });

  await updatePassword(result.email, String(password));

  // Auto-login setelah reset
  const sessionToken = signSession(result.email);
  setSessionCookie(res, sessionToken);
  return res.status(200).json({ ok: true, email: result.email });
}
