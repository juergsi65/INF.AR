import * as THREE from "three";
import { wrap360 } from "./geo";
import type { LatLon } from "./types";

// ---------------------------------------------------------------------------
// GPS mit einfachem Kalman-Filter
// ---------------------------------------------------------------------------

export interface GpsFix extends LatLon {
  accuracy: number;
  raw: LatLon & { accuracy: number };
  time: number;
}

export class GpsSensor {
  fix: GpsFix | null = null;
  error: string | null = null;
  private watchId: number | null = null;
  private variance = 0;
  private listeners = new Set<(f: GpsFix) => void>();
  /** Annahme: max. Gehgeschwindigkeit in m/s (Prozessrauschen). */
  walkSpeed = 1.2;

  onFix(cb: (f: GpsFix) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
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
        this.error = err.message || "GPS-Fehler";
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  /** Setzt die Position manuell (z. B. per Klick in der Karte oder auf einen bekannten Punkt). */
  setManual(p: LatLon, accuracy = 0.5) {
    this.variance = accuracy * accuracy;
    this.fix = { ...p, accuracy, raw: { ...p, accuracy }, time: Date.now() };
    this.emit();
  }

  private update(pos: GeolocationPosition) {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    const acc = Math.max(accuracy, 1);
    const now = pos.timestamp || Date.now();
    this.error = null;
    if (!this.fix) {
      this.variance = acc * acc;
      this.fix = { lat, lon, accuracy: acc, raw: { lat, lon, accuracy: acc }, time: now };
    } else {
      const dt = Math.max(0, (now - this.fix.time) / 1000);
      this.variance += dt * this.walkSpeed * this.walkSpeed;
      const k = this.variance / (this.variance + acc * acc);
      this.fix = {
        lat: this.fix.lat + k * (lat - this.fix.lat),
        lon: this.fix.lon + k * (lon - this.fix.lon),
        accuracy: Math.sqrt((1 - k) * this.variance),
        raw: { lat, lon, accuracy: acc },
        time: now,
      };
      this.variance = (1 - k) * this.variance;
    }
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l(this.fix!);
  }
}

// ---------------------------------------------------------------------------
// Lage- und Kompasssensor
// ---------------------------------------------------------------------------

type IOSOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type PermissionCapable = { requestPermission?: () => Promise<"granted" | "denied"> };

const zee = new THREE.Vector3(0, 0, 1);
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // Kamera blickt aus der Geräterückseite
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();

/**
 * Liefert die Gerätelage als Quaternion im Weltsystem (x = Ost, y = oben, z = −Nord).
 * Android/Chrome: `deviceorientationabsolute`; iOS: `webkitCompassHeading` als Nordreferenz.
 */
export class OrientationSensor {
  alpha = 0;
  beta = 90;
  gamma = 0;
  /** Korrektur zwischen relativem alpha und Nord (iOS). */
  private northOffset: number | null = null;
  source: "absolut" | "kompass" | "relativ" | "keine" = "keine";
  active = false;
  private target = new THREE.Quaternion();
  private smoothed = new THREE.Quaternion();
  private hasData = false;

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

  private onAbsolute = (e: DeviceOrientationEvent) => {
    if (e.alpha === null) return;
    this.source = "absolut";
    this.set(e.alpha, e.beta ?? 0, e.gamma ?? 0);
  };

  private onRelative = (e: IOSOrientationEvent) => {
    if (e.alpha === null) return;
    if (this.source === "absolut") return; // absolute Quelle hat Vorrang
    if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) {
      const off = wrap360(360 - e.webkitCompassHeading - e.alpha);
      // zirkulärer Tiefpass gegen Kompassrauschen
      if (this.northOffset === null) this.northOffset = off;
      else {
        const d = ((off - this.northOffset + 540) % 360) - 180;
        this.northOffset = wrap360(this.northOffset + d * 0.05);
      }
      this.source = "kompass";
      this.set(e.alpha + this.northOffset, e.beta ?? 0, e.gamma ?? 0);
    } else {
      this.source = e.absolute ? "absolut" : "relativ";
      this.set(e.alpha, e.beta ?? 0, e.gamma ?? 0);
    }
  };

  private set(alpha: number, beta: number, gamma: number) {
    this.alpha = alpha;
    this.beta = beta;
    this.gamma = gamma;
    const D = Math.PI / 180;
    const orient = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) * D;
    euler.set(beta * D, alpha * D, -gamma * D, "YXZ");
    this.target.setFromEuler(euler);
    this.target.multiply(q1);
    this.target.multiply(q0.setFromAxisAngle(zee, -orient));
    if (!this.hasData) this.smoothed.copy(this.target);
    this.hasData = true;
  }

  /** Geglättete Kameralage; `headingOffsetDeg` dreht die Welt um die Hochachse (Kalibrierung). */
  getQuaternion(out: THREE.Quaternion, headingOffsetDeg = 0, smoothing = 0.25): THREE.Quaternion {
    this.smoothed.slerp(this.target, smoothing);
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-headingOffsetDeg * Math.PI) / 180);
    return out.copy(yaw).multiply(this.smoothed);
  }

  /** Kompassrichtung der Blickrichtung (Grad, im Uhrzeigersinn ab Nord). */
  heading(): number {
    return headingOf(this.target);
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
