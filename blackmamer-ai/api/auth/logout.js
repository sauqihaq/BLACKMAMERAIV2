// api/auth/logout.js — hapus session cookie
import { clearSessionCookie } from "../../lib/session.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
}
