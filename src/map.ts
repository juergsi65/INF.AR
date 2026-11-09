import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { describe } from "./scene";
import { MEDIA } from "./data";
import type { InfraFeature, LatLon } from "./types";

const BASEMAPS: Record<string, L.TileLayer> = {
  "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 22,
    maxNativeZoom: 19,
    attribution: "© OpenStreetMap-Mitwirkende",
  }),
  "Luftbild (Esri)": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 22, maxNativeZoom: 19, attribution: "Esri, Maxar, Earthstar Geographics" },
  ),
  "basemap.at Orthofoto": L.tileLayer(
    "https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg",
    { maxZoom: 22, maxNativeZoom: 19, attribution: "basemap.at" },
  ),
};

export class InfraMap {
  map: L.Map;
  private layer = L.layerGroup();
  private me = L.layerGroup();
  private meMarker?: L.CircleMarker;
  private accCircle?: L.Circle;
  private headingLine?: L.Polyline;
  private pickMode: ((p: LatLon) => void) | null = null;
  private fitted = false;

  constructor(el: HTMLElement, onSelect: (id: string) => void) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true }).setView([48.2082, 16.3738], 17);
    BASEMAPS["OpenStreetMap"].addTo(this.map);
    L.control.layers(BASEMAPS, {}, { position: "topright" }).addTo(this.map);
    this.layer.addTo(this.map);
    this.me.addTo(this.map);
    this.onSelect = onSelect;
    this.map.on("click", (e: L.LeafletMouseEvent) => {
      if (this.pickMode) {
        const cb = this.pickMode;
        this.setPickMode(null);
        cb({ lat: e.latlng.lat, lon: e.latlng.lng });
      }
    });
  }

  private onSelect: (id: string) => void;

  setPickMode(cb: ((p: LatLon) => void) | null) {
    this.pickMode = cb;
    this.map.getContainer().classList.toggle("picking", !!cb);
  }

  setFeatures(features: InfraFeature[], visible: (f: InfraFeature) => boolean) {
    this.layer.clearLayers();
    const bounds = L.latLngBounds([]);
    for (const f of features) {
      if (!visible(f)) continue;
      const color = MEDIA[f.properties.medium].color;
      const [title, info] = describe(f);
      let l: L.Layer;
      if (f.geometry.type === "Point") {
        const [lon, lat] = f.geometry.coordinates;
        l = L.circleMarker([lat, lon], { radius: 7, color: "#111", weight: 2, fillColor: color, fillOpacity: 1 });
        bounds.extend([lat, lon]);
      } else {
        const ll = f.geometry.coordinates.map(([lon, lat]) => L.latLng(lat, lon));
        const kind = f.properties.kind;
        l = L.polyline(ll, {
          color,
          weight: kind === "trasse" ? 10 : kind === "kabel" ? 3 : 5,
          opacity: kind === "trasse" ? 0.45 : 0.95,
          dashArray: kind === "kabel" ? "6 5" : undefined,
        });
        ll.forEach((p) => bounds.extend(p));
      }
      l.bindTooltip(`<b>${escapeHtml(title)}</b><br>${escapeHtml(info)}`, { sticky: true });
      l.on("click", (e) => {
        if (this.pickMode) return;
        L.DomEvent.stopPropagation(e);
        this.onSelect(f.properties.id);
      });
      l.addTo(this.layer);
    }
    if (!this.fitted && bounds.isValid()) {
      this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 20 });
      this.fitted = true;
    }
  }

  fitFeatures() {
    this.fitted = false;
  }

  setPosition(p: LatLon, accuracy: number, heading: number | null) {
    const ll = L.latLng(p.lat, p.lon);
    if (!this.meMarker) {
      this.accCircle = L.circle(ll, { radius: accuracy, color: "#4fc3f7", weight: 1, fillOpacity: 0.12 }).addTo(this.me);
      this.meMarker = L.circleMarker(ll, { radius: 7, color: "#fff", weight: 3, fillColor: "#0288d1", fillOpacity: 1 }).addTo(
        this.me,
      );
    }
    this.meMarker.setLatLng(ll);
    this.accCircle!.setLatLng(ll).setRadius(accuracy);
    if (heading !== null) {
      const d = 0.00012;
      const r = (heading * Math.PI) / 180;
      const tip = L.latLng(p.lat + d * Math.cos(r), p.lon + (d * Math.sin(r)) / Math.cos((p.lat * Math.PI) / 180));
      if (!this.headingLine) this.headingLine = L.polyline([ll, tip], { color: "#0288d1", weight: 3 }).addTo(this.me);
      else this.headingLine.setLatLngs([ll, tip]);
    }
  }

  centerOn(p: LatLon) {
    this.map.setView([p.lat, p.lon], Math.max(this.map.getZoom(), 19));
  }

  invalidate() {
    setTimeout(() => this.map.invalidateSize(), 50);
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
