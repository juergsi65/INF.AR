import "./styles.css";
import {
  DEMO_ID,
  KINDS,
  MEDIA,
  cloud,
  createDemoProject,
  isDemoProject,
  projectCenter,
  getActiveId,
  getToken,
  importGeoJson,
  loadLocalProjects,
  saveLocalProjects,
  setActiveId,
  setToken,
  toGeoJson,
  uid,
} from "./data";
import { CRS_LIST, distance, pointSegment, toEnu, wrap360 } from "./geo";
import { ensureElevations, fetchElevations, interpolateElevation, referenceElevation } from "./terrain";
import { InfraMap, escapeHtml } from "./map";
import { buildScene, describe, fmtM } from "./scene";
import { GpsSensor, OrientationSensor } from "./sensors";
import type { InfraFeature, InfraProject, Kind, LatLon, Medium } from "./types";
import { DEFAULT_CALIBRATION, Viewer, type Calibration } from "./viewer";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll(sel)) as T[];

const DEFAULT_CENTER: LatLon = { lat: 48.20849, lon: 16.37208 }; // Wien, Stephansplatz
const LS_CALIB = "infrasight.calib.v1";

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

let projects = loadLocalProjects();
let project: InfraProject;
let origin: LatLon = DEFAULT_CENTER;
let selectedId: string | null = null;
let manualPosition = false;
let showLabels = true;
/** Standort in AR festhalten (GPS-Updates verschieben die Daten nicht mehr). */
let positionLocked = false;
type HeightMode = "dgm" | "gps" | "flat";
let heightMode: HeightMode = (localStorage.getItem("infrasight.heightMode") as HeightMode) || "dgm";
/** Bezugshöhe des Projekts (m ü. A.) – null, wenn keine Geländehöhen bekannt. */
let refElev: number | null = null;
/** Geländehöhe am Standort laut Geländemodell. */
let userGroundDgm: number | null = null;
let userGroundDgmPos: LatLon | null = null;
/** GPS-Höhenbezug: GPS-Höhe ↔ Geländehöhe zum Zeitpunkt der Festlegung (gleicht Geoid & Offset aus). */
let gpsHeightRef: { alt: number; ground: number } | null = null;
let elevationJob: AbortController | null = null;
let demoPending = false;
const hiddenMedia = new Set<Medium>();
const hiddenKinds = new Set<Kind>();
/** Vorberechnete Koordinaten (Projekt-ENU) für Abstandsberechnungen. */
let enuCache = new Map<string, Array<{ e: number; n: number }>>();

const gps = new GpsSensor();
const orientation = new OrientationSensor();
const viewer = new Viewer($("#viewport"), orientation, $("#xr-overlay"));
const map = new InfraMap($("#map"), (id) => select(id, true));

try {
  viewer.calib = { ...DEFAULT_CALIBRATION, ...JSON.parse(localStorage.getItem(LS_CALIB) || "{}") };
} catch {
  /* Standardwerte */
}

if (!projects.length) {
  // Erststart: Demo-Netz wird erzeugt, sobald der echte Standort bekannt ist.
  projects = [{ id: DEMO_ID, name: "Demo-Netz (Standort)", demo: true, updatedAt: new Date().toISOString(), features: [] }];
  saveLocalProjects(projects);
  demoPending = true;
}
project = projects.find((p) => p.id === getActiveId()) ?? projects[0];

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function toast(msg: string, ms = 3200) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => (el.hidden = true), ms);
}

function isVisible(f: InfraFeature) {
  return !hiddenMedia.has(f.properties.medium) && !hiddenKinds.has(f.properties.kind);
}

function computeOrigin(features: InfraFeature[]): LatLon {
  let lat = 0;
  let lon = 0;
  let n = 0;
  for (const f of features) {
    const pts = f.geometry.type === "Point" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const c of pts) {
      lon += c[0];
      lat += c[1];
      n++;
    }
  }
  return n ? { lat: lat / n, lon: lon / n } : (gps.fix ?? DEFAULT_CENTER);
}

