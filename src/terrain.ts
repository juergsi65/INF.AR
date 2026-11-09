import { toEnu } from "./geo";
import type { InfraFeature, LatLon } from "./types";

/**
 * Geländehöhen aus dem Copernicus-DGM (ca. 30–90 m Raster) über die freie Open-Meteo-API.
 * Damit werden Gefälle und Höhenunterschiede zwischen Standort und Leitungen berücksichtigt.
 * Eigene Höhen in den Daten (`elev` je Stützpunkt oder `gok`) haben immer Vorrang.
 */
const API = "https://api.open-meteo.com/v1/elevation";
const BATCH = 100;
const cache = new Map<string, number>();

const key = (p: LatLon) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

export async function fetchElevations(points: LatLon[], signal?: AbortSignal): Promise<Array<number | null>> {
  const out: Array<number | null> = points.map((p) => cache.get(key(p)) ?? null);
  const missing = points.map((p, i) => ({ p, i })).filter(({ i }) => out[i] === null);
  for (let s = 0; s < missing.length; s += BATCH) {
    const chunk = missing.slice(s, s + BATCH);
    const url = `${API}?latitude=${chunk.map(({ p }) => p.lat.toFixed(5)).join(",")}&longitude=${chunk
      .map(({ p }) => p.lon.toFixed(5))
      .join(",")}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Höhendienst: HTTP ${res.status}`);
    const body = (await res.json()) as { elevation?: number[] };
    chunk.forEach(({ p, i }, j) => {
      const v = body.elevation?.[j];
      if (typeof v === "number" && Number.isFinite(v)) {
        cache.set(key(p), v);
        out[i] = v;
      }
    });
  }
  return out;
}

function vertices(f: InfraFeature): Array<[number, number]> {
  return f.geometry.type === "Point" ? [f.geometry.coordinates as [number, number]] : (f.geometry.coordinates as Array<[number, number]>);
}

/** Ergänzt fehlende Geländehöhen (`elev`) aller Objekte. Gibt true zurück, wenn sich etwas geändert hat. */
export async function ensureElevations(features: InfraFeature[], signal?: AbortSignal): Promise<boolean> {
  const todo: Array<{ f: InfraFeature; pts: LatLon[] }> = [];
  let changed = false;
  for (const f of features) {
    const pts = vertices(f).map(([lon, lat]) => ({ lat, lon }));
    const p = f.properties;
    if (Array.isArray(p.elev) && p.elev.length === pts.length) continue;
    const gok = typeof p.gok === "number" ? p.gok : typeof p.gok === "string" ? parseFloat(p.gok.replace(",", ".")) : NaN;
    if (Number.isFinite(gok)) {
      p.elev = pts.map(() => gok);
      changed = true;
      continue;
    }
    todo.push({ f, pts });
  }
  if (!todo.length) return changed;
  const all = todo.flatMap((t) => t.pts);
  const elevs = await fetchElevations(all, signal);
  let i = 0;
  for (const t of todo) {
    const vals = elevs.slice(i, i + t.pts.length);
    i += t.pts.length;
    if (vals.every((v) => v !== null)) {
      t.f.properties.elev = (vals as number[]).map((v) => Math.round(v * 100) / 100);
      changed = true;
    }
  }
  return changed;
}

/** Bezugshöhe des Projekts (Mittel aller Geländehöhen) oder null, wenn keine vorhanden. */
export function referenceElevation(features: InfraFeature[]): number | null {
  let sum = 0;
  let n = 0;
  for (const f of features) {
    const e = f.properties.elev;
    if (!Array.isArray(e)) continue;
    for (const v of e) {
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
  }
  return n ? Math.round((sum / n) * 100) / 100 : null;
}

/**
 * Geländehöhe an einer Position aus den Höhen der umliegenden Stützpunkte
 * (inverse Distanzgewichtung der 4 nächsten Punkte). Fallback, wenn der Höhendienst nicht erreichbar ist.
 */
export function interpolateElevation(features: InfraFeature[], pos: LatLon, maxDist = 150): number | null {
  const near: Array<{ d: number; v: number }> = [];
  for (const f of features) {
    const e = f.properties.elev;
    if (!Array.isArray(e)) continue;
    vertices(f).forEach(([lon, lat], i) => {
      const v = e[i];
      if (typeof v !== "number") return;
      const { e: de, n: dn } = toEnu(pos, { lat, lon });
      const d = Math.hypot(de, dn);
      if (d <= maxDist) near.push({ d, v });
    });
  }
  if (!near.length) return null;
  near.sort((a, b) => a.d - b.d);
  let ws = 0;
  let vs = 0;
  for (const { d, v } of near.slice(0, 4)) {
    if (d < 0.5) return v;
    const w = 1 / (d * d);
    ws += w;
    vs += w * v;
  }
  return vs / ws;
}
