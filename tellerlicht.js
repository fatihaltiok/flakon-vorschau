// web/tellerlicht.js — Echtzeit-Licht auf dem Tuch (Vertrag §6.9, §6.10), nur WebGPU.
// Ein Rechenshader verfolgt je Bild ein Raster von Strahlen vom Spotlicht (Ort wie szene/flakon.py Licht_Haupt) durch
// den Flakon: Außenhaut (Tabelle Radius über Winkel und Höhe, aus dem Glasnetz), Glaswand (Abstandsfeld der Höhlung
// wie in glas.js), Flüssigkeit (dieselbe Fläche wie oberflaecheY, Absorption mit den LuxCore-Werten), wieder Glas und
// hinaus. Jeder Strahl legt zwei Lichtflecken auf das Tuch: wo er ohne Flakon gelandet wäre (das ergibt den
// Schatten) und wo er nach den Brechungen landet (das gebündelte, gefärbte Licht). Beide Treffpunkte sind der erste
// Schnitt mit dem Höhenfeld des gefalteten Tuchs (Marsch durch dasselbe Höhenfeld, das gezeichnet wird). Die Flecken
// sind Gauß-Glocken, deren Form aus den Nachbarstrahlen kommt (dicht gebündelt = klein und hell, zerstreut = groß
// und schwach; auf einer Faltenflanke gestaucht oder gestreckt), sie werden in eine Lichttextur über (x, z)
// aufsummiert und über wenige Bilder gemittelt. Beim Abfragen kommen der Einfallswinkel zur Tuchnormale und der
// Schatten der Falten selbst dazu. Alles in Flaschenkoordinaten: das Tuch kippt und dreht mit dem Flakon, das Licht
// steht in der Welt fest.
import * as THREE from 'three';
import { Break, Fn, If, Loop, atan, float, instanceIndex, instancedArray, int, max, min, mix, positionGeometry,
  select, smoothstep, step, texture, texture3D, uniform, uv, varying, vec2, vec3, vec4 } from 'three/tsl';
import { ABSORPTION, ETIKETT, SDF_N, SDF_S, SDF_U, VERSCHLUSS } from './glas.js';

// Hauptlicht (szene/flakon.py: Ort (0,15, 0,42, 0,38) Blender = (0,15, 0,38, −0,42) Web, zielt auf (0, 0,006, 0),
// Kegel 0,42 rad, Blend 0,70, Scheibe 12 mm)
export const LICHT_ORT = new THREE.Vector3(0.15, 0.38, -0.42);
const LICHT_ZIEL = new THREE.Vector3(0, 0.006, 0);
const LICHT_ABSTAND = LICHT_ORT.distanceTo(LICHT_ZIEL);
// Kegel des Spots wie in LuxCore (Blender: Öffnung 0,42 rad, Blend 0,70): voll bis 3,6° zur Kegelachse, null ab 12,0°,
// dazwischen ((cos − cos_außen) / (cos_innen − cos_außen)) hoch 2,9 — der Exponent ist an den LuxCore-Lichtbildern
// des Tuchs gemessen (zwei Stellen bei 6,7° und 7,4°). Auf dem kleinen Teller (T3k) genügte eine am Bild abgelesene,
// engere Näherung (2,5° bis 8,8°); auf dem Tuch ist der ganze Kegel mit seinem weichen Auslauf zu sehen.
const KEGEL_COS_INNEN = Math.cos(0.21 * 0.30), KEGEL_COS_AUSSEN = Math.cos(0.21), KEGEL_HOCH = 2.9;
// Heller Kern des Spots wie in den LuxCore-Tellerbildern (szene/export_web_aussehen.py: zweiter Kegel vom selben Ort,
// 0,15 rad, Blend 0,35, dreifache Stärke, zielt auf (0, 0,04, 0)): er trifft nur den Flakon und verstärkt allein
// das Licht, das durch Glas und Flüssigkeit geht — im Bild ist neben dem Schatten nichts davon zu sehen. Wirksame
// Winkel wie beim Hauptkegel am Bild verkleinert: voll bis 2,2°, null ab 3,3°.
const KERN_ZIEL = new THREE.Vector3(0, 0.040, 0), KERN_INNEN = 2.2 * Math.PI / 180, KERN_AUSSEN = 3.3 * Math.PI / 180, KERN_FAKTOR = 3;
const GLAS_H = 0.12;
// Die Lichttextur deckt dieses Quadrat um die Flaschenachse (Lichtkegel und Schatten auf dem Tuch)
export const LICHT_BREITE = 0.40;
const TREFFER_SCHRITTE = 24, FALTEN_SCHRITTE = 8;
const TAB_W = 512, TAB_H = 256;
const K1 = Math.PI / 0.05, K2 = 2 * Math.PI / 0.05;   // Wellen wie glas.js / schwappen.js
const IOR_GLAS = 1.5, IOR_FLUESSIG = 1.36;

/** Außenhaut als Tabelle: je Winkel (atan2(x, z)) und Höhe der Radius und die geglättete Netz-Normale in
 *  Zylinderkomponenten (radial, tangential, senkrecht). Strahl von der Achse nach außen gegen jedes Dreieck,
 *  der fernste Treffer zählt (die Innenhöhlung liegt näher an der Achse). */
