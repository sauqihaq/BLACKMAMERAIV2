// api/auth/signup.js — daftar akun baru, simpen ke Redis
import { createUser, signSession, setSessionCookie } from "../../lib/session.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak diizinkan." });

  const { name, email, password } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanName  = String(name  || "").trim();
  const cleanPass  = String(password || "");

  if (!cleanName)                       return res.status(400).json({ error: "Nama tidak boleh kosong." });
  if (!EMAIL_RE.test(cleanEmail))       return res.status(400).json({ error: "Format email tidak valid." });
  if (cleanPass.length < 8)             return res.status(400).json({ error: "Password minimal 8 karakter." });

  const result = await createUser(cleanEmail, cleanName, cleanPass);
  if (result.error) return res.status(409).json({ error: result.error });

  // Langsung login setelah daftar
  const token = signSession(cleanEmail);
  setSessionCookie(res, token);
  return res.status(200).json({ ok: true, email: cleanEmail, name: cleanName });
}
