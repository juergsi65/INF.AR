# InfraSight AR

Leitungsinfrastruktur – **Trassen, Rohre, Kabel und Schächte** – per Augmented Reality direkt vor Ort in der echten Welt sichtbar machen.
Läuft im Browser auf dem Smartphone (iOS & Android), ohne App-Store, gehostet auf **Cloudflare Workers**.

> ⚠️ Nur zur Orientierung. Die Darstellung ersetzt keine Leitungsauskunft und kein Suchschachten. Vor Grabarbeiten immer die Planauskunft der Netzbetreiber einholen.

## Funktionen

| Bereich | Was es kann |
|---|---|
| **AR-Modi** | 📷 **Kamera-AR** (Kamera + GPS + Kompass, iOS & Android) · 🥽 **WebXR** (Android/Chrome, stabile Raumverfolgung) · 3D-Vorschau am Desktop |
| **Darstellung** | Rohre & Kabel als 3D-Körper in echter Tiefe und Dimension, Trassen als Graben-Volumen, Schächte mit Deckel, Wand und Sohle, Lotlinien und „Sprühmarkierung“ an der Oberfläche, Beschriftungen |
| **Daten** | GeoJSON-Import (Point/LineString/Multi*/Polygon), automatische Erkennung von Sparte, Tiefe, DN, Material aus beliebigen Attributnamen (`sparte`, `tiefe`, `dn`, `durchmesser` …), Gefälle über `depths` je Stützpunkt, Export |
| **Koordinaten** | WGS84, **AT** MGI/GK M28/M31/M34 & Austria Lambert, **DE** UTM 32/33, DHDN GK4, **CH** LV95, Web Mercator – auch automatisch aus dem GeoJSON-`crs` |
| **Genauigkeit** | GPS-Glättung (Kalman), Kalibrierung (Drehung, Verschiebung, Höhe, Sichtfeld), „Gewähltes Objekt = hier“ zum Einpassen an einem Schachtdeckel, Standort manuell in der Karte setzen |
| **Vor Ort** | Anzeige der nächsten Leitung mit Abstand und Tiefe, Warnung unter 1 m, Antippen für Details, Filter nach Sparte und Objektart |
| **Karte** | OpenStreetMap, Esri-Luftbild, basemap.at-Orthofoto |
| **Cloud** | Optional: Projekte in Cloudflare KV speichern, geschützt per Token |

Farben nach Sparte: Strom 🔴 · Gas 🟡 · Wasser 🔵 · Abwasser 🟤 · Telekom/LWL 🟠 · Fernwärme 🟣 · Sonstige ⚪

## Schnellstart

```bash
npm install
npm run dev          # Vite-Dev-Server (http://localhost:5173)
npm test             # Unit-Tests
npm run preview      # Build + lokaler Worker inkl. API (http://localhost:8787)
```

Kamera und Sensoren funktionieren nur über **HTTPS** (oder `localhost`). Zum Testen am Handy also am besten direkt die Cloudflare-URL verwenden.

## Deployment auf Cloudflare

Die App ist ein Cloudflare **Worker mit statischen Assets** (`wrangler.jsonc`): `dist/` wird ausgeliefert, `/api/*` läuft über `worker/index.ts`.

### Variante A – Cloudflare Git-Integration (empfohlen, ohne Secrets in GitHub)

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Import a repository** → `juergsi65/INF.AR` wählen.
2. Build command: `npm run build` · Deploy command: `npx wrangler deploy` (Standard).
3. Speichern – jeder Push auf `main` wird automatisch deployed. Die App läuft dann unter `https://infrasight-ar.<dein-account>.workers.dev`.

### Variante B – GitHub Actions

Im Repo unter *Settings → Secrets and variables → Actions* anlegen:

- `CLOUDFLARE_API_TOKEN` (Vorlage „Edit Cloudflare Workers“)
- `CLOUDFLARE_ACCOUNT_ID`

Dann deployed `.github/workflows/deploy.yml` bei jedem Push auf `main`. Ohne Secrets laufen dort nur Tests und Build.
**Nur eine Variante nutzen**, sonst wird doppelt deployed.

### Manuell

```bash
npx wrangler login
npm run deploy
```

### Optional: Cloud-Speicher für Projekte

Leitungsdaten sind sensibel. Die API ist deshalb erst aktiv, wenn **beides** eingerichtet ist, und verlangt bei jedem Zugriff das Token:

```bash
npx wrangler kv namespace create PROJECTS
```

Die ausgegebene ID in `wrangler.jsonc` unter `kv_namespaces` eintragen (Block einkommentieren), dann:

```bash
npx wrangler secret put API_TOKEN
```

Danach in der App unter **Daten → Cloud** das Token eingeben.

## Datenformat

GeoJSON in beliebigem der unterstützten Koordinatensysteme. Beispiel: [`public/sample-netz.geojson`](public/sample-netz.geojson).

| Eigenschaft | Bedeutung | erkannte Alternativen |
|---|---|---|
| `kind` | `rohr` · `kabel` · `trasse` · `schacht` | `art`, `typ`, `type` |
| `medium` | `strom` · `gas` · `wasser` · `abwasser` · `telekom` · `fernwaerme` · `sonstige` | `sparte`, `netz`, `layer` |
| `depth` | Tiefe in m (Rohr/Kabel: Oberkante, Schacht: Sohle, Trasse: Grabensohle) | `tiefe`, `verlegetiefe`, `ueberdeckung` |
| `depths` | Tiefe je Stützpunkt (z. B. Kanalgefälle) | – |
| `diameter` | Durchmesser in mm | `dn`, `durchmesser`, `nennweite` |
| `width` | Trassenbreite in m | `breite` |
| `name`, `material`, `operator` | Beschriftung und Infos | `bezeichnung`, `werkstoff`, `betreiber` |

Punkte werden als Schacht dargestellt, Linien standardmäßig als Rohr.

## Vor Ort: so wird es genau

1. **GPS** braucht freie Sicht zum Himmel. Die Genauigkeit steht im HUD (grün ≤ 5 m).
2. Zu einem **bekannten Punkt** gehen (Schachtdeckel, Hydrant), das Objekt antippen und in der 🎯 Kalibrierung **„Gewähltes Objekt = hier“** drücken. Damit ist der GPS-Versatz weg.
3. Mit **Drehung** den Kompass-Fehler ausgleichen, bis die Linien mit sichtbaren Merkmalen (Deckel, Markierungen) übereinstimmen.
4. Bei WebXR nach größeren Bewegungen mit 🧭 neu ausrichten.

## Projektstruktur

```
src/
  main.ts       App, UI-Logik, HUD
  viewer.ts     three.js-Renderer, Modi (Vorschau / Kamera-AR / WebXR), Kalibrierung, Picking
  scene.ts      3D-Geometrie aus Leitungsdaten
  sensors.ts    GPS (Kalman) und Lage-/Kompasssensor (Android & iOS)
  geo.ts        Koordinatensysteme (proj4), lokales Ost/Nord-System
  data.ts       Import/Normalisierung, Demo-Netz, lokale & Cloud-Speicherung
  map.ts        Leaflet-Karte
worker/index.ts Cloudflare Worker (Assets + API mit KV)
test/           Vitest-Tests
```

## Ideen für danach

- Import von Shapefile/DXF/GML (z. B. über `shpjs`) und Planauskunfts-Schnittstellen
- Erfassen und Einmessen neuer Objekte direkt in AR
- RTK-GNSS-Empfänger per Web Bluetooth für Zentimeter-Genauigkeit
- Geländemodell (DGM) statt ebener Geländeoberkante