function persist() {
  project.updatedAt = new Date().toISOString();
  const i = projects.findIndex((p) => p.id === project.id);
  if (i >= 0) projects[i] = project;
  else projects.push(project);
  try {
    saveLocalProjects(projects);
  } catch {
    toast("⚠️ Lokaler Speicher voll – Projekt bitte exportieren oder in die Cloud laden.");
  }
}

function saveCalib() {
  localStorage.setItem(LS_CALIB, JSON.stringify(viewer.calib));
}

/** Abstand Standort → Objekt (horizontal), berücksichtigt die Kalibrier-Verschiebung. */
function distanceTo(f: InfraFeature): { d: number; depth: number; e: number; n: number } {
  const pts = enuCache.get(f.properties.id)!;
  const ue = viewer.userTarget.e - viewer.calib.east;
  const un = viewer.userTarget.n - viewer.calib.north;
  const p = f.properties;
  if (pts.length === 1) {
    const r = Math.max(p.diameter, 300) / 2000;
    return { d: Math.max(0, Math.hypot(pts[0].e - ue, pts[0].n - un) - r), depth: p.depth, ...pts[0] };
  }
  let best = { d: Infinity, depth: p.depth, e: 0, n: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const { d, t } = pointSegment(ue, un, a.e, a.n, b.e, b.n);
    if (d < best.d) {
      const da = p.depths?.[i - 1] ?? p.depth;
      const db = p.depths?.[i] ?? p.depth;
      best = { d, depth: da + (db - da) * t, e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t };
    }
  }
  if (p.kind === "trasse") best.d = Math.max(0, best.d - (p.width ?? 1) / 2);
  return best;
}

// ---------------------------------------------------------------------------
// Projekt / Szene aufbauen
// ---------------------------------------------------------------------------

function rebuild(fit = false) {
  origin = computeOrigin(project.features);
  enuCache = new Map(
    project.features.map((f) => {
      const pts = f.geometry.type === "Point" ? [f.geometry.coordinates] : f.geometry.coordinates;
      return [f.properties.id, pts.map(([lon, lat]) => toEnu(origin, { lat, lon }))];
    }),
  );
  refElev = referenceElevation(project.features);
  viewer.setContent(buildScene(project.features, origin, heightMode === "flat" ? null : refElev));
  if (fit) map.fitFeatures();
  void loadElevations();
  updateUser();
  applyFilters();
  renderProjectSelect();
  renderFilters();
  if (selectedId && !project.features.some((f) => f.properties.id === selectedId)) select(null);
}

function applyFilters() {
  const byId = new Map(project.features.map((f) => [f.properties.id, f]));
  viewer.setVisibility((id) => isVisible(byId.get(id)!), showLabels);
  map.setFeatures(project.features, isVisible);
  renderFeatureList();
}

function updateUser(snap = false) {
  const pos = gps.fix ?? origin;
  if (!positionLocked) {
    const { e, n } = toEnu(origin, pos);
    viewer.setUser(e, n, snap || !gps.fix || gps.fix.manual);
  }
  if (gps.fix) map.setPosition(gps.fix, gps.fix.accuracy, viewer.mode === "preview" ? null : viewer.heading());
  updateGround();
}

// ---------------------------------------------------------------------------
// Höhe: Geländemodell + optional GPS-Höhe
// ---------------------------------------------------------------------------

/** Lädt fehlende Geländehöhen für alle Objekte (einmalig, wird im Projekt gespeichert). */
async function loadElevations() {
  if (heightMode === "flat" || !project.features.length) return;
  elevationJob?.abort();
  const job = (elevationJob = new AbortController());
  const p = project;
  try {
    if (await ensureElevations(p.features, job.signal)) {
      if (p !== project) return;
      persist();
      rebuild();
    }
  } catch {
    /* offline → eben weiterarbeiten */
  }
}

/** Geländehöhe am Standort (Geländemodell, Fallback: Interpolation aus den Objekthöhen). */
async function refreshUserGround(pos: LatLon) {
  if (userGroundDgmPos && distance(userGroundDgmPos, pos) < 8) return;
  userGroundDgmPos = pos;
  try {
    const [v] = await fetchElevations([pos]);
    if (v !== null) userGroundDgm = v;
  } catch {
    userGroundDgm = interpolateElevation(project.features, pos);
  }
  updateGround();
}

