import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { KINDS, MEDIA } from "./data";
import { toEnu } from "./geo";
import type { InfraFeature, LatLon } from "./types";

/**
 * Szene-Koordinaten: x = Ost, y = Höhe (0 = Geländeoberkante), z = −Nord (Meter).
 * Der Ursprung (`origin`) ist ein fixer WGS84-Punkt des Projekts.
 */
export function enuToVec(origin: LatLon, lon: number, lat: number, y = 0): THREE.Vector3 {
  const { e, n } = toEnu(origin, { lat, lon });
  return new THREE.Vector3(e, y, -n);
}

export interface BuiltScene {
  root: THREE.Group;
  objects: Map<string, THREE.Group>;
  labels: THREE.Object3D[];
  dispose(): void;
}

const UP = new THREE.Vector3(0, 1, 0);

function segmentCylinder(a: THREE.Vector3, b: THREE.Vector3, r: number, radial = 12): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, Math.max(len, 0.001), radial, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

function jointSphere(p: THREE.Vector3, r: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 12, 8);
  g.translate(p.x, p.y, p.z);
  return g;
}

function makeLabel(lines: string[], color: string): THREE.Sprite {
  const scale = 2;
  const font = 28 * scale;
  const pad = 14 * scale;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2 + 10 * scale;
  const h = lines.length * font * 1.25 + pad * 2;
  canvas.width = Math.ceil(w);
  canvas.height = Math.ceil(h);
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(12,16,24,0.82)";
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, 12 * scale);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 8 * scale, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => {
    if (i > 0) ctx.fillStyle = "#cfd8dc";
    ctx.fillText(l, pad + 8 * scale, pad + i * font * 1.25);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const worldH = 0.22 * lines.length + 0.12;
  sprite.scale.set((worldH * canvas.width) / canvas.height, worldH, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function fmtM(v: number): string {
  return `${v.toFixed(2).replace(".", ",")} m`;
}

export function describe(f: InfraFeature): string[] {
  const p = f.properties;
  const title = p.name || `${KINDS[p.kind].label} ${MEDIA[p.medium].label}`;
  const parts: string[] = [];
  if (p.kind === "schacht") parts.push(`Sohle ${fmtM(p.depth)}`);
  else if (p.depths?.length) {
    parts.push(`T ${fmtM(Math.min(...p.depths))}–${fmtM(Math.max(...p.depths))}`);
  } else parts.push(`T ${fmtM(p.depth)}`);
  if (p.kind === "trasse") parts.push(`B ${fmtM(p.width ?? 1)}`);
  else if (p.diameter) parts.push(`Ø ${p.diameter} mm`);
  return [title, parts.join(" · ")];
}

/** Punkt auf halber Länge einer Polylinie (für Beschriftungen). */
function midpoint(pts: THREE.Vector3[]): THREE.Vector3 {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += pts[i].distanceTo(pts[i - 1]);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].distanceTo(pts[i - 1]);
    if (acc + d >= total / 2) return pts[i - 1].clone().lerp(pts[i], (total / 2 - acc) / (d || 1));
    acc += d;
  }
  return pts[0].clone();
}

function material(color: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  const c = new THREE.Color(color);
  return new THREE.MeshStandardMaterial({
    color: c,
    emissive: c.clone().multiplyScalar(0.35),
    roughness: 0.55,
    metalness: 0.05,
    ...opts,
  });
}

