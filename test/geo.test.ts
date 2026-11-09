import { describe, expect, it } from "vitest";
import { angleDiff, distance, fromEnu, pointSegment, toEnu, toWgs84, wrap360 } from "../src/geo";

describe("ENU", () => {
  const o = { lat: 48.2085, lon: 16.3721 };

  it("rechnet hin und zurück", () => {
    const p = fromEnu(o, 123.4, -56.7);
    const { e, n } = toEnu(o, p);
    expect(e).toBeCloseTo(123.4, 4);
    expect(n).toBeCloseTo(-56.7, 4);
  });

  it("1 Bogensekunde Breite ≈ 30,9 m", () => {
    expect(distance(o, { lat: o.lat + 1 / 3600, lon: o.lon })).toBeCloseTo(30.9, 0);
  });
});

describe("Koordinatensysteme", () => {
  it("UTM 33N → WGS84 (Wien)", () => {
    const [lon, lat] = toWgs84("EPSG:25833", [601_000, 5_340_500]);
    expect(lat).toBeGreaterThan(48.1);
    expect(lat).toBeLessThan(48.3);
    expect(lon).toBeGreaterThan(16.2);
    expect(lon).toBeLessThan(16.5);
  });

  it("MGI GK M34 → WGS84 (Stephansdom ≈ 1.8 km Genauigkeit des Tests)", () => {
    // Stephansdom ca. x=2 400, y=341 000 in EPSG:31256
    const [lon, lat] = toWgs84("EPSG:31256", [2_400, 341_000]);
    expect(distance({ lat, lon }, { lat: 48.2085, lon: 16.3731 })).toBeLessThan(1800);
  });
});

describe("Hilfsfunktionen", () => {
  it("Punkt-Strecken-Abstand", () => {
    expect(pointSegment(5, 3, 0, 0, 10, 0)).toEqual({ d: 3, t: 0.5 });
    expect(pointSegment(-4, 3, 0, 0, 10, 0).d).toBe(5);
  });
  it("Winkel", () => {
    expect(wrap360(-10)).toBe(350);
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
  });
});
