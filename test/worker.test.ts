import { describe, expect, it } from "vitest";
import { handleApi, type Env } from "../worker/index";

function memoryKv() {
  const store = new Map<string, { value: string; metadata: unknown }>();
  return {
    get: async (k: string) => store.get(k)?.value ?? null,
    put: async (k: string, value: string, o?: { metadata?: unknown }) => void store.set(k, { value, metadata: o?.metadata }),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })),
    }),
  } as unknown as KVNamespace;
}

const req = (path: string, init: RequestInit & { token?: string } = {}) =>
  new Request(`https://x.test/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${init.token ?? "geheim"}`, "content-type": "application/json" },
  });

describe("Worker-API", () => {
  const env = { PROJECTS: memoryKv(), API_TOKEN: "geheim" } as Env;

  it("health", async () => {
    const r = await handleApi(req("/health"), {} as Env);
    expect(await r.json()).toEqual({ ok: true, storage: false, auth: false });
  });

  it("ohne Token-Konfiguration deaktiviert", async () => {
    const r = await handleApi(req("/projects"), { PROJECTS: memoryKv() } as Env);
    expect(r.status).toBe(503);
  });

  it("falsches Token → 401", async () => {
    const r = await handleApi(req("/projects", { token: "falsch" }), env);
    expect(r.status).toBe(401);
  });

  it("speichern, auflisten, laden, löschen", async () => {
    const project = { id: "p-1", name: "Test", features: [{ type: "Feature" }] };
    expect((await handleApi(req("/projects/p-1", { method: "PUT", body: JSON.stringify(project) }), env)).status).toBe(200);
    const list = (await (await handleApi(req("/projects"), env)).json()) as { projects: Array<{ id: string; count: number }> };
    expect(list.projects).toMatchObject([{ id: "p-1", name: "Test", count: 1 }]);
    const got = (await (await handleApi(req("/projects/p-1"), env)).json()) as { name: string };
    expect(got.name).toBe("Test");
    expect((await handleApi(req("/projects/p-1", { method: "DELETE" }), env)).status).toBe(200);
    expect((await handleApi(req("/projects/p-1"), env)).status).toBe(404);
  });

  it("weist ID-Mismatch und ungültige IDs ab", async () => {
    const body = JSON.stringify({ id: "anders", name: "x", features: [] });
    expect((await handleApi(req("/projects/p-2", { method: "PUT", body }), env)).status).toBe(400);
    expect((await handleApi(req("/projects/..%2Fx"), env)).status).toBe(400);
  });
});
