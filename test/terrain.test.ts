import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createDemoProject, isDemoProject, projectCenter } from "../src/data";
import { distance } from "../src/geo";
import { headingOf, orientationToQuaternion } from "../src/sensors";
import { ensureElevations, interpolateElevation, referenceElevation } from "../src/terrain";
import type { InfraFeature } from "../src/types";

const pt = (lon: number, lat: number, elev: number): InfraFeature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { id: `${lon}`, kind: "schacht", medium: "abwasser", depth: 2, diameter: 1000, elev: [elev] },
});

describe("Gelände", () => {
  const fs = [pt(16.0, 48.0, 200), pt(16.0005, 48.0, 210)];

  it("Bezugshöhe = Mittel", () => {
    expect(referenceElevation(fs)).toBe(205);
    expect(referenceElevation([])).toBeNull();
  });

  it("interpoliert zwischen Stützpunkten", () => {
    const v = interpolateElevation(fs, { lat: 48.0, lon: 16.00025 })!;
    expect(v).toBeGreaterThan(204);
    expect(v).toBeLessThan(206);
    expect(interpolateElevation(fs, { lat: 48.0, lon: 16.0 })).toBe(200);
    expect(interpolateElevation(fs, { lat: 49, lon: 16 })).toBeNull();
  });

  it("übernimmt gok aus den Daten ohne Netzzugriff", async () => {
    const f = pt(16, 48, 0);
    delete f.properties.elev;
    f.properties.gok = "187,5";
    expect(await ensureElevations([f])).toBe(true);
    expect(f.properties.elev).toEqual([187.5]);
  });
});

describe("Lagesensor", () => {
  const q = new THREE.Quaternion();
  it("aufrecht, alpha 0 → Blick nach Norden", () => {
    expect(headingOf(orientationToQuaternion(q, 0, 90, 0, 0))).toBeCloseTo(0, 5);
  });
  it("alpha 90 (gegen Uhrzeigersinn) → Westen", () => {
    expect(headingOf(orientationToQuaternion(q, 90, 90, 0, 0))).toBeCloseTo(270, 5);
  });
  it("Nordkorrektur als Gier-Drehung entspricht alpha-Versatz", () => {
    const rel = orientationToQuaternion(new THREE.Quaternion(), 30, 80, 10, 0);
    const abs = orientationToQuaternion(new THREE.Quaternion(), 75, 80, 10, 0);
    const d = rel.clone().invert().premultiply(abs);
    expect((2 * Math.atan2(d.y, d.w) * 180) / Math.PI).toBeCloseTo(45, 4);
  });
});

describe("Demo-Netz", () => {
  it("liegt am übergebenen Standort und ist als Demo markiert", () => {
    const here = { lat: 47.2692, lon: 11.4041 };
    const p = createDemoProject(here);
    expect(isDemoProject(p)).toBe(true);
    expect(distance(projectCenter(p)!, here)).toBeLessThan(15);
  });
  it("erkennt alte Demo-Projekte", () => {
    expect(isDemoProject({ id: "x", name: "Demo-Netz", updatedAt: "", features: [] })).toBe(true);
    expect(isDemoProject({ id: "x", name: "Demo 09.11.26, 14:00", updatedAt: "", features: [] })).toBe(true);
    expect(isDemoProject({ id: "x", name: "Kanal Hauptstraße", updatedAt: "", features: [] })).toBe(false);
  });
});