function updateGround() {
  const info = $("#height-info");
  const pos = gps.fix ?? null;
  if (heightMode === "flat" || refElev === null) {
    viewer.terrainOffsetTarget = 0;
    $("#hud-height").textContent = heightMode === "flat" ? "Höhe: eben" : "Höhe: lade Gelände …";
    info.textContent =
      heightMode === "flat"
        ? "Gelände wird als eben angenommen. Die Daten liegen relativ zur Gerätehöhe."
        : "Geländehöhen werden geladen (Internet nötig). Bis dahin wird eben gerechnet.";
    return;
  }
  if (pos && !positionLocked) void refreshUserGround(pos);
  let ground = userGroundDgm ?? (pos ? interpolateElevation(project.features, pos) : null) ?? refElev;
  let label = `Gelände ${ground.toFixed(1).replace(".", ",")} m`;

  if (heightMode === "gps" && pos?.altitude != null) {
    // GPS-Höhe nur relativ verwenden: beim ersten Wert an das Geländemodell koppeln,
    // danach folgen Höhenänderungen dem GPS (z. B. Rampen, Brücken, Böschungen).
    gpsHeightRef ??= { alt: pos.altitude, ground };
    ground = gpsHeightRef.ground + (pos.altitude - gpsHeightRef.alt);
    label = `GPS-Höhe ${ground.toFixed(1).replace(".", ",")} m ±${(pos.altitudeAccuracy ?? 0).toFixed(0)}`;
    info.textContent = "GPS-Höhe wird relativ zum Geländemodell genutzt. GPS ist vertikal ungenau (±3–10 m) – bei Unruhe „Geländemodell“ wählen.";
  } else if (heightMode === "gps") {
    info.textContent = "Dieses Gerät liefert keine GPS-Höhe – es wird das Geländemodell verwendet.";
  } else {
    info.textContent = "Straßen-/Geländehöhe aus dem Copernicus-Geländemodell: Gefälle zwischen dir und den Leitungen wird berücksichtigt. Feinkorrektur mit „Gelände-Höhe“.";
  }
  if (viewer.mode === "xr") label += viewer.xrGround !== null ? " · Boden erkannt" : " · suche Boden …";
  $("#hud-height").textContent = label;
  viewer.terrainOffsetTarget = refElev - ground;
}

// ---------------------------------------------------------------------------
// Demo-Netz immer am echten Standort
// ---------------------------------------------------------------------------

function placeDemo(at: LatLon, announce = true) {
  const demo = createDemoProject(at);
  projects = [...projects.filter((p) => !isDemoProject(p)), demo];
  saveLocalProjects(projects);
  demoPending = false;
  switchProject(demo.id);
  if (announce) toast("Demo-Netz an deinem Standort erzeugt.");
}

/** Verschiebt das aktive Demo-Netz an den Standort, wenn es zu weit weg liegt. */
function keepDemoNearby() {
  const fix = gps.fix;
  if (!fix) return;
  if (demoPending) return placeDemo(fix);
  if (!isDemoProject(project)) return;
  const c = projectCenter(project);
  if (!c || distance(c, fix) > 150) {
    placeDemo(fix, false);
    toast("Demo-Netz an deinen Standort verschoben.");
  }
}

function switchProject(id: string) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  project = p;
  setActiveId(p.id);
  selectedId = null;
  gpsHeightRef = null;
  $("#info-card").hidden = true;
  rebuild(true);
  updateUser(true);
}

// ---------------------------------------------------------------------------
// UI-Rendering
// ---------------------------------------------------------------------------

