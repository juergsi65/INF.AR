import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BuiltScene } from "./scene";
import { headingOf, type OrientationSensor } from "./sensors";

export type Mode = "preview" | "camera" | "xr";

export interface Calibration {
  /** Drehung der Daten um den Standort (Grad, im Uhrzeigersinn). */
  heading: number;
  /** Verschiebung der Daten nach Ost/Nord (Meter). */
  east: number;
  north: number;
  /** Höhenkorrektur der Geländeoberkante (Meter). */
  height: number;
  /** Augenhöhe / Geräte-Höhe über Gelände im Kamera-Modus (Meter). */
  eye: number;
  /** Sichtfeld der Kamera über die lange Bildseite (Grad). */
  fov: number;
}

export const DEFAULT_CALIBRATION: Calibration = { heading: 0, east: 0, north: 0, height: 0, eye: 1.5, fov: 68 };

const D = Math.PI / 180;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
  /** Dreh-/Ankerpunkt = Standort des Nutzers. */
  readonly anchor = new THREE.Group();
  /** Enthält die Leitungsdaten, verschoben um −Standort. */
  readonly content = new THREE.Group();
  readonly grid: THREE.GridHelper;
  private groundPlane: THREE.Mesh;
  private userMarker: THREE.Group;
  private controls: OrbitControls;
  private built: BuiltScene | null = null;
  private video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private raycaster = new THREE.Raycaster();
  private xrNeedsAlign = false;
  private xrSession: XRSession | null = null;

  mode: Mode = "preview";
  calib: Calibration = { ...DEFAULT_CALIBRATION };
  /** Standort in Projekt-ENU-Metern. */
  user = { e: 0, n: 0 };
  showGrid = false;

  onSelect: (id: string | null) => void = () => {};
  onFrame: () => void = () => {};
  onModeChange: (m: Mode) => void = () => {};

  constructor(
    private container: HTMLElement,
    private orientation: OrientationSensor,
    private xrOverlay: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = "viewer-canvas";

    this.video = document.createElement("video");
    this.video.className = "camera-feed";
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    container.append(this.video, this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(20, 40, 10);
    this.scene.add(sun);

    this.grid = new THREE.GridHelper(100, 100, 0x80deea, 0x4dd0e1);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.18;
    this.grid.position.y = 0.005;

    this.groundPlane = new THREE.Mesh(
      new THREE.CircleGeometry(60, 64),
      new THREE.MeshBasicMaterial({ color: 0x6d7f5a, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.groundPlane.rotation.x = -Math.PI / 2;

    this.userMarker = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.6, 16), new THREE.MeshBasicMaterial({ color: 0x29b6f6 }));
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(0, 0.3, -0.1);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.6, 16), new THREE.MeshBasicMaterial({ color: 0x0288d1, transparent: true, opacity: 0.6 }));
    body.position.y = 0.8;
    this.userMarker.add(body, cone);

    this.anchor.add(this.content);
    this.scene.add(this.anchor, this.grid, this.groundPlane, this.userMarker);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, -1, 0);
    this.camera.position.set(-14, 16, 22);
    this.controls.maxPolarAngle = Math.PI * 0.95;
    this.controls.update();

    this.renderer.domElement.addEventListener("click", (e) => this.pick(e));
    new ResizeObserver(() => this.resize()).observe(container);
    window.addEventListener("orientationchange", () => setTimeout(() => this.resize(), 300));
    this.resize();
    this.renderer.setAnimationLoop((t, frame) => this.render(t, frame));
  }

  setContent(built: BuiltScene) {
    if (this.built) {
      this.content.remove(this.built.root);
      this.built.dispose();
    }
    this.built = built;
    this.content.add(built.root);
  }

  setVisibility(fn: (id: string, medium: string, kind: string) => boolean, labels: boolean) {
    if (!this.built) return;
    for (const [id, obj] of this.built.objects) obj.visible = fn(id, obj.userData.medium, obj.userData.kind);
    for (const l of this.built.labels) l.visible = labels;
  }

  highlight(id: string | null) {
    if (!this.built) return;
    for (const [fid, obj] of this.built.objects) {
      obj.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && "emissiveIntensity" in m) m.emissiveIntensity = fid === id ? 2.6 : 1;
      });
    }
  }

  // -------------------------------------------------------------------------
  // Modi
  // -------------------------------------------------------------------------

  async startCamera() {
    await this.orientation.start();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Kamera nicht verfügbar (HTTPS erforderlich)");
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.setMode("camera");
  }

  static async xrSupported(): Promise<boolean> {
    try {
      return !!(await navigator.xr?.isSessionSupported("immersive-ar"));
    } catch {
      return false;
    }
  }

  async startXR() {
    await this.orientation.start().catch(() => {});
    const session = await navigator.xr!.requestSession("immersive-ar", {
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: this.xrOverlay },
    } as XRSessionInit);
    this.renderer.xr.setReferenceSpaceType("local-floor");
    await this.renderer.xr.setSession(session);
    this.xrSession = session;
    this.xrNeedsAlign = true;
    const controller = this.renderer.xr.getController(0);
    controller.addEventListener("select", () => {
      this.raycaster.setFromXRController(controller);
      this.onSelect(this.hitTest());
    });
    this.scene.add(controller);
    session.addEventListener("end", () => {
      this.scene.remove(controller);
      this.xrSession = null;
      this.setMode("preview");
    });
    this.setMode("xr");
  }

  /** Richtet die XR-Welt beim nächsten Frame neu an GPS + Kompass aus. */
  realign() {
    this.xrNeedsAlign = true;
  }

  stopAR() {
    if (this.xrSession) void this.xrSession.end();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.setMode("preview");
  }

  private setMode(m: Mode) {
    this.mode = m;
    this.container.dataset.mode = m;
    const preview = m === "preview";
    this.controls.enabled = preview;
    this.groundPlane.visible = preview;
    this.userMarker.visible = preview;
    if (m !== "xr") {
      this.anchor.position.set(0, 0, 0);
    }
    this.resize();
    this.onModeChange(m);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    if (!this.renderer.xr.isPresenting) this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = this.mode === "camera" ? this.cameraFov(w, h) : 55;
    this.camera.updateProjectionMatrix();
  }

  /** Vertikales Sichtfeld, das zum (per object-fit: cover beschnittenen) Kamerabild passt. */
  private cameraFov(cw: number, ch: number): number {
    const vw = this.video.videoWidth || 1920;
    const vh = this.video.videoHeight || 1080;
    // Mobilgeräte liefern im Hochformat oft ein quer orientiertes Bild – Seiten an Bildschirm anpassen.
    const [w, h] = (cw < ch) === (vw < vh) ? [vw, vh] : [vh, vw];
    const focal = Math.max(w, h) / 2 / Math.tan((this.calib.fov * D) / 2);
    const s = Math.max(cw / w, ch / h);
    return (2 * Math.atan(ch / 2 / (focal * s))) / D;
  }

  private applyContentTransform() {
    const c = this.calib;
    this.content.position.set(-(this.user.e) + c.east, c.height, this.user.n - c.north);
    this.userMarker.position.set(0, c.height, 0);
  }

  private render(_t: number, frame?: XRFrame) {
    this.applyContentTransform();
    this.grid.visible = this.mode === "preview" || this.showGrid;

    if (this.mode === "camera") {
      if (this.video.videoWidth && Math.abs(this.camera.fov - this.cameraFov(this.container.clientWidth, this.container.clientHeight)) > 0.1) {
        this.resize();
      }
      this.camera.position.set(0, this.calib.eye, 0);
      if (this.orientation.ready) this.orientation.getQuaternion(this.camera.quaternion);
      this.anchor.rotation.y = -this.calib.heading * D;
    } else if (this.mode === "xr") {
      this.anchor.rotation.y = (this.xrYaw - this.calib.heading) * D;
    } else if (this.mode === "preview") {
      this.anchor.rotation.y = -this.calib.heading * D;
      this.controls.update();
    }

    this.onFrame();
    this.renderer.render(this.scene, this.camera);

    // Die XR-Kamerapose ist erst nach render() aktuell → Ausrichtung gilt ab dem nächsten Frame.
    if (this.mode === "xr" && frame && this.xrNeedsAlign) {
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      this.renderer.xr.getCamera().matrixWorld.decompose(pos, quat, new THREE.Vector3());
      const compass = this.orientation.ready ? this.orientation.heading() : 0;
      this.xrYaw = compass - headingOf(quat);
      this.anchor.position.set(pos.x, 0, pos.z);
      this.xrNeedsAlign = false;
    }
  }

  private xrYaw = 0;

  /** Aktuelle Blickrichtung (Kompass) laut Sensoren. */
  heading(): number | null {
    if (this.mode === "preview") return headingOf(this.camera.quaternion);
    return this.orientation.ready ? this.orientation.heading() : null;
  }

  // -------------------------------------------------------------------------
  // Auswahl
  // -------------------------------------------------------------------------

  private pick(e: MouseEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.onSelect(this.hitTest());
  }

  private hitTest(): string | null {
    if (!this.built) return null;
    this.raycaster.params.Line = { threshold: 0.15 };
    const hits = this.raycaster.intersectObject(this.built.root, true).filter((h) => {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (!o.visible) return false;
        o = o.parent;
      }
      return true;
    });
    return (hits[0]?.object.userData.featureId as string | undefined) ?? null;
  }
}
