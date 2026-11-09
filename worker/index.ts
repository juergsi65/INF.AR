/**
 * Cloudflare Worker: liefert die statische App aus und stellt eine kleine API
 * zum Speichern von Projekten in Workers KV bereit.
 *
 * Leitungsdaten sind sensibel (kritische Infrastruktur): Die Projekt-Endpunkte
 * sind nur aktiv, wenn ein API_TOKEN als Secret gesetzt ist, und verlangen ihn
 * bei jedem Zugriff (Lesen und Schreiben).
 */

export interface Env {
  ASSETS: Fetcher;
  PROJECTS?: KVNamespace;
  API_TOKEN?: string;
}

const MAX_BYTES = 20 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** Vergleich in konstanter Zeit, um Timing-Angriffe auf das Token zu erschweren. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function authorized(req: Request, env: Env): boolean {
  if (!env.API_TOKEN) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return safeEqual(token, env.API_TOKEN);
}

interface StoredMeta {
  name: string;
  updatedAt: string;
  count: number;
}

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";

  if (path === "/health") {
    return json({ ok: true, storage: !!env.PROJECTS, auth: !!env.API_TOKEN });
  }

  if (!path.startsWith("/projects")) return json({ error: "Nicht gefunden" }, 404);
  if (!env.PROJECTS) return json({ error: "Cloud-Speicher ist nicht eingerichtet (KV-Binding PROJECTS fehlt)" }, 503);
  if (!env.API_TOKEN) return json({ error: "API_TOKEN ist nicht gesetzt – Cloud-Speicher deaktiviert" }, 503);
  if (!authorized(req, env)) return json({ error: "Ungültiges oder fehlendes Token" }, 401);

  const kv = env.PROJECTS;

  if (path === "/projects" && req.method === "GET") {
    const list = await kv.list<StoredMeta>({ prefix: "project:" });
    return json({
      projects: list.keys.map((k) => ({ id: k.name.slice("project:".length), ...(k.metadata ?? { name: "?", updatedAt: "", count: 0 }) })),
    });
  }

  const m = /^\/projects\/([^/]+)$/.exec(path);
  if (!m) return json({ error: "Nicht gefunden" }, 404);
  const id = decodeURIComponent(m[1]);
  if (!ID_RE.test(id)) return json({ error: "Ungültige Projekt-ID" }, 400);
  const key = `project:${id}`;

  switch (req.method) {
    case "GET": {
      const value = await kv.get(key);
      return value ? new Response(value, { headers: { "content-type": "application/json", "cache-control": "no-store" } }) : json({ error: "Projekt nicht gefunden" }, 404);
    }
    case "PUT": {
      const text = await req.text();
      if (text.length > MAX_BYTES) return json({ error: "Projekt zu groß (max. 20 MB)" }, 413);
      let body: { id?: unknown; name?: unknown; features?: unknown };
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "Ungültiges JSON" }, 400);
      }
      if (body.id !== id || typeof body.name !== "string" || !Array.isArray(body.features)) {
        return json({ error: "Ungültiges Projektformat" }, 400);
      }
      const meta: StoredMeta = { name: body.name.slice(0, 200), updatedAt: new Date().toISOString(), count: body.features.length };
      await kv.put(key, JSON.stringify({ ...body, updatedAt: meta.updatedAt }), { metadata: meta });
      return json({ ok: true });
    }
    case "DELETE":
      await kv.delete(key);
      return json({ ok: true });
    default:
      return json({ error: "Methode nicht erlaubt" }, 405);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env);
      } catch (e) {
        return json({ error: (e as Error).message || "Serverfehler" }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