export function baueAussenhaut(geo) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, idx = geo.index;
  const R = new Float32Array(TAB_W * TAB_H), Nn = new Float32Array(TAB_W * TAB_H * 3);
  const dTh = 2 * Math.PI / TAB_W, dY = GLAS_H / TAB_H;
  const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const Nv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const th = [0, 0, 0];
  const dreiecke = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < dreiecke; t++) {
    let achse = false;
    for (let k = 0; k < 3; k++) {
      const i = idx ? idx.getX(t * 3 + k) : t * 3 + k;
      P[k].fromBufferAttribute(pos, i);
      Nv[k].fromBufferAttribute(nor, i);
      if (Math.hypot(P[k].x, P[k].z) < 1e-5) achse = true;
      th[k] = Math.atan2(P[k].x, P[k].z);
    }
    if (achse) continue;
    // Winkel um den ersten Eckpunkt entfalten (Naht bei ±π)
    for (let k = 1; k < 3; k++) th[k] = th[0] + ((th[k] - th[0] + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const thMin = Math.min(th[0], th[1], th[2]), thMax = Math.max(th[0], th[1], th[2]);
    const yMin = Math.min(P[0].y, P[1].y, P[2].y), yMax = Math.max(P[0].y, P[1].y, P[2].y);
    if (thMax - thMin > 1.5 || yMax - yMin < 1e-7) continue;
    const j0 = Math.ceil((thMin + Math.PI) / dTh - 0.5), j1 = Math.floor((thMax + Math.PI) / dTh - 0.5);
    const i0 = Math.max(0, Math.ceil(yMin / dY - 0.5)), i1 = Math.min(TAB_H - 1, Math.floor(yMax / dY - 0.5));
    const e1x = P[1].x - P[0].x, e1y = P[1].y - P[0].y, e1z = P[1].z - P[0].z;
    const e2x = P[2].x - P[0].x, e2y = P[2].y - P[0].y, e2z = P[2].z - P[0].z;
    for (let j = j0; j <= j1; j++) {
      const w = (j + 0.5) * dTh - Math.PI, dx = Math.sin(w), dz = Math.cos(w);
      // Möller–Trumbore mit Ursprung (0, y, 0), Richtung (dx, 0, dz)
      const px = -dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      for (let i = i0; i <= i1; i++) {
        const y = (i + 0.5) * dY;
        const tx = -P[0].x, ty = y - P[0].y, tz = -P[0].z;
        const u = (tx * px + ty * py + tz * pz) / det;
        if (u < -1e-6 || u > 1 + 1e-6) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dz * qz) / det;
        if (v < -1e-6 || u + v > 1 + 1e-6) continue;
        const s = (e2x * qx + e2y * qy + e2z * qz) / det;
        const z = ((j % TAB_W) + TAB_W) % TAB_W + TAB_W * i;
        if (s > R[z]) {
          R[z] = s;
          const a = 1 - u - v;
          const nx = a * Nv[0].x + u * Nv[1].x + v * Nv[2].x, ny = a * Nv[0].y + u * Nv[1].y + v * Nv[2].y,
            nz = a * Nv[0].z + u * Nv[1].z + v * Nv[2].z;
          const l = Math.hypot(nx, ny, nz) || 1;
          Nn[z * 3] = (nx * dx + nz * dz) / l;
          Nn[z * 3 + 1] = (nx * dz - nz * dx) / l;
          Nn[z * 3 + 2] = ny / l;
        }
      }
    }
  }
  // Lücken (Strahl genau auf einer Kante) aus dem Nachbarn füllen
  for (let i = 0; i < TAB_H; i++) for (let j = 0; j < TAB_W; j++) {
    const z = j + TAB_W * i;
    if (R[z] > 0) continue;
    for (const q of [z - 1, z + 1, z - TAB_W, z + TAB_W]) {
      if (q >= 0 && q < R.length && R[q] > 0) { R[z] = R[q]; Nn.copyWithin(z * 3, q * 3, q * 3 + 3); break; }
    }
  }
  const daten = new Uint16Array(TAB_W * TAB_H * 4), h = THREE.DataUtils.toHalfFloat;
  for (let z = 0; z < TAB_W * TAB_H; z++) {
    daten[z * 4] = h(R[z]); daten[z * 4 + 1] = h(Nn[z * 3]); daten[z * 4 + 2] = h(Nn[z * 3 + 1]); daten[z * 4 + 3] = h(Nn[z * 3 + 2]);
  }
  const tex = new THREE.DataTexture(daten, TAB_W, TAB_H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Lage des Hauptlichts in Flaschenkoordinaten (das Licht steht in der Welt fest, Flakon und Tuch drehen und kippen).
 *  Gilt für das Echtzeit-Licht und für den Ersatz mit Bildern. */
export class Lichtlage {
  constructor() {
    this.uL = uniform(new THREE.Vector3().copy(LICHT_ORT));   // Lichtort (Flasche)
    this.uAchse = uniform(new THREE.Vector3());    // Kegelachse des Spots (Flasche, vom Licht weg)
    this.uKern = uniform(new THREE.Vector3());     // Achse des hellen Kerns
    this.uD0 = uniform(0.54);                      // Abstand Licht – Rastermitte (Bezug der Helligkeit)
    this.uStark = uniform(1);                      // 0, wenn das Licht das Tuch nur noch streift (stark gekippt)
    this.mitte = new THREE.Vector3(0, 0.0725, 0);
    this.cos = 1;
    this.aktualisiere(new THREE.Matrix3());
  }

  /** RT: Welt → Flasche (glas.uRT) */
  aktualisiere(RT) {
    const L = this.uL.value.copy(LICHT_ORT).applyMatrix3(RT);
    this.uAchse.value.copy(LICHT_ZIEL).sub(LICHT_ORT).normalize().applyMatrix3(RT);
    this.uKern.value.copy(KERN_ZIEL).sub(LICHT_ORT).normalize().applyMatrix3(RT);
    this.uD0.value = this.mitte.distanceTo(L);
    this.cos = (L.y - this.mitte.y) / this.uD0.value;
    this.uStark.value = THREE.MathUtils.smoothstep(this.cos, 0.08, 0.22);
  }

  /** Stärke des Lichts in einer Richtung (vom Licht weg), bezogen auf die Kegelmitte */
  kegelAn(r) {
    return r.dot(this.uAchse).sub(KEGEL_COS_AUSSEN).div(KEGEL_COS_INNEN - KEGEL_COS_AUSSEN).clamp(0, 1).pow(KEGEL_HOCH);
  }
}

export class EchtzeitLicht {
  /** glas: Glas-Objekt aus glas.js (Abstandsfeld und die Uniforms der Flüssigkeit), glasGeo: Netz der Außenhaut,
   *  tuch: Höhenfeld des Tuchs (hoeheAn(x, z) in Metern, uHmax größte Höhe), lage: Lichtlage,
   *  raster: Strahlen je Kante (256 am Rechner, 128 am Handy). */
  constructor(renderer, glas, glasGeo, tuch, lage, raster = 256, pixel = 512) {
    const LICHT_PIXEL = this.pixel = pixel;       // Kantenlänge der Lichttextur
    this.renderer = renderer;
    this.aktiv = true;
    const tab = baueAussenhaut(glasGeo);
    this.tabelle = tab;
    const sdfTex = glas.sdfTex;

    // ---------- Uniforms ----------
    this.lage = lage;
    this.uL = lage.uL;
    this.uAchse = lage.uAchse;
    this.uKern = lage.uKern;
    this.uD0 = lage.uD0;
    this.uZ = uniform(new THREE.Vector3(0, 0.0725, 0));
    this.uU = uniform(new THREE.Vector3());        // halbe Rasterbreite (Vektor)
    this.uV = uniform(new THREE.Vector3());        // halbe Rasterhöhe (Vektor)
    this.uZelle = uniform(0);                      // Fläche einer Rasterzelle senkrecht zum Licht (m²)
    this.uStark = lage.uStark;
    this.uMisch = uniform(0.5);                    // Anteil des neuen Bildes in der zeitlichen Mittelung
    // Eichung an den LuxCore-Tellerbildern T3k (Werte wie das entzerrte Bild, vor uGain der Unterlage)
    this.uDirekt = uniform(0.50);                  // direktes Licht bei senkrechtem Einfall in der Kegelmitte
    this.uKaustik = uniform(0.8);                  // Licht durch Glas und Flüssigkeit
    this.uGrund = uniform(0.004);                  // Licht der Softboxen (im Schatten sichtbar)
    this.uSaettigung = uniform(1.0);
    this.uFleck = uniform(0.8);                    // Breite der Lichtflecken in Strahlabständen
    this.uEps = uniform(0.8 * LICHT_BREITE / pixel);   // kleinste Fleckbreite (m): knapp ein Bildpunkt der Lichttextur
    // Gesamthelligkeit des Lichts (seit T3k am LuxCore-Standbild ausgerichtet); die Helligkeit des Tuchs selbst
    // stellt tuch.js ein
    this.uHell = uniform(2.8);
    const kegelAn = r => lage.kegelAn(r);
    const kernAn = r => smoothstep(KERN_AUSSEN, KERN_INNEN, r.dot(this.uKern).clamp(-1, 1).acos()).mul(KERN_FAKTOR).add(1);
    const uNf = glas.uNf, uD = glas.uD, uA = glas.uA, uFl = glas.uFluessig, uEt = glas.uEtikett, uSchlieren = glas.uSchlieren;

    // ---------- Felder ----------
    const koord = p => vec3(
      p.x.sub(SDF_U[0]).div(SDF_S).add(0.5).div(SDF_N[0]),
      p.y.sub(SDF_U[1]).div(SDF_S).add(0.5).div(SDF_N[1]),
      p.z.sub(SDF_U[2]).div(SDF_S).add(0.5).div(SDF_N[2]));
    const sdf = p => texture3D(sdfTex, koord(p)).level(0).x;
    const H = 0.0012;
    const grad = p => {
      const n = vec3(
        sdf(p.add(vec3(H, 0, 0))).sub(sdf(p.sub(vec3(H, 0, 0)))),
        sdf(p.add(vec3(0, H, 0))).sub(sdf(p.sub(vec3(0, H, 0)))),
        sdf(p.add(vec3(0, 0, H))).sub(sdf(p.sub(vec3(0, 0, H)))));
      const w1 = p.y.mul(620).add(p.x.mul(240).sin().mul(2.5)).sin();
      const w2 = p.x.mul(530).add(p.z.mul(470)).add(p.y.mul(90).sin().mul(2)).sin();
      const w3 = p.z.mul(610).sub(p.x.mul(380)).add(p.y.mul(150)).sin();
      return n.normalize().add(vec3(w2, w1, w3).mul(uSchlieren)).normalize();
    };
    const wellen = (px, pz) => {
      const x = px.clamp(-0.025, 0.025), z = pz.clamp(-0.025, 0.025);
      return uA.x.mul(x.mul(K1).sin()).add(uA.y.mul(z.mul(K1).sin()))
        .add(uA.z.mul(x.mul(K2).cos())).add(uA.w.mul(z.mul(K2).cos()));
    };
    const f = p => uNf.dot(p).sub(uD).sub(wellen(p.x, p.z));   // < 0: in der Flüssigkeit
    const oberflaechenNormale = s => {
      const e = 0.0008;
      const dx = wellen(s.x.add(e), s.z).sub(wellen(s.x.sub(e), s.z)).div(2 * e);
      const dz = wellen(s.x, s.z.add(e)).sub(wellen(s.x, s.z.sub(e))).div(2 * e);
      return uNf.sub(vec3(dx, 0, dz)).normalize();
    };
    const tabAn = p => texture(tab, vec2(atan(p.x, p.z).div(2 * Math.PI).add(0.5), p.y.div(GLAS_H))).level(0);
    // Abstand zur Außenhaut (außen positiv), erste Näherung aus der Tabelle; Boden y = 0, Oberkante y = 0,12
    const aussen = p => {
      const t = tabAn(p);
      return max(max(p.xz.length().sub(t.x).mul(t.y.clamp(0.25, 1)), p.y.negate()), p.y.sub(GLAS_H));
    };
    const aussenNormale = p => {
      const t = tabAn(p);
      const r = p.xz.length().max(1e-6);
      const er = vec3(p.x.div(r), 0, p.z.div(r)), et = vec3(p.z.div(r), 0, p.x.div(r).negate());
      const n = er.mul(t.y).add(et.mul(t.z)).add(vec3(0, t.w, 0)).normalize();
      const boden = p.y.lessThan(0.0004).and(r.lessThan(t.x.sub(0.0004)));
      return select(boden, vec3(0, -1, 0), n);
    };
    const imEtikett = p => uEt.greaterThan(0.5).and(atan(p.x, p.z).abs().lessThan(ETIKETT.halb))
      .and(p.y.greaterThan(ETIKETT.y0)).and(p.y.lessThan(ETIKETT.y1)).and(p.xz.length().greaterThan(0.031));
    // Brechung mit Fresnel (unpolarisiert, exakt). n zeigt dem Strahl entgegen, eta = n_von / n_nach.
    const brechen = (d, n, eta) => {
      const ci = d.dot(n).negate().clamp(0, 1).toVar();
      const s2 = float(eta).mul(eta).mul(float(1).sub(ci.mul(ci))).toVar();
      const tir = s2.greaterThan(0.9999).toVar();
      const ct = float(1).sub(s2).max(0).sqrt().toVar();
      const T = d.mul(eta).add(n.mul(float(eta).mul(ci).sub(ct))).normalize().toVar();
      const rs = float(eta).mul(ci).sub(ct).div(float(eta).mul(ci).add(ct).max(1e-6));
      const rp = ci.sub(float(eta).mul(ct)).div(ci.add(float(eta).mul(ct)).max(1e-6));
      const F = select(tir, 1.0, rs.mul(rs).add(rp.mul(rp)).mul(0.5)).toVar();
      const R = d.reflect(n).toVar();
      return { T, F, tir, R };
    };

    // Erster Treffer eines abwärts laufenden Strahls auf dem Tuch: bis zur Oberkante der Falten springen, dann in
    // gleichen Schritten bis zur Bodenebene, den Übergang durch Halbieren eingrenzen. Flaches Tuch: Schnitt mit y = 0.
    const tuchTreffer = (start, d) => {
      const ab = d.y.min(-1e-4).negate();
      const t0 = start.y.sub(tuch.uHmax).max(0).div(ab);
      const dt = start.y.max(0).div(ab).sub(t0).div(TREFFER_SCHRITTE).toVar();
      const t = float(t0).toVar(), vor = float(t0).toVar();
      Loop(TREFFER_SCHRITTE, () => {
        t.addAssign(dt);
        const q = start.add(d.mul(t)).toVar();
        If(q.y.lessThanEqual(tuch.hoeheAn(q.x, q.z)), () => { Break(); });
        vor.assign(t);
      });
      Loop(5, () => {
        const m = vor.add(t).mul(0.5).toVar();
        const q = start.add(d.mul(m)).toVar();
        If(q.y.lessThanEqual(tuch.hoeheAn(q.x, q.z)), () => { t.assign(m); }).Else(() => { vor.assign(m); });
      });
      return { ort: start.add(d.mul(t)), weg: t };
    };
    const aufKarte = q => max(q.x.abs(), q.z.abs()).lessThan(LICHT_BREITE / 2 - 0.001);

    // ---------- Lichttextur: Rohbild und zwei Ziele für die zeitliche Mittelung ----------
    const ziel = () => new THREE.RenderTarget(LICHT_PIXEL, LICHT_PIXEL, { type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      depthBuffer: false, samples: 0, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.roh = ziel();
    this.verlauf = [ziel(), ziel()];
    this.jetzt = 0;
    /** Baut Speicher, Rechenschritte und Flecken für ein Raster von N × N Strahlen (auch nachträglich kleiner). */
    this.setzeRaster = N => {
      const ANZ = N * N;
      this.raster = N;
      // ---------- Speicher ----------
      if (this.szene) this.raeume();                 // alte Speicher, Rechenschritte und Flecken freigeben
      const bLand = instancedArray(ANZ, 'vec4');     // x, z des Auftreffpunkts, Weg vom Austritt, Zustand (2 = Licht)
      const bFarbe = instancedArray(ANZ, 'vec4');    // Gewicht je Farbe
      const bGerade = instancedArray(ANZ, 'vec4');   // x, z ohne Flakon, Weg vom Hindernis, 1 = verdeckt
      const kA = instancedArray(ANZ, 'vec4'), kB = instancedArray(ANZ, 'vec4'), kC = instancedArray(ANZ, 'vec4');
      const sA = instancedArray(ANZ, 'vec4'), sB = instancedArray(ANZ, 'vec4');
      this.speicher = [bLand, bFarbe, bGerade, kA, kB, kC, sA, sB];

      // ---------- Rechenschritt 1: Strahlen verfolgen ----------
      this.verfolgen = Fn(() => {
        const i = int(instanceIndex);
        const iy = i.div(N), ix = i.sub(iy.mul(N));
        const fx = float(ix).add(0.5).div(N).mul(2).sub(1), fy = float(iy).add(0.5).div(N).mul(2).sub(1);
        const o = this.uL;
        const d = this.uZ.add(this.uU.mul(fx)).add(this.uV.mul(fy)).sub(o).normalize().toVar();
        const d0 = vec3(d).toVar();
        // Wo der Strahl ohne Flakon auf dem Tuch landet
        const gerade = vec3(tuchTreffer(o, d0).ort).toVar();
        // Verschluss: Zylinder (Mantel und Deckel), undurchsichtig
        const ca = d0.xz.dot(d0.xz).max(1e-8), cb = o.xz.dot(d0.xz), cc = o.xz.dot(o.xz).sub(VERSCHLUSS.r ** 2);
        const disk = cb.mul(cb).sub(ca.mul(cc));
        const hm = o.add(d0.mul(cb.negate().sub(disk.max(0).sqrt()).div(ca)));
        const mantel = disk.greaterThan(0).and(hm.y.greaterThan(VERSCHLUSS.y0)).and(hm.y.lessThan(VERSCHLUSS.y1));
        const hd = o.add(d0.mul(float(VERSCHLUSS.y1).sub(o.y).div(d0.y.min(-1e-4))));
        const deckel = hd.xz.length().lessThan(VERSCHLUSS.r);
        const kappe = mantel.or(deckel).toVar();
        // Marsch zur Außenhaut
        const p = o.add(d.mul(this.uZ.sub(o).dot(d).sub(0.085))).toVar();
        const treffer = float(0).toVar(), lauf = float(0).toVar(), davor = vec3(p).toVar();
        Loop(72, () => {
          const a = aussen(p).toVar();
          If(a.lessThan(0.00008), () => { treffer.assign(1); Break(); });
          // Die Tabelle schätzt den Abstand nur radial; an der flachen Schulter liegt die Haut näher — vorsichtig gehen
          const s = a.mul(0.5).clamp(0.0003, 0.006);
          davor.assign(p);
          p.addAssign(d.mul(s));
          lauf.addAssign(s);
          If(lauf.greaterThan(0.19).or(p.y.lessThan(-0.001)), () => { Break(); });
        });
        // Übers Ziel hinaus: die Haut zwischen dem letzten Punkt außen und dem ersten innen eingrenzen
        If(treffer.greaterThan(0.5), () => {
          Loop(7, () => {
            const m = davor.add(p).mul(0.5).toVar();
            If(aussen(m).lessThan(0.00004), () => { p.assign(m); }).Else(() => { davor.assign(m); });
          });
        });
        const zustand = float(0).toVar();           // 0 frei, 1 verdeckt, 2 Licht kommt an
        const w = vec3(0).toVar(), land = vec3(0).toVar(), weg = float(0).toVar();
        const hindernis = select(kappe, select(mantel, hm, hd), p).toVar();
        If(kappe.or(treffer.greaterThan(0.5)), () => { zustand.assign(1); });
        If(kappe.not().and(treffer.greaterThan(0.5)).and(imEtikett(p).not()).and(p.y.lessThan(GLAS_H - 0.0006)), () => {
          const n0 = aussenNormale(p).toVar();
          const b0 = brechen(d, n0, 1 / IOR_GLAS);
          w.assign(vec3(float(1).sub(b0.F).mul(kegelAn(d0)).mul(kernAn(d0))));
          d.assign(b0.T);
          p.subAssign(n0.mul(0.0005));
          const medium = float(1).toVar();           // 1 Glas, 2 Höhlung
          Loop(9, () => {
            const art = float(0).toVar();
            If(medium.lessThan(1.5), () => {
              // im Glas bis zur Höhlung (1) oder zur Außenhaut (2)
              const innen = vec3(p).toVar();
              Loop(48, () => {
                const dc = sdf(p).toVar(), da = aussen(p).negate().toVar();
                If(dc.lessThan(0.0002), () => { art.assign(1); Break(); });
                If(da.lessThan(0.00008), () => { art.assign(2); Break(); });
                innen.assign(p);
                p.addAssign(d.mul(min(dc, da.mul(0.6)).mul(0.85).clamp(0.0004, 0.006)));
              });
              If(art.greaterThan(1.5), () => {
                Loop(7, () => {
                  const m = innen.add(p).mul(0.5).toVar();
                  If(aussen(m).greaterThan(-0.00004), () => { p.assign(m); }).Else(() => { innen.assign(m); });
                });
              });
              If(art.lessThan(0.5), () => { Break(); });
              If(art.lessThan(1.5), () => {
                const Nc = grad(p).toVar();            // zeigt aus der Höhlung ins Glas
                const nass = f(p).lessThan(0).and(uFl.greaterThan(0.5));
                const b = brechen(d, Nc, float(IOR_GLAS).div(select(nass, IOR_FLUESSIG, 1.0)));
                If(b.tir, () => {
                  d.assign(b.R); p.addAssign(Nc.mul(0.0006));
                }).Else(() => {
                  w.mulAssign(float(1).sub(b.F)); d.assign(b.T); p.subAssign(Nc.mul(0.0008)); medium.assign(2);
                });
              }).Else(() => {
                If(p.y.greaterThan(GLAS_H - 0.0006), () => { Break(); });   // unter dem Verschluss
                const no = aussenNormale(p).toVar();
                const b = brechen(d, no.negate(), IOR_GLAS);
                If(b.tir, () => {
                  d.assign(b.R); p.subAssign(no.mul(0.0005));
                }).Else(() => {
                  If(imEtikett(p).not(), () => { w.mulAssign(float(1).sub(b.F)); d.assign(b.T); zustand.assign(2); });
                  Break();
                });
              });
            }).Else(() => {
              // in der Höhlung (Luft oder Flüssigkeit) bis zur Wand (1) oder zur Flüssigkeitsoberfläche (2)
              const f0 = f(p).toVar(), strecke = float(0).toVar();
              const nass = f0.lessThan(0).and(uFl.greaterThan(0.5)).toVar();
              Loop(40, () => {
                const dw = sdf(p).negate().toVar();
                If(dw.lessThan(0.0002), () => { art.assign(1); Break(); });
                const s = min(dw, select(uFl.greaterThan(0.5), f0.abs(), 1.0)).mul(0.85).max(0.0004).toVar();
                const f1 = f(p.add(d.mul(s))).toVar();
                If(uFl.greaterThan(0.5).and(f1.mul(f0).lessThan(0)), () => {
                  s.mulAssign(f0.div(f0.sub(f1)));
                  p.addAssign(d.mul(s)); strecke.addAssign(s);
                  art.assign(2); Break();
                });
                p.addAssign(d.mul(s)); strecke.addAssign(s); f0.assign(f1);
              });
              If(nass, () => { w.mulAssign(vec3(...ABSORPTION).mul(strecke).negate().exp()); });
              If(art.lessThan(0.5).or(p.y.greaterThan(GLAS_H - 0.0006)), () => { Break(); });
              If(art.lessThan(1.5), () => {
                const Nw = grad(p).toVar();
                const b = brechen(d, Nw.negate(), select(nass, IOR_FLUESSIG, 1.0).div(IOR_GLAS));
                w.mulAssign(float(1).sub(b.F)); d.assign(b.T); p.addAssign(Nw.mul(0.0006)); medium.assign(1);
              }).Else(() => {
                const Ns = oberflaechenNormale(p).toVar();   // zeigt in die Luft
                If(nass, () => {
                  const b = brechen(d, Ns.negate(), IOR_FLUESSIG);
                  If(b.tir, () => { d.assign(b.R); p.subAssign(Ns.mul(0.0003)); })
                    .Else(() => { w.mulAssign(float(1).sub(b.F)); d.assign(b.T); p.addAssign(Ns.mul(0.0003)); });
                }).Else(() => {
                  const b = brechen(d, Ns, 1 / IOR_FLUESSIG);
                  w.mulAssign(float(1).sub(b.F)); d.assign(b.T); p.subAssign(Ns.mul(0.0003));
                });
              });
            });
          });
          If(zustand.greaterThan(1.5), () => {
            zustand.assign(1);
            If(d.y.lessThan(-0.02), () => {
              const tr = tuchTreffer(p, d);
              land.assign(tr.ort);
              weg.assign(tr.weg);
              If(aufKarte(land), () => { zustand.assign(2); });
            });
          });
        });
        bLand.element(instanceIndex).assign(vec4(land.x, land.z, weg, zustand));
        bFarbe.element(instanceIndex).assign(vec4(w, 1));
        bGerade.element(instanceIndex).assign(vec4(gerade.x, gerade.z, hindernis.sub(gerade).length(),
          select(aufKarte(gerade), zustand.min(1), 0.0)));
      })().compute(ANZ);

      // ---------- Rechenschritt 2: Form der Lichtflecken aus den Nachbarstrahlen ----------
      const S_FLECK = this.uFleck, EPS = this.uEps, QUELLE = 0.5 * 0.012 / LICHT_ABSTAND, L_MAX = 0.005;
      const fleck = (du, dv, wegN, gewicht, zielA, zielB) => {
        const e2 = EPS.mul(EPS).add(wegN.mul(QUELLE).mul(wegN.mul(QUELLE)));
        const a = du.x.mul(du.x).add(dv.x.mul(dv.x)).mul(S_FLECK.mul(S_FLECK)).add(e2).toVar();
        const b = du.x.mul(du.y).add(dv.x.mul(dv.y)).mul(S_FLECK.mul(S_FLECK)).toVar();
        const c = du.y.mul(du.y).add(dv.y.mul(dv.y)).mul(S_FLECK.mul(S_FLECK)).add(e2).toVar();
        const det = a.mul(c).sub(b.mul(b)).max(1e-16).toVar();
        const amp = gewicht.div(det.sqrt().mul(2 * Math.PI));
        zielA.assign(vec4(a.sqrt().mul(3).min(0.03), c.sqrt().mul(3).min(0.03), 0, 0));
        zielB.assign(vec4(c.div(det), b.negate().div(det), a.div(det), amp));
      };
      this.formen = Fn(() => {
        const i = int(instanceIndex);
        const iy = i.div(N), ix = i.sub(iy.mul(N));
        const nachbar = (dx, dy) => ix.add(dx).clamp(0, N - 1).add(iy.add(dy).clamp(0, N - 1).mul(N));
        // Schatten: regelmäßiges Raster, mittige Differenzen
        const g = bGerade.element(i).toVar();
        const gu = bGerade.element(nachbar(1, 0)).xy.sub(bGerade.element(nachbar(-1, 0)).xy).mul(0.5).toVar();
        const gv = bGerade.element(nachbar(0, 1)).xy.sub(bGerade.element(nachbar(0, -1)).xy).mul(0.5).toVar();
        const sa = vec4(0).toVar(), sb = vec4(0).toVar();
        fleck(gu, gv, g.z, g.w.mul(this.uZelle), sa, sb);
        sA.element(instanceIndex).assign(vec4(g.x, g.y, sa.x.mul(g.w), sa.y.mul(g.w)));
        sB.element(instanceIndex).assign(sb);
        // Licht: je Richtung die kürzere der beiden einseitigen Differenzen (hält Sprünge scharf)
        const l = bLand.element(i).toVar();
        const an = l.w.greaterThan(1.5);
        const seite = (dx, dy, ersatz) => {
          const pa = bLand.element(nachbar(dx, dy)).toVar(), pb = bLand.element(nachbar(-dx, -dy)).toVar();
          const da = pa.xy.sub(l.xy).toVar(), db = l.xy.sub(pb.xy).toVar();
          const la = select(pa.w.greaterThan(1.5), da.length(), 1e3).toVar(), lb = select(pb.w.greaterThan(1.5), db.length(), 1e3).toVar();
          const v = select(la.lessThan(lb), da, db).toVar(), lv = min(la, lb).toVar();
          return select(lv.greaterThan(100), ersatz, v.mul(float(L_MAX).div(lv.max(1e-7)).min(1))).toVar();
        };
        const lu = seite(1, 0, vec2(L_MAX, 0)), lv = seite(0, 1, vec2(0, L_MAX));   // einzelner Strahl ohne Nachbarn: breit und schwach
        const ka = vec4(0).toVar(), kb = vec4(0).toVar();
        fleck(lu, lv, l.z, this.uZelle.mul(this.uStark), ka, kb);
        const ein = select(an, 1.0, 0.0);
        kA.element(instanceIndex).assign(vec4(l.x, l.y, ka.x.mul(ein), ka.y.mul(ein)));
        kB.element(instanceIndex).assign(kb);
        kC.element(instanceIndex).assign(bFarbe.element(i));
      })().compute(ANZ);

      const material = (A, B, C) => {
        const m = new THREE.NodeMaterial();
        const a = A.toAttribute(), b = B.toAttribute();
        const versatz = positionGeometry.xy.mul(a.zw);
        m.vertexNode = vec4(a.xy.add(versatz).div(LICHT_BREITE / 2), 0, 1);
        const vV = varying(versatz), vB = varying(b);
        const glocke = vV.x.mul(vV.x).mul(vB.x).add(vV.x.mul(vV.y).mul(vB.y).mul(2)).add(vV.y.mul(vV.y).mul(vB.z)).mul(-0.5).exp().mul(vB.w);
        m.fragmentNode = C ? vec4(varying(C.toAttribute().xyz).mul(glocke), 0) : vec4(0, 0, 0, glocke);
        m.blending = THREE.CustomBlending;
        m.blendEquation = THREE.AddEquation;
        m.blendSrc = m.blendSrcAlpha = THREE.OneFactor;
        m.blendDst = m.blendDstAlpha = THREE.OneFactor;
        m.transparent = true;
        m.depthTest = m.depthWrite = false;
        m.side = THREE.DoubleSide;
        return m;
      };
      this.szene = new THREE.Scene();
      for (const m of [material(kA, kB, kC), material(sA, sB, null)]) {
        const netz = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
        netz.count = ANZ;
        netz.frustumCulled = false;
        this.szene.add(netz);
      }
    };
    this.setzeRaster(raster);
    this.kamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // ---------- Zeitliche Mittelung (zwei Ziele im Wechsel), dabei leicht geglättet ----------
    const px = 0.5 / LICHT_PIXEL;
    this.mittler = [0, 1].map(k => {
      const alt = texture(this.verlauf[1 - k].texture), neu = texture(this.roh.texture);
      const m = new THREE.NodeMaterial();
      m.fragmentNode = Fn(() => {
        const u = uv();
        const glatt = neu.sample(u.add(vec2(px, px))).add(neu.sample(u.add(vec2(-px, px))))
          .add(neu.sample(u.add(vec2(px, -px)))).add(neu.sample(u.add(vec2(-px, -px)))).mul(0.25);
        return mix(alt.sample(u), glatt, this.uMisch);
      })();
      m.depthTest = m.depthWrite = false;
      return new THREE.QuadMesh(m);
    });

    // ---------- Abfrage für Tuch und Glas ----------
    this.tex = texture(this.verlauf[0].texture);
    const spotFarbe = vec3(1.0, 0.97, 0.92);
    /** Bestrahlung der Tuchstelle (x, z) in Flaschenkoordinaten mit der Tuchnormale N: direktes Licht (Einfallswinkel,
     *  Schatten des Flakons, mit falten = true auch der Schatten der Falten), gebündeltes Licht und Grundlicht je
     *  Tuchfläche; strahl = Licht senkrecht zum Strahl (für den Glanz), l = Richtung zum Licht. */
    this.bestrahlung = (x, z, N, falten = true) => {
      const h = tuch.hoeheAn(x, z);
      const P = vec3(x, h, z);
      // Zeile 0 der Lichttextur liegt bei z = +Rand (Bildschirm-y nach oben beim Aufsummieren)
      const t = this.tex.sample(vec2(x.div(LICHT_BREITE).add(0.5), float(0.5).sub(z.div(LICHT_BREITE))))
        .mul(step(max(x.abs(), z.abs()), LICHT_BREITE / 2));
      const zumLicht = this.uL.sub(P);
      const abstand = zumLicht.length(), l = zumLicht.div(abstand);
      const nl = N.dot(l).max(0);
      // Einheit: Bestrahlung senkrecht zum Licht im Abstand der Rastermitte (uD0); so zählen auch die Strahlen
      const fern = this.uD0.mul(this.uD0).div(abstand.mul(abstand));
      // Die Lichttextur zählt Strahlen je Grundfläche (x, z): ohne Flakon kämen hier nl / N.y · fern an
      const dichte = nl.div(N.y.max(0.2)).mul(fern);
      // Schatten: aufsummierte verdeckte Strahlen im Verhältnis dazu (0,94: Rand der Glocken und Schrägstellung
      // des Rasters, an der Schattenmitte gemessen)
      const schatten = t.a.div(dichte.mul(0.94).max(0.02)).clamp(0, 1);
      // Schatten der Falten: Weg zum Licht durch das Höhenfeld, bis er über allen Falten ist; der kleinste
      // Freiwinkel zählt (weicher Rand von der Größe der Lichtquelle)
      let frei = float(1);
      if (falten) {
        frei = Fn(() => {
          const s1 = tuch.uHmax.sub(h).max(0).div(l.y.max(0.08));
          const klar = float(1).toVar();
          Loop(FALTEN_SCHRITTE, ({ i }) => {
            const s = s1.mul(float(i).add(0.7).div(FALTEN_SCHRITTE));
            const q = P.add(l.mul(s));
            klar.assign(min(klar, q.y.sub(tuch.hoeheAn(q.x, q.z)).add(0.0003).div(s.max(0.002))));
          });
          return smoothstep(-0.01, 0.03, klar);
        })();
      }
      const strahl = fern.mul(kegelAn(l.negate())).mul(float(1).sub(schatten)).mul(this.uStark).mul(frei)
        .mul(this.uDirekt).mul(this.uHell);
      const grau = t.r.add(t.g).add(t.b).div(3);
      const kaustik = mix(vec3(grau), t.rgb, this.uSaettigung).max(0).mul(N.y.max(0.2));
      // Licht der Softboxen: überall etwas, unter und dicht am Flakon weniger
      const grund = this.uGrund.mul(float(1).sub(smoothstep(0.05, 0.02, vec2(x, z).length()).mul(0.55))).mul(this.uHell);
      return { direkt: spotFarbe.mul(strahl.mul(nl)), kaustik: spotFarbe.mul(kaustik).mul(this.uKaustik).mul(this.uHell),
        grund, strahl, l, nl };
    };
    this._q = new THREE.Vector3();
    this._farbe = new THREE.Color();
    this.ruhe = 0;
    this.letzte = '';
    this.zaehler = 0;      // Zahl der gerechneten Lichtbilder (für Abfragen, die das Ergebnis zwischenspeichern)
  }

  /** Lichtlage in Flaschenkoordinaten aus der Lage der Flasche (glas.uRT: Welt → Flasche). */
  aktualisiere(glas) {
    const RT = glas.uRT.value;
    this.lage.aktualisiere(RT);
    const L = this.uL.value, Z = this.uZ.value;
    const dL = this._q.copy(Z).sub(L).normalize();
    const U = this.uU.value.set(-dL.z, 0, dL.x);          // dL × y
    if (U.lengthSq() < 1e-6) U.set(1, 0, 0);
    U.normalize();
    const V = this.uV.value.crossVectors(U, dL).normalize();
    const hu = 0.0495, hv = 0.0725 * Math.abs(V.y) + 0.047 * Math.sqrt(Math.max(0, 1 - V.y * V.y)) + 0.002;
    U.multiplyScalar(hu); V.multiplyScalar(hv);
    this.uZelle.value = (2 * hu / this.raster) * (2 * hv / this.raster);
    // Steht alles still, muss nicht neu gerechnet werden (spart am Handy Strom); die Mittelung läuft noch kurz aus
    const e = RT.elements, a = glas.uA.value;
    const marke = [e[0], e[1], e[2], e[3], e[4], e[5], glas.uD.value, a.x, a.y, a.z, a.w, glas.uFluessig.value,
      glas.uEtikett.value].map(v => v.toFixed(6)).join();
    this.ruhe = marke === this.letzte ? this.ruhe + 1 : 0;
    this.letzte = marke;
  }

  /** Ein Bild rechnen: Strahlen, Flecken, Aufsummieren, Mitteln. */
  rechne() {
    if (this.ruhe > 24) return;
    const r = this.renderer;
    r.compute(this.verfolgen);
    r.compute(this.formen);
    const ziel = r.getRenderTarget(), alpha = r.getClearAlpha();
    r.getClearColor(this._farbe);
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.roh);
    r.render(this.szene, this.kamera);
    this.jetzt = 1 - this.jetzt;
    r.setRenderTarget(this.verlauf[this.jetzt]);
    this.mittler[this.jetzt].render(r);
    r.setRenderTarget(ziel);
    r.setClearColor(this._farbe, alpha);
    this.tex.value = this.verlauf[this.jetzt].texture;
    this.zaehler++;
  }

  /** Lichttextur auslesen (nur für Eichung und Sichtung): Float32Array RGBA, pixel². */
  async lies() {
    const roh = await this.renderer.readRenderTargetPixelsAsync(this.verlauf[this.jetzt], 0, 0, this.pixel, this.pixel);
    if (roh instanceof Float32Array) return roh;
    const aus = new Float32Array(roh.length);
    for (let i = 0; i < roh.length; i++) aus[i] = THREE.DataUtils.fromHalfFloat(roh[i]);
    return aus;
  }

  /** Gibt alles frei, was am Strahlenraster hängt: Flecken, Rechenschritte und die Speicher der Strahlen (beim
   *  Wechsel auf das kleine Raster blieben sie sonst auf der Grafikkarte liegen). */
  raeume() {
    if (!this.szene) return;
    for (const netz of this.szene.children) { netz.geometry.dispose(); netz.material.dispose(); }
    this.verfolgen.dispose();
    this.formen.dispose();
    for (const knoten of this.speicher || []) {
      if (knoten.value && typeof knoten.value.dispose === 'function') knoten.value.dispose();
      if (typeof knoten.dispose === 'function') knoten.dispose();
    }
    this.speicher = [];
    this.szene = null;
  }

  dispose() {
    this.aktiv = false;
    this.raeume();
    for (const z of [this.roh, ...this.verlauf]) z.dispose();
    this.tabelle.dispose();
  }
}
