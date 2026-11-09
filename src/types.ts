/** Art des Infrastruktur-Objekts. */
export type Kind = "trasse" | "rohr" | "kabel" | "schacht";

/** Sparte / Medium – bestimmt die Farbe. */
export type Medium =
  | "strom"
  | "gas"
  | "wasser"
  | "abwasser"
  | "telekom"
  | "fernwaerme"
  | "sonstige";

export interface InfraProps {
  id: string;
  kind: Kind;
  medium: Medium;
  name?: string;
  /**
   * Tiefe in Metern unter Geländeoberkante.
   * Rohr/Kabel: Oberkante (Überdeckung). Schacht: Sohltiefe. Trasse: Tiefe der Trassensohle.
   */
  depth: number;
  /** Optional: Tiefe je Stützpunkt (gleiche Länge wie die Koordinaten), z. B. für Kanal-Gefälle. */
  depths?: number[];
  /** Durchmesser in Millimetern (Rohr/Kabel/Schacht). */
  diameter: number;
  /** Breite in Metern (nur Trasse). */
  width?: number;
  material?: string;
  operator?: string;
  note?: string;
  [extra: string]: unknown;
}

export type InfraGeometry =
  | { type: "Point"; coordinates: [number, number] | [number, number, number] }
  | { type: "LineString"; coordinates: Array<[number, number] | [number, number, number]> };

export interface InfraFeature {
  type: "Feature";
  geometry: InfraGeometry;
  properties: InfraProps;
}

export interface InfraProject {
  id: string;
  name: string;
  updatedAt: string;
  features: InfraFeature[];
}

export interface LatLon {
  lat: number;
  lon: number;
}
