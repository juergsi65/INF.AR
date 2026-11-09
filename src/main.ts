import "./styles.css";
import {
  KINDS,
  MEDIA,
  cloud,
  createDemoProject,
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
import { CRS_LIST, pointSegment, toEnu, wrap360 } from "./geo";
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
  projects = [createDemoProject(DEFAULT_CENTER)];
  saveLocalProjects(projects);
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
  const ue = viewer.user.e - viewer.calib.east;
  const un = viewer.user.n - viewer.calib.north;
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
  viewer.setContent(buildScene(project.features, origin));
  if (fit) map.fitFeatures();
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

function updateUser() {
  const pos = gps.fix ?? origin;
  const { e, n } = toEnu(origin, pos);
  viewer.user = { e, n };
  if (gps.fix) map.setPosition(gps.fix, gps.fix.accuracy, viewer.mode === "preview" ? null : viewer.heading());
}

function switchProject(id: string) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  project = p;
  setActiveId(p.id);
  selectedId = null;
  $("#info-card").hidden = true;
  rebuild(true);
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
  $("#hud-gps").textContent = manualPosition
    ? "Standort: manuell"
    : fix
      ? `GPS ±${fix.raw.accuracy.toFixed(1).replace(".", ",")} m`
      : gps.error
        ? `GPS: ${gps.error}`
        : "GPS: suche …";
  $("#hud-gps").className = `pill ${manualPosition || (fix && fix.raw.accuracy <= 5) ? "ok" : fix && fix.raw.accuracy <= 15 ? "warn" : "bad"}`;

  const h = viewer.heading();
  $("#hud-heading").textContent =
    h === null ? "Kompass: –" : `${dirName(h)} ${Math.round(h)}°${viewer.mode !== "preview" ? ` · ${orientation.source}` : ""}`;

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
  $("#btn-preview").hidden = !ar;
  $("#btn-realign").hidden = m !== "xr";
  $("#hud-mode").textContent = m === "preview" ? "3D-Vorschau" : m === "camera" ? "Kamera-AR" : "WebXR-AR";
  document.body.classList.toggle("ar", ar);
  if (ar) document.body.classList.add("sheet-hidden");
  else document.body.classList.remove("sheet-hidden");
  map.invalidate();
};

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

gps.onFix(() => {
  updateUser();
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
    if (!gps.fix && !manualPosition) toast("Warte auf GPS … alternativ Standort in der Karte setzen.");
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
$("#btn-preview").addEventListener("click", () => viewer.stopAR());
$("#btn-realign").addEventListener("click", () => {
  viewer.realign();
  toast("Neu ausgerichtet");
});
$("#btn-labels").addEventListener("click", (e) => {
  showLabels = !showLabels;
  (e.currentTarget as HTMLElement).classList.toggle("active", showLabels);
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
function renderCalib() {
  const c = viewer.calib;
  for (const input of $$<HTMLInputElement>("[data-calib]")) {
    const k = input.dataset.calib as keyof Calibration;
    input.value = String(c[k]);
    const out = $(`output[data-for=${k}]`);
    out.textContent = k === "heading" || k === "fov" ? `${c[k].toFixed(1).replace(".", ",")}°` : fmtM(c[k]);
  }
}
$$<HTMLInputElement>("[data-calib]").forEach((input) =>
  input.addEventListener("input", () => {
    viewer.calib[input.dataset.calib as keyof Calibration] = parseFloat(input.value);
    renderCalib();
    saveCalib();
  }),
);
$("#btn-calib").addEventListener("click", () => {
  $("#calib-card").hidden = !$("#calib-card").hidden;
  renderCalib();
});
$("#calib-close").addEventListener("click", () => ($("#calib-card").hidden = true));
$("#calib-reset").addEventListener("click", () => {
  viewer.calib = { ...DEFAULT_CALIBRATION, eye: viewer.calib.eye, fov: viewer.calib.fov };
  renderCalib();
  saveCalib();
});
$("#calib-snap").addEventListener("click", () => {
  const f = project.features.find((x) => x.properties.id === selectedId);
  if (!f) return toast("Zuerst ein Objekt antippen (z. B. einen Schacht), dann darauf stellen.");
  const { e, n } = distanceTo(f);
  viewer.calib.east = viewer.user.e - e;
  viewer.calib.north = viewer.user.n - n;
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
  const center = gps.fix ?? map.map.getCenter();
  const c = "lat" in center && "lon" in center ? center : { lat: center.lat, lon: (center as { lng: number }).lng };
  const demo = createDemoProject(c);
  demo.name = `Demo ${new Date().toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" })}`;
  projects.push(demo);
  saveLocalProjects(projects);
  switchProject(demo.id);
  toast(gps.fix ? "Demo-Netz um deinen Standort erzeugt." : "Kein GPS – Demo am Kartenmittelpunkt erzeugt.");
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