export function buildScene(features: InfraFeature[], origin: LatLon): BuiltScene {
  const root = new THREE.Group();
  root.name = "infra";
  const objects = new Map<string, THREE.Group>();
  const labels: THREE.Object3D[] = [];
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

  for (const f of features) {
    const p = f.properties;
    const color = MEDIA[p.medium]?.color ?? MEDIA.sonstige.color;
    const g = new THREE.Group();
    g.userData = { featureId: p.id, medium: p.medium, kind: p.kind };
    let labelPos: THREE.Vector3;

    if (f.geometry.type === "Point") {
      const [lon, lat] = f.geometry.coordinates;
      const c = enuToVec(origin, lon, lat);
      const r = Math.max(p.diameter, 300) / 2000;
      const d = Math.max(p.depth, 0.2);

      const wall = new THREE.Mesh(
        track(new THREE.CylinderGeometry(r, r, d, 32, 1, true)),
        track(material(color, { transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })),
      );
      wall.position.set(c.x, -d / 2, c.z);
      const floor = new THREE.Mesh(track(new THREE.CircleGeometry(r, 32)), track(material(color, { side: THREE.DoubleSide })));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(c.x, -d, c.z);
      const lid = new THREE.Mesh(
        track(new THREE.RingGeometry(r * 0.78, r * 1.08, 40)),
        track(new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })),
      );
      lid.rotation.x = -Math.PI / 2;
      lid.position.set(c.x, 0.02, c.z);
      const cover = new THREE.Mesh(
        track(new THREE.CircleGeometry(r * 0.78, 40)),
        track(new THREE.MeshBasicMaterial({ color: 0x37474f, transparent: true, opacity: 0.55, side: THREE.DoubleSide })),
      );
      cover.rotation.x = -Math.PI / 2;
      cover.position.set(c.x, 0.015, c.z);
      g.add(wall, floor, lid, cover);
      labelPos = c;
    } else {
      const coords = f.geometry.coordinates;
      const depths = p.depths && p.depths.length === coords.length ? p.depths : coords.map(() => p.depth);
      const ground = coords.map(([lon, lat]) => enuToVec(origin, lon, lat, 0.03));

      if (p.kind === "trasse") {
        const w = p.width ?? 1;
        const parts: THREE.BufferGeometry[] = [];
        for (let i = 1; i < ground.length; i++) {
          const a = ground[i - 1];
          const b = ground[i];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (len < 0.01) continue;
          const d = Math.max((depths[i - 1] + depths[i]) / 2, 0.1);
          const box = new THREE.BoxGeometry(w, d, len + w * 0.02);
          box.rotateY(Math.atan2(b.x - a.x, b.z - a.z));
          box.translate((a.x + b.x) / 2, -d / 2, (a.z + b.z) / 2);
          parts.push(box);
        }
        if (parts.length) {
          const merged = track(mergeGeometries(parts)!);
          parts.forEach((x) => x.dispose());
          g.add(
            new THREE.Mesh(
              merged,
              track(material(color, { transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide })),
            ),
          );
          const edges = new THREE.LineSegments(
            track(new THREE.EdgesGeometry(merged, 30)),
            track(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 })),
          );
          g.add(edges);
        }
      } else {
        const minR = p.kind === "kabel" ? 0.025 : 0.04;
        const r = Math.max(p.diameter / 2000, minR);
        const axis = coords.map(([lon, lat], i) => enuToVec(origin, lon, lat, -(depths[i] + r)));
        const parts: THREE.BufferGeometry[] = [];
        for (let i = 1; i < axis.length; i++) parts.push(segmentCylinder(axis[i - 1], axis[i], r));
        for (const pt of axis) parts.push(jointSphere(pt, r));
        const merged = track(mergeGeometries(parts)!);
        parts.forEach((x) => x.dispose());
        g.add(new THREE.Mesh(merged, track(material(color))));

        // Senkrechte Lotlinien an den Stützpunkten (Bezug zur Oberfläche)
        const plumb: number[] = [];
        for (const pt of axis) plumb.push(pt.x, 0.03, pt.z, pt.x, pt.y + r, pt.z);
        const plumbGeo = track(new THREE.BufferGeometry());
        plumbGeo.setAttribute("position", new THREE.Float32BufferAttribute(plumb, 3));
        g.add(
          new THREE.LineSegments(plumbGeo, track(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }))),
        );
      }

      // Markierung an der Oberfläche (wie eine Sprühmarkierung)
      const markGeo = track(new THREE.BufferGeometry().setFromPoints(ground));
      const mark = new THREE.Line(
        markGeo,
        track(new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.25, transparent: true, opacity: 0.9 })),
      );
      mark.computeLineDistances();
      g.add(mark);
      labelPos = midpoint(ground);
    }

    // Beschriftung
    const label = makeLabel(describe(f), color);
    track(label.material.map!);
    track(label.material);
    label.position.set(labelPos.x, 1.35, labelPos.z);
    label.userData.isLabel = true;
    const stemGeo = track(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(labelPos.x, 0, labelPos.z), new THREE.Vector3(labelPos.x, 1.15, labelPos.z)]),
    );
    const stem = new THREE.Line(stemGeo, track(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })));
    stem.userData.isLabel = true;
    g.add(label, stem);
    labels.push(label, stem);

    g.traverse((o) => (o.userData.featureId = p.id));
    objects.set(p.id, g);
    root.add(g);
  }

  return {
    root,
    objects,
    labels,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