function renderProjectSelect() {
  const sel = $<HTMLSelectElement>("#project-select");
  sel.innerHTML = projects
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${p.features.length})</option>`)
    .join("");
  sel.value = project.id;
}

function renderFilters() {
  const count = (pred: (f: InfraFeature) => boolean) => project.features.filter(pred).length;
  $("#filter-media").innerHTML = (Object.keys(MEDIA) as Medium[])
    .map((m) => {
      const n = count((f) => f.properties.medium === m);
      return n
        ? `<button class="chip ${hiddenMedia.has(m) ? "" : "on"}" data-medium="${m}"><i style="background:${MEDIA[m].color}"></i>${MEDIA[m].label} <small>${n}</small></button>`
        : "";
    })
    .join("");
  $("#filter-kinds").innerHTML = (Object.keys(KINDS) as Kind[])
    .map((k) => {
      const n = count((f) => f.properties.kind === k);
      return n
        ? `<button class="chip ${hiddenKinds.has(k) ? "" : "on"}" data-kind="${k}">${KINDS[k].label} <small>${n}</small></button>`
        : "";
    })
    .join("");
}

function renderFeatureList() {
  const list = project.features
    .map((f) => ({ f, ...distanceTo(f) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 300);
  $("#feature-count").textContent = `(${project.features.length})`;
  $("#feature-list").innerHTML = list
    .map(({ f, d }) => {
      const [title, info] = describe(f);
      return `<li data-id="${escapeHtml(f.properties.id)}" class="${f.properties.id === selectedId ? "sel" : ""} ${isVisible(f) ? "" : "off"}">
        <i style="background:${MEDIA[f.properties.medium].color}"></i>
        <span><b>${escapeHtml(title)}</b><small>${escapeHtml(info)}</small></span>
        <em>${d < 1000 ? fmtM(d) : (d / 1000).toFixed(1).replace(".", ",") + " km"}</em></li>`;
    })
    .join("");
}

function renderLegend() {
  $("#legend").innerHTML = (Object.keys(MEDIA) as Medium[])
    .map((m) => `<span><i style="background:${MEDIA[m].color}"></i>${MEDIA[m].label}</span>`)
    .join("");
}

function select(id: string | null, center = false) {
  selectedId = id;
  viewer.highlight(id);
  const card = $("#info-card");
  const f = project.features.find((x) => x.properties.id === id);
  if (!f) {
    card.hidden = true;
    renderFeatureList();
    return;
  }
  const p = f.properties;
  const { d, depth } = distanceTo(f);
  const skip = new Set(["id", "kind", "medium", "name", "depth", "depths", "diameter", "width"]);
  const rows: Array<[string, string]> = [
    ["Art", KINDS[p.kind].label],
    ["Sparte", MEDIA[p.medium].label],
    [p.kind === "schacht" ? "Sohltiefe" : "Tiefe hier", fmtM(depth)],
  ];
  if (p.depths?.length) rows.push(["Tiefe Verlauf", p.depths.map((x) => x.toFixed(2).replace(".", ",")).join(" → ") + " m"]);
  if (p.kind === "trasse") rows.push(["Breite", fmtM(p.width ?? 1)]);
  else if (p.diameter) rows.push(["Durchmesser", `${p.diameter} mm`]);
  rows.push(["Abstand", fmtM(d)]);
  for (const [k, v] of Object.entries(p)) {
    if (skip.has(k) || v === undefined || v === null || typeof v === "object") continue;
    rows.push([k.charAt(0).toUpperCase() + k.slice(1), String(v)]);
  }
  card.innerHTML = `<div class="card-head"><b><i class="dot" style="background:${MEDIA[p.medium].color}"></i>${escapeHtml(
    p.name || describe(f)[0],
  )}</b><button class="link" data-close>✕</button></div>
  <table>${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("")}</table>`;
  card.hidden = false;
  if (center) {
    const pts = f.geometry.type === "Point" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const mid = pts[Math.floor(pts.length / 2)];
    map.centerOn({ lon: mid[0], lat: mid[1] });
  }
  renderFeatureList();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

let lastHud = 0;
let lastList = 0;
viewer.onFrame = () => {
  const now = performance.now();
  if (now - lastHud < 250) return;
  lastHud = now;

  const fix = gps.fix;
  $("#hud-gps").textContent = positionLocked
    ? "📌 Position gehalten"
    : manualPosition
    ? "Standort: manuell"
    : fix
      ? `GPS ±${fix.raw.accuracy.toFixed(1).replace(".", ",")} m`
      : gps.error
        ? `GPS: ${gps.error}`
        : "GPS: suche …";
  $("#hud-gps").className = `pill ${positionLocked || manualPosition || (fix && fix.raw.accuracy <= 5) ? "ok" : fix && fix.raw.accuracy <= 15 ? "warn" : "bad"}`;

  const h = viewer.heading();
  $("#hud-heading").textContent =
    h === null
      ? "Kompass: –"
      : `${dirName(h)} ${Math.round(h)}°${viewer.mode !== "preview" ? ` · ${orientation.northUnknown ? "kein Nord!" : orientation.source}` : ""}`;
  if (viewer.mode === "xr") updateGround();

  let best: { f: InfraFeature; d: number; depth: number } | null = null;
  for (const f of project.features) {
    if (!isVisible(f)) continue;
    const r = distanceTo(f);
    if (!best || r.d < best.d) best = { f, d: r.d, depth: r.depth };
  }
  const near = $("#hud-nearest");
  if (best && best.d < 50) {
    const [title] = describe(best.f);
    near.hidden = false;
    near.className = `nearest ${best.d < 1 ? "alert" : ""}`;
    near.innerHTML = `<i style="background:${MEDIA[best.f.properties.medium].color}"></i>
      <span><b>${escapeHtml(title)}</b> · ${fmtM(best.d)} entfernt · Tiefe ${fmtM(best.depth)}</span>`;
  } else near.hidden = true;

  if (now - lastList > 3000 && !$("[data-panel=layers]").hidden) {
    lastList = now;
    renderFeatureList();
  }
};

function dirName(h: number) {
  return ["N", "NO", "O", "SO", "S", "SW", "W", "NW"][Math.round(wrap360(h) / 45) % 8];
}

viewer.onSelect = (id) => select(id);
viewer.onModeChange = (m) => {
  const ar = m !== "preview";
  $("#btn-camera").hidden = ar;
  $("#btn-xr").hidden = ar || !xrOk;
  $("#btn-realign").hidden = m !== "xr";
  $("#ar-map").hidden = m === "xr"; // Karte liegt außerhalb des WebXR-Overlays
  $("#hud-mode").textContent = m === "preview" ? "3D-Vorschau" : m === "camera" ? "Kamera-AR" : "WebXR-AR";
  document.body.classList.toggle("ar", ar);
  document.body.classList.toggle("sheet-hidden", ar);
  if (!ar && positionLocked) setLock(false);
  $("#calib-card").hidden = true;
  updateGround();
  map.invalidate();
};

function setLock(on: boolean) {
  positionLocked = on;
  $("#ar-lock").classList.toggle("active", on);
  if (!on) updateUser();
  toast(on ? "Position gehalten – Daten bleiben fix, ideal zum Umsehen und Justieren." : "Position folgt wieder dem GPS.");
}

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

let firstFix = true;
gps.onFix(() => {
  updateUser(firstFix);
  firstFix = false;
  keepDemoNearby();
});
gps.start();

let xrOk = false;
Viewer.xrSupported().then((ok) => {
  xrOk = ok;
  $("#btn-xr").hidden = !ok || viewer.mode !== "preview";
});

$("#btn-camera").addEventListener("click", async () => {
  try {
    await viewer.startCamera();
    if (viewer.sensorWarning) {
      toast(`⚠️ ${viewer.sensorWarning}. Bitte in den Browser-Einstellungen „Bewegungssensoren“ erlauben und AR neu starten.`, 8000);
    } else if (!gps.fix && !manualPosition) toast("Warte auf GPS … alternativ Standort in der Karte setzen.");
    setTimeout(() => {
      if (viewer.mode === "camera" && !orientation.ready && !viewer.sensorWarning) {
        toast("⚠️ Keine Lagesensor-Daten – Gerät unterstützt evtl. keine Bewegungssensoren im Browser.", 7000);
      }
    }, 2500);
  } catch (e) {
    toast(`AR nicht möglich: ${(e as Error).message}`, 6000);
  }
});
$("#btn-xr").addEventListener("click", async () => {
  try {
    await viewer.startXR();
    toast("Gerät kurz ruhig halten – Ausrichtung per Kompass. Mit 🧭 neu ausrichten.", 5000);
  } catch (e) {
    toast(`WebXR nicht möglich: ${(e as Error).message}`, 6000);
  }
});
$("#ar-exit").addEventListener("click", () => viewer.stopAR());
$("#ar-lock").addEventListener("click", () => setLock(!positionLocked));
$("#ar-calib").addEventListener("click", () => {
  $("#calib-card").hidden = !$("#calib-card").hidden;
  renderCalib();
});
$("#ar-labels").addEventListener("click", () => $("#btn-labels").click());
$("#ar-map").addEventListener("click", () => {
  document.body.classList.toggle("sheet-hidden");
  map.invalidate();
});
$("#btn-realign").addEventListener("click", () => {
  viewer.realign();
  toast("Neu ausgerichtet");
});
$("#btn-labels").addEventListener("click", () => {
  showLabels = !showLabels;
  $("#btn-labels").classList.toggle("active", showLabels);
  $("#ar-labels").classList.toggle("active", showLabels);
  applyFilters();
});
$("#btn-grid").addEventListener("click", (e) => {
  viewer.showGrid = !viewer.showGrid;
  (e.currentTarget as HTMLElement).classList.toggle("active", viewer.showGrid);
});
$("#btn-sheet").addEventListener("click", () => {
  document.body.classList.toggle("sheet-hidden");
  map.invalidate();
});

// Tabs
$$(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".tab").forEach((t) => (t.hidden = t.dataset.panel !== b.dataset.tab));
    if (b.dataset.tab === "map") map.invalidate();
    if (b.dataset.tab === "layers") renderFeatureList();
    if (b.dataset.tab === "data") checkCloud();
  }),
);

// Projekt
$<HTMLSelectElement>("#project-select").addEventListener("change", (e) =>
  switchProject((e.target as HTMLSelectElement).value),
);
$("#btn-new").addEventListener("click", () => {
  const name = prompt("Name des neuen Projekts:", "Neues Projekt");
  if (!name) return;
  project = { id: uid("p"), name, updatedAt: new Date().toISOString(), features: [] };
  persist();
  switchProject(project.id);
});
$("#btn-rename").addEventListener("click", () => {
  const name = prompt("Neuer Projektname:", project.name);
  if (!name) return;
  project.name = name;
  persist();
  renderProjectSelect();
});
$("#btn-delete").addEventListener("click", () => {
  if (!confirm(`Projekt „${project.name}“ lokal löschen?`)) return;
  projects = projects.filter((p) => p.id !== project.id);
  if (!projects.length) projects.push({ id: uid("p"), name: "Neues Projekt", updatedAt: new Date().toISOString(), features: [] });
  saveLocalProjects(projects);
  switchProject(projects[0].id);
});

// Filter & Liste
$("#filter-media").addEventListener("click", (e) => {
  const m = (e.target as HTMLElement).closest<HTMLElement>("[data-medium]")?.dataset.medium as Medium | undefined;
  if (!m) return;
  if (hiddenMedia.has(m)) hiddenMedia.delete(m);
  else hiddenMedia.add(m);
  renderFilters();
  applyFilters();
});
$("#filter-kinds").addEventListener("click", (e) => {
  const k = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]")?.dataset.kind as Kind | undefined;
  if (!k) return;
  if (hiddenKinds.has(k)) hiddenKinds.delete(k);
  else hiddenKinds.add(k);
  renderFilters();
  applyFilters();
});
$("#feature-list").addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-id]")?.dataset.id;
  if (id) select(id, true);
});
$("#info-card").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("[data-close]")) select(null);
});

// Karte & Standort
$("#btn-pick").addEventListener("click", () => {
  toast("Tippe in der Karte auf deinen exakten Standort.");
  map.setPickMode((p) => {
    manualPosition = true;
    gps.stop();
    gps.setManual(p);
    $("#btn-gps").classList.remove("active");
    toast("Standort gesetzt.");
  });
});
$("#btn-gps").addEventListener("click", () => {
  manualPosition = false;
  gps.start();
  $("#btn-gps").classList.add("active");
  toast("GPS aktiv.");
});
$("#btn-center").addEventListener("click", () => map.centerOn(gps.fix ?? origin));

// Kalibrierung
const CALIB_ROWS: Array<{ key: keyof Calibration; label: string; min: number; max: number; step: number; unit: "°" | "m" }> = [
  { key: "heading", label: "Drehung", min: -180, max: 180, step: 0.5, unit: "°" },
  { key: "east", label: "Ost ↔ West", min: -20, max: 20, step: 0.05, unit: "m" },
  { key: "north", label: "Nord ↕ Süd", min: -20, max: 20, step: 0.05, unit: "m" },
  { key: "height", label: "Gelände-Höhe", min: -5, max: 5, step: 0.05, unit: "m" },
  { key: "eye", label: "Gerätehöhe über Boden", min: 0.3, max: 2.5, step: 0.05, unit: "m" },
  { key: "fov", label: "Kamera-Sichtfeld", min: 40, max: 110, step: 0.5, unit: "°" },
];
const NUDGE: Record<string, number> = { heading: 1, east: 0.1, north: 0.1, height: 0.1, eye: 0.05, fov: 1 };

$("#calib-rows").innerHTML = CALIB_ROWS.map(
  (r) => `<div class="calib-row" data-row="${r.key}">
    <div class="calib-label"><span>${r.label}</span><output data-for="${r.key}"></output></div>
    <div class="calib-ctl">
      <button data-nudge="-1" aria-label="weniger">−</button>
      <input type="range" data-calib="${r.key}" min="${r.min}" max="${r.max}" step="${r.step}" />
      <button data-nudge="1" aria-label="mehr">＋</button>
    </div></div>`,
).join("");

function setCalib(k: keyof Calibration, v: number) {
  const r = CALIB_ROWS.find((x) => x.key === k)!;
  viewer.calib[k] = Math.min(r.max, Math.max(r.min, Math.round(v / r.step) * r.step));
  renderCalib();
  saveCalib();
}

function renderCalib() {
  const c = viewer.calib;
  for (const r of CALIB_ROWS) {
    $<HTMLInputElement>(`input[data-calib=${r.key}]`).value = String(c[r.key]);
    $(`output[data-for=${r.key}]`).textContent =
      r.unit === "°" ? `${c[r.key].toFixed(1).replace(".", ",")}°` : fmtM(c[r.key]);
  }
  $<HTMLSelectElement>("#height-mode").value = heightMode;
}
$$<HTMLInputElement>("[data-calib]").forEach((input) =>
  input.addEventListener("input", () => setCalib(input.dataset.calib as keyof Calibration, parseFloat(input.value))),
);
// −/＋ Tasten, gedrückt halten wiederholt
$$<HTMLButtonElement>("[data-nudge]").forEach((b) => {
  const k = b.closest<HTMLElement>("[data-row]")!.dataset.row as keyof Calibration;
  const step = () => setCalib(k, viewer.calib[k] + Number(b.dataset.nudge) * NUDGE[k]);
  let timer = 0;
  const stop = () => clearInterval(timer);
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    step();
    stop();
    timer = window.setInterval(step, 140);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => b.addEventListener(ev, stop));
});
$<HTMLSelectElement>("#height-mode").addEventListener("change", (e) => {
  heightMode = (e.target as HTMLSelectElement).value as HeightMode;
  localStorage.setItem("infrasight.heightMode", heightMode);
  gpsHeightRef = null;
  rebuild();
});
$("#height-reset").addEventListener("click", () => {
  gpsHeightRef = null;
  userGroundDgmPos = null;
  viewer.xrGround = null;
  updateGround();
  toast("Höhe wird neu bestimmt.");
});
$("#calib-compass").addEventListener("click", () => {
  orientation.resetCompass();
  toast("Kompass neu – Gerät einmal in einer liegenden 8 bewegen.");
});
$("#btn-calib").addEventListener("click", () => {
  $("#calib-card").hidden = !$("#calib-card").hidden;
  renderCalib();
});
$("#calib-close").addEventListener("click", () => ($("#calib-card").hidden = true));
$("#calib-reset").addEventListener("click", () => {
  viewer.calib = { ...DEFAULT_CALIBRATION, eye: viewer.calib.eye, fov: viewer.calib.fov };
  renderCalib();
  saveCalib();
  toast("Drehung, Verschiebung und Höhe zurückgesetzt.");
});
$("#calib-snap").addEventListener("click", () => {
  const f = project.features.find((x) => x.properties.id === selectedId);
  if (!f) return toast("Zuerst ein Objekt antippen (z. B. einen Schacht), dann darauf stellen.");
  const { e, n } = distanceTo(f);
  viewer.calib.east = viewer.userTarget.e - e;
  viewer.calib.north = viewer.userTarget.n - n;
  renderCalib();
  saveCalib();
  toast("Daten am gewählten Objekt ausgerichtet.");
});

// Import / Export
const crsSel = $<HTMLSelectElement>("#crs-select");
crsSel.innerHTML =
  `<option value="">Automatisch (aus Datei / WGS84)</option>` +
  CRS_LIST.map((c) => `<option value="${c.code}">${escapeHtml(c.label)} – ${c.code}</option>`).join("");

$<HTMLInputElement>("#file-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const res = importGeoJson(json, crsSel.value || undefined);
    if (!res.features.length) throw new Error("Keine verwertbaren Punkte/Linien gefunden");
    const append = $<HTMLInputElement>("#import-append").checked;
    project.features = append ? [...project.features, ...res.features] : res.features;
    persist();
    rebuild(true);
    toast(`${res.features.length} Objekte importiert (${res.crs})${res.skipped ? `, ${res.skipped} übersprungen` : ""}.`, 5000);
  } catch (err) {
    toast(`Import fehlgeschlagen: ${(err as Error).message}`, 7000);
  }
});

$("#btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(toGeoJson(project), null, 2)], { type: "application/geo+json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${project.name.replace(/[^\w.-]+/g, "_")}.geojson`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("#btn-demo").addEventListener("click", () => {
  if (gps.fix) return placeDemo(gps.fix);
  demoPending = true;
  gps.start();
  toast("Warte auf deinen Standort … (oder „Standort in Karte setzen“).", 6000);
});

