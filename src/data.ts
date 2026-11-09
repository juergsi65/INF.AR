import { detectCrs, fromEnu, isKnownCrs, toWgs84 } from "./geo";
import type { InfraFeature, InfraProject, InfraProps, Kind, LatLon, Medium } from "./types";

export const MEDIA: Record<Medium, { label: string; color: string }> = {
  strom: { label: "Strom", color: "#e53935" },
  gas: { label: "Gas", color: "#fdd835" },
  wasser: { label: "Wasser", color: "#1e88e5" },
  abwasser: { label: "Abwasser / Kanal", color: "#8d6e63" },
  telekom: { label: "Telekom / LWL", color: "#fb8c00" },
  fernwaerme: { label: "Fernwärme", color: "#ab47bc" },
  sonstige: { label: "Sonstige", color: "#9e9e9e" },
};

export const KINDS: Record<Kind, { label: string; defaultDepth: number; defaultDiameter: number }> = {
  trasse: { label: "Trasse", defaultDepth: 0.8, defaultDiameter: 0 },
  rohr: { label: "Rohr", defaultDepth: 1.0, defaultDiameter: 150 },
  kabel: { label: "Kabel", defaultDepth: 0.7, defaultDiameter: 50 },
  schacht: { label: "Schacht", defaultDepth: 2.0, defaultDiameter: 1000 },
};

