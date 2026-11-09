import * as THREE from "three";
import { angleDiff, wrap360 } from "./geo";
import type { LatLon } from "./types";

// ---------------------------------------------------------------------------
// GPS mit Kalman-Filter (Lage + Höhe)
// ---------------------------------------------------------------------------

export interface GpsFix extends LatLon {
  accuracy: number;
  /** Gefilterte GPS-Höhe in m (falls vom Gerät geliefert). */
  altitude: number | null;
  altitudeAccuracy: number | null;
  raw: LatLon & { accuracy: number; altitude: number | null };
  time: number;
  manual: boolean;
}

export class GpsSensor {
  fix: GpsFix | null = null;
  error: string | null = null;
  private watchId: number | null = null;
  private variance = 0;
  private altVariance = 0;
  private listeners = new Set<(f: GpsFix) => void>();
  /** Annahme: max. Gehgeschwindigkeit in m/s (Prozessrauschen). */
  walkSpeed = 1.0;

  onFix(cb: (f: GpsFix) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get running() {
    return this.watchId !== null;
  }

  start() {
    if (this.watchId !== null) return;
    if (!("geolocation" in navigator)) {
      this.error = "Kein GPS verfügbar";
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.update(pos),
      (err) => {
        this.error = err.code === err.PERMISSION_DENIED ? "Standort verweigert" : err.message || "GPS-Fehler";
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  /** Setzt die Position manuell (z. B. per Klick in der Karte). */
  setManual(p: LatLon, accuracy = 0.5) {
    this.variance = accuracy * accuracy;
    const altitude = this.fix?.altitude ?? null;
    this.fix = {
      ...p,
      accuracy,
      altitude,
      altitudeAccuracy: this.fix?.altitudeAccuracy ?? null,
      raw: { ...p, accuracy, altitude },
      time: Date.now(),
      manual: true,
    };
    this.emit();
  }

  private update(pos: GeolocationPosition) {
    const { latitude: lat, longitude: lon, accuracy, altitude, altitudeAccuracy } = pos.coords;
    const acc = Math.max(accuracy, 1);
    const now = pos.timestamp || Date.now();
    this.error = null;
    const prev = this.fix;
    const dt = prev ? Math.max(0, (now - prev.time) / 1000) : 0;

    // Lage
    let fLat = lat;
    let fLon = lon;
    let fAcc = acc;
    if (prev && !prev.manual) {
      this.variance += dt * this.walkSpeed * this.walkSpeed;
      const k = this.variance / (this.variance + acc * acc);
      fLat = prev.lat + k * (lat - prev.lat);
      fLon = prev.lon + k * (lon - prev.lon);
      this.variance *= 1 - k;
      fAcc = Math.sqrt(this.variance);
    } else this.variance = acc * acc;

    // Höhe (vertikal deutlich ungenauer → eigener Filter, langsamer)
    let fAlt: number | null = null;
    let fAltAcc: number | null = null;
    if (altitude !== null && Number.isFinite(altitude)) {
      const aAcc = Math.max(altitudeAccuracy ?? acc * 1.5, 1.5);
      if (prev?.altitude != null) {
        this.altVariance += dt * 0.3 * 0.3;
        const k = this.altVariance / (this.altVariance + aAcc * aAcc);
        fAlt = prev.altitude + k * (altitude - prev.altitude);
        this.altVariance *= 1 - k;
      } else {
        fAlt = altitude;
        this.altVariance = aAcc * aAcc;
      }
      fAltAcc = Math.sqrt(this.altVariance);
    }

    this.fix = {
      lat: fLat,
      lon: fLon,
      accuracy: fAcc,
      altitude: fAlt,
      altitudeAccuracy: fAltAcc,
      raw: { lat, lon, accuracy: acc, altitude },
      time: now,
      manual: false,
    };
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l(this.fix!);
  }
}

// ---------------------------------------------------------------------------
// Lage- und Kompasssensor (Sensorfusion)
// ---------------------------------------------------------------------------

type IOSOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type PermissionCapable = { requestPermission?: () => Promise<"granted" | "denied"> };

const D = Math.PI / 180;
const zee = new THREE.Vector3(0, 0, 1);
const up = new THREE.Vector3(0, 1, 0);
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // Kamera blickt aus der Geräterückseite
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const tmpQ = new THREE.Quaternion();

/** Wandelt alpha/beta/gamma in eine Kamera-Quaternion (x = Ost, y = oben, z = −Nord). */
export function orientationToQuaternion(out: THREE.Quaternion, alpha: number, beta: number, gamma: number, screenAngle: number) {
  euler.set(beta * D, alpha * D, -gamma * D, "YXZ");
  out.setFromEuler(euler);
  out.multiply(q1);
  out.multiply(q0.setFromAxisAngle(zee, -screenAngle * D));
  return out;
}

/** Gierwinkel (Grad) einer (annähernd reinen) Drehung um die Hochachse. */
function yawOfRotation(q: THREE.Quaternion): number {
  return (2 * Math.atan2(q.y, q.w)) / D;
}

/**
 * Liefert die Kameralage im Weltsystem.
 *
 * Prinzip: Die schnelle, ruhige Lage kommt aus dem Kreisel (relatives `deviceorientation`),
 * die Nordrichtung wird nur langsam aus dem Kompass nachgeführt
 * (Android: `deviceorientationabsolute`, iOS: `webkitCompassHeading`).
 * So zittert das Bild nicht mit dem Magnetometer-Rauschen.
 */
export class OrientationSensor {
  source: "fusion" | "kompass" | "absolut" | "relativ" | "keine" = "keine";
  active = false;
  /** Nordkorrektur (Grad) zwischen Kreisel-Lage und Norden. */
  private northOffset: number | null = null;
  private qRel = new THREE.Quaternion();
  private relTime = 0;
  private hasRel = false;
  private target = new THREE.Quaternion();
  private smoothed = new THREE.Quaternion();
  private hasData = false;
  private lastSmooth = 0;
  /** Glättung der Nordkorrektur pro Kompass-Messung (0..1). */
  compassGain = 0.02;

  static supported() {
    return typeof window !== "undefined" && "DeviceOrientationEvent" in window;
  }

  /** Muss aus einer Benutzeraktion heraus aufgerufen werden (iOS-Berechtigung). */
  async start(): Promise<void> {
    if (this.active) return;
    const DOE = (window as unknown as { DeviceOrientationEvent?: PermissionCapable }).DeviceOrientationEvent;
    if (DOE?.requestPermission) {
      const res = await DOE.requestPermission();
      if (res !== "granted") throw new Error("Zugriff auf Bewegungssensoren verweigert");
    }
    if ("ondeviceorientationabsolute" in window) {
      window.addEventListener("deviceorientationabsolute", this.onAbsolute as EventListener, true);
    }
    window.addEventListener("deviceorientation", this.onRelative as EventListener, true);
    this.active = true;
  }

  stop() {
    window.removeEventListener("deviceorientationabsolute", this.onAbsolute as EventListener, true);
    window.removeEventListener("deviceorientation", this.onRelative as EventListener, true);
    this.active = false;
  }

  get ready() {
    return this.hasData;
  }

  /** Setzt die Kompass-Nachführung zurück (z. B. nach magnetischer Störung). */
  resetCompass() {
    this.northOffset = null;
  }

  private screenAngle() {
    return screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
  }

  private feedOffset(off: number) {
    if (this.northOffset === null) this.northOffset = wrap360(off);
    else this.northOffset = wrap360(this.northOffset + angleDiff(this.northOffset, off) * this.compassGain);
  }

  private onAbsolute = (e: DeviceOrientationEvent) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    const qAbs = orientationToQuaternion(new THREE.Quaternion(), e.alpha, e.beta, e.gamma, this.screenAngle());
    if (this.hasRel && performance.now() - this.relTime < 500) {
      // Weltdrehung zwischen Kreisel- und Kompass-System: qAbs = Yaw(off) · qRel
      tmpQ.copy(this.qRel).invert().premultiply(qAbs);
      this.feedOffset(yawOfRotation(tmpQ));
      this.source = "fusion";
    } else {
      // Nur absolute Werte verfügbar → direkt verwenden
      this.target.copy(qAbs);
      this.source = "absolut";
      this.markData();
    }
  };

  private onRelative = (e: IOSOrientationEvent) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    const q = orientationToQuaternion(new THREE.Quaternion(), e.alpha, e.beta, e.gamma, this.screenAngle());

    if (e.absolute && !("ondeviceorientationabsolute" in window)) {
      // Browser ohne getrenntes Absolut-Ereignis, aber mit absoluten Werten
      this.target.copy(q);
      this.source = "absolut";
      this.markData();
      return;
    }

    this.qRel.copy(q);
    this.relTime = performance.now();
    this.hasRel = true;

    if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) {
      // iOS: Kompasskurs gegen alpha (beide im Gerätesystem) → Nordkorrektur
      this.feedOffset(360 - e.webkitCompassHeading - e.alpha);
      this.source = "kompass";
    }

    if (this.northOffset !== null) {
      this.target.setFromAxisAngle(up, this.northOffset * D).multiply(this.qRel);
    } else {
      this.target.copy(this.qRel);
      if (this.source === "keine") this.source = "relativ";
    }
    this.markData();
  };

  private markData() {
    if (!this.hasData) this.smoothed.copy(this.target);
    this.hasData = true;
  }

  /** Geglättete Kameralage (zeitbasiert, sehr geringe Verzögerung). */
  getQuaternion(out: THREE.Quaternion, tau = 0.045): THREE.Quaternion {
    const now = performance.now();
    const dt = this.lastSmooth ? Math.min(0.2, (now - this.lastSmooth) / 1000) : 1;
    this.lastSmooth = now;
    this.smoothed.slerp(this.target, 1 - Math.exp(-dt / tau));
    return out.copy(this.smoothed);
  }

  /** Kompassrichtung der Blickrichtung (Grad, im Uhrzeigersinn ab Nord). */
  heading(): number {
    return headingOf(this.target);
  }

  /** true, solange noch keine Nordreferenz vorliegt (nur Kreisel). */
  get northUnknown() {
    return this.source === "relativ" || this.source === "keine";
  }
}

/** Blickrichtung einer Kamera-Quaternion als Kompasskurs. */
export function headingOf(q: THREE.Quaternion): number {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return wrap360((Math.atan2(f.x, -f.z) * 180) / Math.PI);
}

export function pitchOf(q: THREE.Quaternion): number {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return (Math.asin(Math.max(-1, Math.min(1, f.y))) * 180) / Math.PI;
}
