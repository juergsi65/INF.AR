import { describe, expect, it } from "vitest";
import { createDemoProject, importGeoJson, normalizeProps } from "../src/data";

describe("normalizeProps", () => {
  it("erkennt Sparte, Tiefe und DN aus Fremdattributen", () => {
    const p = normalizeProps({ Sparte: "Trinkwasser", Verlegetiefe: "1,35 m", DN: "150", Bezeichnung: "WL 12" }, "LineString");
    expect(p.medium).toBe("wasser");
    expect(p.kind).toBe("rohr");
    expect(p.depth).toBeCloseTo(1.35);
    expect(p.diameter).toBe(150);
    expect(p.name).toBe("WL 12");
  });

  it("Punkte werden Schächte, Durchmesser in Metern wird umgerechnet", () => {
    const p = normalizeProps({ typ: "Kanalschacht", durchmesser: 1.0 }, "Point");
    expect(p.kind).toBe("schacht");
    expect(p.medium).toBe("abwasser");
    expect(p.diameter).toBe(1000);
  });

  it("LWL-Kabel", () => {
    const p = normalizeProps({ art: "Kabel", netz: "LWL" }, "LineString");
    expect(p.kind).toBe("kabel");
    expect(p.medium).toBe("telekom");
  });
});

describe("importGeoJson", () => {
  it("importiert Multi-Geometrien und rechnet CRS um", () => {
    const res = importGeoJson({
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::25833" } },
      features: [
        { type: "Feature", properties: { sparte: "Gas" }, geometry: { type: "MultiLineString", coordinates: [[[601000, 5340500], [601010, 5340500]], [[601000, 5340510], [601000, 5340520]]] } },
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [601005, 5340505] } },
        { type: "Feature", properties: {}, geometry: null },
      ],
    });
    expect(res.crs).toBe("EPSG:25833");
    expect(res.features).toHaveLength(3);
    expect(res.skipped).toBe(1);
    expect(res.features[0].properties.medium).toBe("gas");
    const [lon, lat] = res.features[2].geometry.coordinates as [number, number];
    expect(lat).toBeGreaterThan(48);
    expect(lon).toBeGreaterThan(16);
  });

  it("meldet falsches Koordinatensystem verständlich", () => {
    expect(() =>
      importGeoJson({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [601000, 5340500] } }),
    ).toThrow(/Koordinatensystem/);
  });
});

describe("Demo", () => {
  it("erzeugt Linien und Schächte nahe am Zentrum", () => {
    const p = createDemoProject({ lat: 47.07, lon: 15.44 });
    expect(p.features.length).toBeGreaterThan(5);
    expect(p.features.some((f) => f.properties.kind === "schacht")).toBe(true);
  });
});