// Cloud
const tokenInput = $<HTMLInputElement>("#token-input");
tokenInput.value = getToken();
tokenInput.addEventListener("change", () => {
  setToken(tokenInput.value);
  checkCloud();
});

async function checkCloud() {
  const el = $("#cloud-status");
  try {
    const h = await cloud.health();
    el.textContent = !h.storage
      ? "Cloud-Speicher nicht eingerichtet (KV-Namespace fehlt) – Daten bleiben lokal im Browser."
      : !h.auth
        ? "Cloud-Speicher vorhanden, aber kein API_TOKEN gesetzt – aus Sicherheitsgründen deaktiviert."
        : "Cloud-Speicher bereit. Token eingeben, um Projekte zu laden/speichern.";
  } catch {
    el.textContent = "Keine Verbindung zur API (lokaler Entwicklungsmodus?). Daten bleiben lokal im Browser.";
  }
}

$("#btn-cloud-save").addEventListener("click", async () => {
  try {
    await cloud.put(project);
    toast("Projekt in der Cloud gespeichert.");
  } catch (e) {
    toast(`Upload fehlgeschlagen: ${(e as Error).message}`, 6000);
  }
});
$("#btn-cloud-list").addEventListener("click", async () => {
  try {
    const { projects: list } = await cloud.list();
    $("#cloud-list").innerHTML = list.length
      ? list
          .map(
            (p) => `<li data-cloud="${escapeHtml(p.id)}"><i style="background:#4fc3f7"></i>
            <span><b>${escapeHtml(p.name)}</b><small>${p.count} Objekte · ${new Date(p.updatedAt).toLocaleString("de-AT")}</small></span><em>laden</em></li>`,
          )
          .join("")
      : "<li><span>Keine Projekte in der Cloud.</span></li>";
  } catch (e) {
    toast(`Laden fehlgeschlagen: ${(e as Error).message}`, 6000);
  }
});
$("#cloud-list").addEventListener("click", async (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-cloud]")?.dataset.cloud;
  if (!id) return;
  try {
    const p = await cloud.get(id);
    projects = [...projects.filter((x) => x.id !== p.id), p];
    saveLocalProjects(projects);
    switchProject(p.id);
    toast(`„${p.name}“ geladen.`);
  } catch (err) {
    toast(`Laden fehlgeschlagen: ${(err as Error).message}`, 6000);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

renderLegend();
renderCalib();
rebuild(true);
if (!window.isSecureContext) toast("⚠️ Kamera und Sensoren benötigen HTTPS.", 6000);
