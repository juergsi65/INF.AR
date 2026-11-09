import proj4 from "proj4";
import type { LatLon } from "./types";

/**
 * Gängige Koordinatensysteme für Leitungsdaten im DACH-Raum.
 * Die Daten werden beim Import nach WGS84 (EPSG:4326) umgerechnet.
 */
export const CRS_LIST: Array<{ code: string; label: string; def?: string }> = [
  { code: "EPSG:4326", label: "WGS84 (Längen-/Breitengrad)" },
  {
    code: "EPSG:31256",
    label: "AT · MGI / Gauß-Krüger M34 (Ost, Wien)",
    def: "+proj=tmerc +lat_0=0 +lon_0=16.33333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs",
  },
  {
    code: "EPSG:31255",
    label: "AT · MGI / Gauß-Krüger M31 (Mitte)",
    def: "+proj=tmerc +lat_0=0 +lon_0=13.33333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs",
  },
  {
    code: "EPSG:31254",
    label: "AT · MGI / Gauß-Krüger M28 (West)",
    def: "+proj=tmerc +lat_0=0 +lon_0=10.33333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs",
  },
  {
    code: "EPSG:31287",
    label: "AT · MGI / Austria Lambert",
    def: "+proj=lcc +lat_0=47.5 +lon_0=13.33333333333333 +lat_1=49 +lat_2=46 +x_0=400000 +y_0=400000 +ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs",
  },
  {
    code: "EPSG:25832",
    label: "DE · ETRS89 / UTM 32N",
    def: "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  },
  {
    code: "EPSG:25833",
    label: "DE/AT · ETRS89 / UTM 33N",
    def: "+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  },
  {
    code: "EPSG:31468",
    label: "DE · DHDN / Gauß-Krüger Zone 4",
    def: "+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs",
  },
  {
    code: "EPSG:2056",
    label: "CH · LV95",
    def: "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs",
  },
  { code: "EPSG:3857", label: "Web Mercator" },
];

for (const c of CRS_LIST) if (c.def) proj4.defs(c.code, c.def);

/** Liest den CRS-Code aus einem (alten) GeoJSON-"crs"-Member, z. B. "urn:ogc:def:crs:EPSG::31256". */
export function detectCrs(geojson: unknown): string | null {
  const name = (geojson as { crs?: { properties?: { name?: string } } })?.crs?.properties?.name;
  if (!name) return null;
  if (/CRS84$/i.test(name)) return "EPSG:4326";
  const m = /EPSG:*(\d+)/i.exec(name);
  return m ? `EPSG:${m[1]}` : null;
}

export function isKnownCrs(code: string): boolean {
  try {
    return !!proj4.defs(code);
  } catch {
    return false;
  }
}

/** Rechnet [x, y] im Quell-CRS nach [lon, lat] (WGS84). */
export function toWgs84(crs: string, xy: [number, number]): [number, number] {
  if (crs === "EPSG:4326") return xy;
  const [lon, lat] = proj4(crs, "EPSG:4326", xy);
  return [lon, lat];
}

// WGS84-Ellipsoid
const A = 6378137;
const E2 = 6.69437999014e-3;
const DEG = Math.PI / 180;

/** Krümmungsradien am Breitengrad (Meridian M, Querkrümmung N). */
function radii(latDeg: number) {
  const s = Math.sin(latDeg * DEG);
  const w = Math.sqrt(1 - E2 * s * s);
  return { M: (A * (1 - E2)) / (w * w * w), N: A / w };
}

/**
 * Lokales Ost/Nord-System (Meter) um einen Ursprung.
 * Für Distanzen bis wenige Kilometer liegt der Fehler im Zentimeterbereich.
 */
export function toEnu(origin: LatLon, p: LatLon): { e: number; n: number } {
  const { M, N } = radii(origin.lat);
  return {
    e: (p.lon - origin.lon) * DEG * N * Math.cos(origin.lat * DEG),
    n: (p.lat - origin.lat) * DEG * M,
  };
}

export function fromEnu(origin: LatLon, e: number, n: number): LatLon {
  const { M, N } = radii(origin.lat);
  return {
    lat: origin.lat + n / M / DEG,
    lon: origin.lon + e / (N * Math.cos(origin.lat * DEG)) / DEG,
  };
}

export function distance(a: LatLon, b: LatLon): number {
  const { e, n } = toEnu(a, b);
  return Math.hypot(e, n);
}

/** Kürzester Abstand eines Punkts zu einer Strecke (2D), plus Parameter t (0..1). */
export function pointSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { d: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

/** Normalisiert einen Winkel auf [0, 360). */
export function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Kürzeste Differenz b - a in Grad, im Bereich (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = wrap360(b - a);
  if (d > 180) d -= 360;
  return d;
}
