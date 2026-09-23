// api/auth/login.js — login dengan email + password
import { checkPassword, signSession, setSessionCookie } from "../../lib/session.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak diizinkan." });

  const { email, password } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();

  if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: "Format email tidak valid." });
  if (!password || String(password).length < 1) return res.status(400).json({ error: "Password tidak boleh kosong." });

  const result = await checkPassword(cleanEmail, String(password));
  if (!result.ok) return res.status(401).json({ error: result.reason });

  const token = signSession(cleanEmail);
  setSessionCookie(res, token);
  return res.status(200).json({ ok: true, email: cleanEmail, name: result.user?.name || "" });
}
