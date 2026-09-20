// api/auth/me.js — cek sesi aktif
import { getSession } from "../../lib/session.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Belum login." });
  return res.status(200).json({ ok: true, email: session.email });
}