export function uid(prefix = "f"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Import / Normalisierung
// ---------------------------------------------------------------------------

const MEDIUM_HINTS: Array<[RegExp, Medium]> = [
  [/abwasser|kanal|sewer|schmutz|regen|mischw/i, "abwasser"],
  [/fernw|district|heat|wärme|waerme/i, "fernwaerme"],
  [/gas/i, "gas"],
  [/wasser|water|trinkw/i, "wasser"],
  [/strom|elektr|power|nieder|mittel|hoch|nsp|msp|kv\b|energie/i, "strom"],
  [/tele|lwl|glasf|fiber|fibre|ftth|kom|daten|cu-|kupfer/i, "telekom"],
];

const KIND_HINTS: Array<[RegExp, Kind]> = [
  [/schacht|manhole|kammer|pit|chamber/i, "schacht"],
  [/trasse|graben|trench|corridor|korridor|bündel|buendel/i, "trasse"],
  [/kabel|cable|lwl|leitung.*strom/i, "kabel"],
  [/rohr|pipe|leitung|kanal|haltung|duct/i, "rohr"],
];

function pick(props: Record<string, unknown>, keys: string[]): unknown {
  const lower = Object.fromEntries(Object.entries(props).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) if (lower[k] !== undefined && lower[k] !== null && lower[k] !== "") return lower[k];
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(",", ".").replace(/[^0-9.+-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function guess<T>(text: string, hints: Array<[RegExp, T]>): T | undefined {
  for (const [re, val] of hints) if (re.test(text)) return val;
  return undefined;
}

/** Erzeugt vollständige, einheitliche Properties aus beliebigen Fremdattributen. */
export function normalizeProps(raw: Record<string, unknown>, geomType: "Point" | "LineString"): InfraProps {
  const text = Object.values(raw)
    .filter((v) => typeof v === "string")
    .join(" ");

  const kindRaw = String(pick(raw, ["kind", "art", "typ", "type", "objektart", "class"]) ?? "");
  let kind: Kind | undefined = (Object.keys(KINDS) as Kind[]).find((k) => k === kindRaw.toLowerCase());
  kind ??= guess(kindRaw, KIND_HINTS) ?? guess(text, KIND_HINTS);
  if (geomType === "Point") kind = "schacht";
  else if (!kind || kind === "schacht") kind = "rohr";

  const medRaw = String(pick(raw, ["medium", "sparte", "netz", "network", "utility", "layer"]) ?? "");
  let medium: Medium | undefined = (Object.keys(MEDIA) as Medium[]).find((m) => m === medRaw.toLowerCase());
  medium ??= guess(medRaw, MEDIUM_HINTS) ?? guess(text, MEDIUM_HINTS) ?? "sonstige";

  const def = KINDS[kind];
  let depth = num(pick(raw, ["depth", "tiefe", "verlegetiefe", "ueberdeckung", "überdeckung", "cover", "sohltiefe"]));
  if (depth === undefined || depth < 0 || depth > 50) depth = def.defaultDepth;

  let diameter = num(pick(raw, ["diameter", "durchmesser", "dn", "dm", "nennweite", "da", "size"]));
  if (diameter !== undefined && diameter > 0 && diameter < 5) diameter *= 1000; // Meter → mm
  if (diameter === undefined || diameter <= 0) diameter = def.defaultDiameter;

  const depthsRaw = raw.depths;
  const depths = Array.isArray(depthsRaw) ? depthsRaw.map((d) => num(d) ?? depth!) : undefined;

  const width = num(pick(raw, ["width", "breite"]));

  const props: InfraProps = {
    ...raw,
    id: String(pick(raw, ["id", "fid", "objectid", "gid"]) ?? uid()),
    kind,
    medium,
    depth,
    diameter,
  };
  const name = pick(raw, ["name", "bezeichnung", "label", "titel"]);
  if (name !== undefined) props.name = String(name);
  const material = pick(raw, ["material", "werkstoff"]);
  if (material !== undefined) props.material = String(material);
  const operator = pick(raw, ["operator", "betreiber", "eigentümer", "eigentuemer", "owner"]);
  if (operator !== undefined) props.operator = String(operator);
  if (depths) props.depths = depths;
  if (kind === "trasse") props.width = width && width > 0 ? width : 1;
  else delete props.width;
  return props;
}

export interface ImportResult {
  features: InfraFeature[];
  crs: string;
  skipped: number;
}

/**
 * Importiert ein GeoJSON (FeatureCollection, Feature oder Geometrie).
 * Unterstützt Point/LineString und deren Multi-Varianten, Polygone werden als Trasse (Umring) übernommen.
 */
export function importGeoJson(input: unknown, crsOverride?: string): ImportResult {
  const crs = crsOverride || detectCrs(input) || "EPSG:4326";
  if (!isKnownCrs(crs)) throw new Error(`Unbekanntes Koordinatensystem: ${crs}`);

  const obj = input as { type?: string; features?: unknown[] };
  let list: Array<{ geometry?: { type: string; coordinates: unknown }; properties?: Record<string, unknown> }>;
  if (obj?.type === "FeatureCollection" && Array.isArray(obj.features)) list = obj.features as typeof list;
  else if (obj?.type === "Feature") list = [obj as (typeof list)[number]];
  else if (obj?.type) list = [{ geometry: obj as never, properties: {} }];
  else throw new Error("Keine gültige GeoJSON-Datei");

  const out: InfraFeature[] = [];
  let skipped = 0;
  const conv = (c: number[]): [number, number] => {
    const [lon, lat] = toWgs84(crs, [c[0], c[1]]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error(
        `Koordinate ${c[0]}, ${c[1]} liegt außerhalb von WGS84 – bitte das richtige Koordinatensystem wählen.`,
      );
    }
    return [round7(lon), round7(lat)];
  };

  for (const f of list) {
    const g = f?.geometry;
    const raw = f?.properties ?? {};
    if (!g) {
      skipped++;
      continue;
    }
    const push = (type: "Point" | "LineString", coordinates: unknown, multi: boolean) => {
      const props = normalizeProps(raw, type);
      if (multi) props.id = uid();
      if (type === "Point") {
        out.push({ type: "Feature", geometry: { type, coordinates: conv(coordinates as number[]) }, properties: props });
      } else {
        const coords = (coordinates as number[][]).map(conv);
        if (coords.length < 2) {
          skipped++;
          return;
        }
        if (props.depths && props.depths.length !== coords.length) delete props.depths;
        out.push({ type: "Feature", geometry: { type, coordinates: coords }, properties: props });
      }
    };
    switch (g.type) {
      case "Point":
        push("Point", g.coordinates, false);
        break;
      case "MultiPoint":
        for (const c of g.coordinates as unknown[]) push("Point", c, true);
        break;
      case "LineString":
        push("LineString", g.coordinates, false);
        break;
      case "MultiLineString":
        for (const c of g.coordinates as unknown[]) push("LineString", c, true);
        break;
      case "Polygon": {
        const ring = (g.coordinates as unknown[])[0];
        push("LineString", ring, false);
        out[out.length - 1].properties.kind = "trasse";
        out[out.length - 1].properties.width ??= 0.5;
        break;
      }
      default:
        skipped++;
    }
  }
  return { features: out, crs, skipped };
}

function round7(v: number) {
  return Math.round(v * 1e7) / 1e7;
}

export function toGeoJson(project: InfraProject) {
  return { type: "FeatureCollection", name: project.name, features: project.features };
}

// ---------------------------------------------------------------------------
// Demo-Daten
// ---------------------------------------------------------------------------

/** Erzeugt ein realistisches Beispiel-Leitungsnetz rund um eine Position. */
export function createDemoProject(center: LatLon): InfraProject {
  const P = (e: number, n: number): [number, number] => {
    const p = fromEnu(center, e, n);
    return [round7(p.lon), round7(p.lat)];
  };
  const line = (pts: Array<[number, number]>) => pts.map(([e, n]) => P(e, n));
  const f = (geometry: InfraFeature["geometry"], p: Partial<InfraProps> & Pick<InfraProps, "kind" | "medium">): InfraFeature => ({
    type: "Feature",
    geometry,
    properties: {
      id: uid(),
      depth: KINDS[p.kind].defaultDepth,
      diameter: KINDS[p.kind].defaultDiameter,
      ...p,
    },
  });

  const features: InfraFeature[] = [
    f({ type: "LineString", coordinates: line([[-25, 4], [25, 4]]) }, {
      kind: "rohr", medium: "gas", name: "Gas ND DN150", depth: 1.0, diameter: 160, material: "PE 100",
    }),
    f({ type: "LineString", coordinates: line([[-25, 6], [10, 6], [14, 10], [14, 30]]) }, {
      kind: "rohr", medium: "wasser", name: "Wasser DN100", depth: 1.4, diameter: 110, material: "GGG",
    }),
    f({ type: "LineString", coordinates: line([[-25, -3], [25, -3]]) }, {
      kind: "trasse", medium: "telekom", name: "LWL-Trasse", depth: 0.7, width: 0.6,
    }),
    f({ type: "LineString", coordinates: line([[-25, -3.1], [25, -3.1]]) }, {
      kind: "kabel", medium: "telekom", name: "Speedpipe 12x7", depth: 0.6, diameter: 40,
    }),
    f({ type: "LineString", coordinates: line([[-25, -2.6], [5, -2.6], [5, -20]]) }, {
      kind: "kabel", medium: "strom", name: "NS-Kabel 4x150", depth: 0.8, diameter: 55, operator: "Netzbetreiber",
    }),
    f({ type: "LineString", coordinates: line([[-20, 0], [0, 0], [22, 0]]) }, {
      kind: "rohr", medium: "abwasser", name: "MW-Kanal DN300", depth: 2.2, depths: [2.0, 2.2, 2.45], diameter: 300,
      material: "Steinzeug",
    }),
    f({ type: "Point", coordinates: P(-20, 0) }, {
      kind: "schacht", medium: "abwasser", name: "Schacht S1", depth: 2.6, diameter: 1000,
    }),
    f({ type: "Point", coordinates: P(0, 0) }, {
      kind: "schacht", medium: "abwasser", name: "Schacht S2", depth: 2.8, diameter: 1000,
    }),
    f({ type: "Point", coordinates: P(22, 0) }, {
      kind: "schacht", medium: "abwasser", name: "Schacht S3", depth: 3.0, diameter: 1000,
    }),
    f({ type: "Point", coordinates: P(-8, -3) }, {
      kind: "schacht", medium: "telekom", name: "LWL-Handloch", depth: 0.9, diameter: 600,
    }),
  ];
  return { id: uid("p"), name: "Demo-Netz", updatedAt: new Date().toISOString(), features };
}

// ---------------------------------------------------------------------------
// Lokale Speicherung
// ---------------------------------------------------------------------------

const LS_PROJECTS = "infrasight.projects.v1";
const LS_ACTIVE = "infrasight.active";

export function loadLocalProjects(): InfraProject[] {
  try {
    const list = JSON.parse(localStorage.getItem(LS_PROJECTS) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveLocalProjects(list: InfraProject[]) {
  localStorage.setItem(LS_PROJECTS, JSON.stringify(list));
}

export function getActiveId(): string | null {
  return localStorage.getItem(LS_ACTIVE);
}

export function setActiveId(id: string) {
  localStorage.setItem(LS_ACTIVE, id);
}

// ---------------------------------------------------------------------------
// Cloud-Sync (Cloudflare Worker + KV)
// ---------------------------------------------------------------------------

const LS_TOKEN = "infrasight.token";
export const getToken = () => localStorage.getItem(LS_TOKEN) || "";
export const setToken = (t: string) => localStorage.setItem(LS_TOKEN, t.trim());

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}`, ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  return body as T;
}

export const cloud = {
  health: () => api<{ ok: boolean; storage: boolean; auth: boolean }>("/health"),
  list: () => api<{ projects: Array<{ id: string; name: string; updatedAt: string; count: number }> }>("/projects"),
  get: (id: string) => api<InfraProject>(`/projects/${encodeURIComponent(id)}`),
  put: (p: InfraProject) =>
    api<{ ok: true }>(`/projects/${encodeURIComponent(p.id)}`, { method: "PUT", body: JSON.stringify(p) }),
  remove: (id: string) => api<{ ok: true }>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
