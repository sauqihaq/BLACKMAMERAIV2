// api/keys.js — dashboard endpoint (pake session cookie, BUKAN API key) buat
// user generate/lihat/cabut API key mereka sendiri.
import { getSession } from "../lib/session.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../lib/apiKeys.js";

function json(res, status, data) {
  res.status(status).json(data);
}

export default async function handler(req, res) {
  const session = getSession(req);

  if (!session?.email) {
    return json(res, 401, { error: "Belum login." });
  }

  const email = session.email;

  try {
    if (req.method === "GET") {
      const keys = await listApiKeys(email);
      return json(res, 200, { ok: true, keys });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const result = await createApiKey(email, body.label);

      if (!result.ok) {
        return json(res, 400, { error: result.error });
      }

      // rawKey cuma dikirim di response ini — habis ini gak bisa dilihat lagi.
      return json(res, 200, {
        ok: true,
        rawKey: result.rawKey,
        hash: result.hash,
        label: result.label,
        last4: result.last4,
        createdAt: result.createdAt,
      });
    }

    if (req.method === "DELETE") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const hash = body.hash;

      if (!hash) {
        return json(res, 400, { error: "hash wajib diisi." });
      }

      const result = await revokeApiKey(email, hash);

      if (!result.ok) {
        return json(res, 404, { error: result.error });
      }

      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: "Method Not Allowed" });
  } catch (error) {
    console.error("[BLACKMAMER API KEYS ERROR]", error);
    return json(res, 500, { error: error?.message || "Internal server error." });
  }
}
