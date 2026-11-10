// web/glas.js — Glas und Flüssigkeit in einem Strahl (TSL, WebGPU und WebGL 2).
// Je Pixel der Außenhaut: Spiegelung der Umgebung (Fresnel), Brechung ins Glas (IOR 1,5), Marsch durch die
// Wand bis zur Innenhöhlung (Abstandsfeld hoehlung_sdf.bin, Kugelverfolgung), dort Brechung in Luft oder in die
// Flüssigkeit (IOR 1,36), Schnitt mit der Flüssigkeitsoberfläche aus dem Schwappmodell (Ebene + Wellen, genau wie
// oberflaecheY), Absorption über die Weglänge in der Flüssigkeit, Austritt durch die gegenüberliegende Innenwand und
// Abfrage der HDR-Umgebung. Die Glasdicke je Stelle kommt damit aus dem Modell selbst, nicht aus einem festen Wert.
import * as THREE from 'three';
import { Break, Fn, If, Loop, cameraWorldMatrix, float, int, mix, normalMap, pmremTexture, positionLocal,
  select, smoothstep, texture, texture3D, uniform, uv, vec2, vec3 } from 'three/tsl';

export const SDF_U = [-0.042, 0.012, -0.042], SDF_S = 0.001, SDF_N = [85, 115, 85];
const K1 = Math.PI / 0.05, K2 = 2 * Math.PI / 0.05;
const IOR_GLAS = 1.5, IOR_FLUESSIG = 1.36;
// LuxCore: Transmission (0,99, 0,55, 0,10) nach 25 mm → Absorptionskoeffizient je Meter
export const ABSORPTION = [-Math.log(0.99) / 0.025, -Math.log(0.55) / 0.025, -Math.log(0.10) / 0.025];

export function sdfTextur(feldDaten) {
  const t = new THREE.Data3DTexture(feldDaten, ...SDF_N);
  t.format = THREE.RedFormat;
  t.type = THREE.FloatType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** Die Datei nutzt u = 0,5 − atan2(x,z)/2π; three.js erwartet u = atan2(z,x)/2π + 0,5. Der Unterschied ist eine
 *  Drehung um y, die flakon.js als scene.environmentRotation setzt — sie gilt für alle pmremTexture-Abfragen. */
export const ENV_DREHUNG_Y = -Math.PI / 2;
export const envRichtung = d => d;
// Gegenlicht hinter dem Flakon (szene/flakon.py Licht_Gegen_3): Rechteck 25 × 45 mm bei z = −0,30 m, Mitte y = 0,041,
// strahlt nur nach +z (Spread 18°). Wird als echte Fläche geschnitten, nicht aus dem Panorama.
export const GEGENLICHT = { z: -0.30, x: 0, y: 0.041, bx: 0.0125, by: 0.0225 };
// Hauptlicht (Spot, szene/flakon.py Licht_Haupt) von hinten rechts oben, nicht im Panorama (Spots sind dort
// unsichtbar): als kleine helle Scheibe in Richtung des Lichts, 0,586 m entfernt, Radius 12 mm.
export const SPOT_RICHTUNG = new THREE.Vector3(0.15, 0.38 - 0.06, -0.42).normalize();

export class Glas {
  constructor(feldDaten, hdr, tex, tellerLicht) {
    this.uR = uniform(new THREE.Matrix3());      // Flasche → Welt
    this.uRT = uniform(new THREE.Matrix3());     // Welt → Flasche
    this.uKam = uniform(new THREE.Vector3(0, 0.1, 0.6)); // Kamera in Flaschenkoordinaten
    this.uNf = uniform(new THREE.Vector3(0, 1, 0));      // Oberflächennormale (Flasche)
    this.uD = uniform(0.067);
    this.uA = uniform(new THREE.Vector4(0, 0, 0, 0));
    this.uFluessig = uniform(1);
    this.uGain = uniform(0.5);
    this.uGegen = uniform(4);    // Leuchtdichte des Gegenlichts (vor Tonemapping)
    this.uSpot = uniform(6);     // Leuchtdichte der Spot-Scheibe
    this.uSchleier = uniform(0.07);
    this.uSchlieren = uniform(0.12); // Welligkeit der Innenwand-Normale // Streulicht-Anteil (Mehrfachreflexe, Schlieren): breite Umgebungsabfrage
    this.uSchritte = uniform(int(26));
    const sdfTex = sdfTextur(feldDaten);

    const koord = p => vec3(
      p.x.sub(SDF_U[0]).div(SDF_S).add(0.5).div(SDF_N[0]),
      p.y.sub(SDF_U[1]).div(SDF_S).add(0.5).div(SDF_N[1]),
      p.z.sub(SDF_U[2]).div(SDF_S).add(0.5).div(SDF_N[2]));
    const sdf = p => texture3D(sdfTex, koord(p)).x;
    const H = 0.0012;
    // Innenwand: Normale aus dem Feld, dazu feine Schlieren (mundgeblasen) als leise Welligkeit
    const grad = p => {
      const n = vec3(
        sdf(p.add(vec3(H, 0, 0))).sub(sdf(p.sub(vec3(H, 0, 0)))),
        sdf(p.add(vec3(0, H, 0))).sub(sdf(p.sub(vec3(0, H, 0)))),
        sdf(p.add(vec3(0, 0, H))).sub(sdf(p.sub(vec3(0, 0, H)))));
      const w1 = p.y.mul(620).add(p.x.mul(240).sin().mul(2.5)).sin();
      const w2 = p.x.mul(530).add(p.z.mul(470)).add(p.y.mul(90).sin().mul(2)).sin();
      const w3 = p.z.mul(610).sub(p.x.mul(380)).add(p.y.mul(150)).sin();
      return n.normalize().add(vec3(w2, w1, w3).mul(this.uSchlieren)).normalize();
    };
    const spotRichtung = uniform(SPOT_RICHTUNG);
    const envFern = (dirW, rauheit) => {
      const cosS = dirW.dot(spotRichtung);
      const spot = smoothstep(0.9990, 0.9997, cosS).mul(this.uSpot).mul(float(1).sub(float(rauheit).mul(3)).clamp(0, 1));
      return pmremTexture(hdr, envRichtung(dirW), float(rauheit)).mul(this.uGain).add(spot);
    };
    // Boden und Teller liegen nah: Strahlen nach unten schneiden die Ebene y = −0,006 (Welt) statt das Panorama
    // zu fragen (das kennt keine Parallaxe). Innerhalb 90 mm: Teller mit gebackenem Licht, sonst dunkler Boden
    // mit dem Kegel des Spots.
    const bodenFarbe = (pW, dW) => {
      const t = float(-0.006).sub(pW.y).div(dW.y.min(-1e-4));
      const h = pW.add(dW.mul(t));
      const r = h.xz.length();
      const teller = tellerLicht(h.x, h.z);
      const kegel = smoothstep(0.26, 0.05, h.xz.sub(vec2(0.01, 0.03)).length()).mul(0.05).add(0.003);
      return select(r.lessThan(0.088), teller, vec3(kegel));
    };
    const env = (pF, dF, rauheit) => {
      const dW = this.uR.mul(dF), pW = this.uR.mul(pF);
      const unten = smoothstep(0.03, -0.03, dW.y);
      return mix(envFern(dW, rauheit), bodenFarbe(pW, dW), unten);
    };
    const wellen = (px, pz) => {
      const x = px.clamp(-0.025, 0.025), z = pz.clamp(-0.025, 0.025);
      return this.uA.x.mul(x.mul(K1).sin()).add(this.uA.y.mul(z.mul(K1).sin()))
        .add(this.uA.z.mul(x.mul(K2).cos())).add(this.uA.w.mul(z.mul(K2).cos()));
    };
    // f < 0: unter der Flüssigkeitsoberfläche (gleiche Fläche wie oberflaecheY: N·p = d + Wellen)
    const f = p => this.uNf.dot(p).sub(this.uD).sub(wellen(p.x, p.z));
    const fresnel = (cos, f0) => float(f0).add(float(1).sub(f0).mul(float(1).sub(cos).clamp(0, 1).pow(5)));

    // Kugelverfolgung in der Glaswand bis zur Höhlung: liefert Treffer-Punkt, ob getroffen
    const marschGlas = (start, dir) => {
      const p = start.toVar(), tref = float(0).toVar(), t = float(0).toVar();
      Loop(this.uSchritte, () => {
        const d = sdf(p);
        If(d.lessThan(0.0002), () => { tref.assign(1); Break(); });
        const s = d.mul(0.85).max(0.0004);
        p.addAssign(dir.mul(s));
        t.addAssign(s);
        If(t.greaterThan(0.1), () => { Break(); });
      });
      return { p, tref };
    };
    // Kugelverfolgung in der Höhlung (Luft oder Flüssigkeit) bis zur gegenüberliegenden Wand: Weglänge
    const marschInnen = (start, dir) => {
      const p = start.add(dir.mul(0.0006)).toVar(), t = float(0.0006).toVar();
      Loop(this.uSchritte, () => {
        const d = sdf(p).negate();
        If(d.lessThan(0.0002), () => { Break(); });
        const s = d.mul(0.85).max(0.0004);
        p.addAssign(dir.mul(s));
        t.addAssign(s);
        If(t.greaterThan(0.14), () => { Break(); });
      });
      return { p, t };
    };
    // Schnitt des Strahls mit der Flüssigkeitsoberfläche (Ebene, dann zwei Sekantenschritte für die Wellen)
    const schnittOberflaeche = (a, dir) => {
      const nd = this.uNf.dot(dir);
      const t = this.uD.add(wellen(a.x, a.z)).sub(this.uNf.dot(a)).div(nd).toVar();
      for (let i = 0; i < 2; i++) {
        const s = a.add(dir.mul(t));
        t.addAssign(this.uD.add(wellen(s.x, s.z)).sub(this.uNf.dot(s)).div(nd));
      }
      return t;
    };
    const oberflaechenNormale = s => {
      const e = 0.0008;
      const dx = wellen(s.x.add(e), s.z).sub(wellen(s.x.sub(e), s.z)).div(2 * e);
      const dz = wellen(s.x, s.z.add(e)).sub(wellen(s.x, s.z.sub(e))).div(2 * e);
      // Fläche N·p − d − w(x,z) = 0 → Gradient N − (dw/dx, 0, dw/dz)
      return this.uNf.sub(vec3(dx, 0, dz)).normalize();
    };
    const absorption = l => vec3(...ABSORPTION).mul(l).negate().exp();
    // Gegenlicht: Strahl (Welt) von p in Richtung d trifft das Rechteck? Weicher Rand 2 mm, Abstrahlwinkel begrenzt.
    const gegenlicht = (pF, dF) => {
      const p = this.uR.mul(pF), d = this.uR.mul(dF);
      const t = float(GEGENLICHT.z).sub(p.z).div(d.z.min(-1e-4));
      const h = p.add(d.mul(t));
      // Kern scharf (Rechteck, 2 mm Saum) und ein schwächerer Hof bis 40 mm (LuxCore: Spread 18°, die
      // Flüssigkeit verschmiert das Licht)
      const dx = h.x.sub(GEGENLICHT.x).abs(), dy = h.y.sub(GEGENLICHT.y).abs();
      const kern = smoothstep(GEGENLICHT.bx + 0.002, GEGENLICHT.bx - 0.002, dx).mul(smoothstep(GEGENLICHT.by + 0.002, GEGENLICHT.by - 0.002, dy));
      const hof = smoothstep(GEGENLICHT.bx + 0.04, GEGENLICHT.bx, dx).mul(smoothstep(GEGENLICHT.by + 0.04, GEGENLICHT.by, dy));
      const kegel = smoothstep(-0.86, -0.96, d.z);
      return this.uGegen.mul(kern.add(hof.mul(0.18))).mul(kegel).mul(t.greaterThan(0).select(1, 0));
    };

    this.farbe = Fn(() => {
      // Normale mit Schlieren: Normal-Map im Sichtraum, dann Welt, dann Flasche
      const nView = normalMap(texture(tex.glas_normal, uv()), new THREE.Vector2(0.35, 0.35)).normalize();
      const nWelt = nView.transformDirection(cameraWorldMatrix);
      const n0 = this.uRT.mul(nWelt).normalize();
      const rau = texture(tex.glas_rauheit, uv()).r.mul(0.25);
      const P0 = positionLocal;
      const V = P0.sub(this.uKam).normalize();
      const cos0 = V.dot(n0).negate().clamp(0, 1);
      const F = fresnel(cos0, 0.04);
      const spiegel = env(P0, V.reflect(n0), rau);
      const T = V.refract(n0, 1 / IOR_GLAS).normalize();
      const farbe = vec3(0).toVar();

      const g = marschGlas(P0.add(T.mul(0.0004)), T);
      If(g.tref.lessThan(0.5), () => {
        // Durch massives Glas (Boden, Rand) ohne Höhlung: Umgebung in Strahlrichtung
        farbe.assign(env(P0, T, 0.08).add(gegenlicht(P0, T)).add(envFern(this.uR.mul(T), 0.7).mul(this.uSchleier)).mul(0.85));
      }).Else(() => {
        const Q = g.p, Nc = grad(Q).toVar();              // Nc zeigt aus der Höhlung ins Glas
        const inFluessig = f(Q).lessThan(0).and(this.uFluessig.greaterThan(0.5)).toVar();
        const nMedium = select(inFluessig, IOR_FLUESSIG, 1.0);
        const eta = float(IOR_GLAS).div(nMedium);
        const cosc = T.dot(Nc).negate().clamp(0, 1);
        const f0c = float(IOR_GLAS).sub(nMedium).div(float(IOR_GLAS).add(nMedium)).pow(2);
        const T2 = T.refract(Nc, eta).toVar();
        const tir = T2.dot(T2).lessThan(1e-6);
        const Fc = select(tir, 1.0, fresnel(cosc, f0c)).toVar();
        const innen = env(Q, T.reflect(Nc), 0.12);           // Rückspiegelung an der Innenwand
        If(tir, () => {
          farbe.assign(innen);
        }).Else(() => {
          T2.assign(T2.normalize());
          const weg = vec3(1).toVar(), ausDir = T2.toVar(), ausP = Q.toVar(), zusatz = vec3(0).toVar();
          const vonOben = float(0).toVar();   // 1: Strahl kam aus der Luft von oben auf die Oberfläche
          const m1 = marschInnen(Q, T2);
          const nd = this.uNf.dot(T2);
          const ts = schnittOberflaeche(Q, T2);
          If(inFluessig, () => {
            const steigt = nd.greaterThan(1e-4).and(ts.greaterThan(0)).and(ts.lessThan(m1.t));
            If(steigt, () => {
              // in der Flüssigkeit nach oben, Oberfläche von unten
              const S = Q.add(T2.mul(ts));
              const Ns = oberflaechenNormale(S);
              weg.assign(absorption(ts));
              const T3 = T2.refract(Ns.negate(), IOR_FLUESSIG).toVar();
              If(T3.dot(T3).lessThan(1e-6), () => {
                // Totalreflexion an der Oberfläche: zurück in die Flüssigkeit bis zur Wand
                const R = T2.reflect(Ns).normalize();
                const m2 = marschInnen(S, R);
                weg.mulAssign(absorption(m2.t));
                ausDir.assign(R); ausP.assign(m2.p);
              }).Else(() => {
                T3.assign(T3.normalize());
                const m2 = marschInnen(S, T3);
                ausDir.assign(T3); ausP.assign(m2.p);   // Luftstrecke ohne Absorption
              });
            }).Else(() => {
              weg.assign(absorption(m1.t));
              ausP.assign(m1.p);
            });
          }).Else(() => {
            const sinkt = nd.lessThan(-1e-4).and(ts.greaterThan(0)).and(ts.lessThan(m1.t)).and(this.uFluessig.greaterThan(0.5));
            If(sinkt, () => {
              // in der Luft nach unten auf die Oberfläche: Spiegelung + Brechung in die Flüssigkeit
              const S = Q.add(T2.mul(ts));
              const Ns = oberflaechenNormale(S);
              const coss = T2.dot(Ns).negate().clamp(0, 1);
              const Fs = fresnel(coss, 0.0233);
              zusatz.assign(env(S, T2.reflect(Ns), 0.02).mul(Fs));
              vonOben.assign(1);
              const T3 = T2.refract(Ns, 1 / IOR_FLUESSIG).normalize();
              const m2 = marschInnen(S, T3);
              weg.assign(absorption(m2.t).mul(float(1).sub(Fs)));
              ausDir.assign(T3); ausP.assign(m2.p);
            }).Else(() => {
              ausP.assign(m1.p);
            });
          });
          // Austritt durch die gegenüberliegende Wand: Brechung Medium → Glas an der (welligen) Innenwand, dann
          // Glas → Luft an einer glatten Näherung der Außenhaut (seitlich radial, am Boden nach unten).
          const Na = grad(ausP).negate();                  // zeigt ins Medium
          const nMed = select(f(ausP).lessThan(0).and(this.uFluessig.greaterThan(0.5)), IOR_FLUESSIG, 1.0);
          const cosa = ausDir.dot(Na).negate().clamp(0, 1);
          const f0a = nMed.sub(IOR_GLAS).div(nMed.add(IOR_GLAS)).pow(2);
          const T4 = ausDir.refract(Na, nMed.div(IOR_GLAS)).toVar();
          const T4ok = T4.dot(T4).greaterThan(1e-6);
          const Fa = select(T4ok, fresnel(cosa, f0a), 1.0);
          const rueck = env(ausP, ausDir.reflect(Na), 0.12);   // Spiegelung an der hinteren Innenwand
          T4.assign(T4ok.select(T4.normalize(), ausDir));
          const radial = vec3(ausP.x, 0, ausP.z).normalize();
          const unten = smoothstep(-0.3, -0.8, T4.y).mul(smoothstep(0.03, 0.012, ausP.y));
          const No = mix(radial, vec3(0, -1, 0), unten).normalize().negate();   // zeigt ins Glas
          const T5 = T4.refract(No, IOR_GLAS).toVar();
          const T5ok = T5.dot(T5).greaterThan(1e-6);
          T5.assign(T5ok.select(T5.normalize(), T4));
          // Pixel-Mittelung einer stark gebrochenen Sicht: leicht verwaschene Abfrage (Flüssigkeit stärker)
          const hinten = env(ausP, T5, select(nMed.greaterThan(1.1), 0.3, 0.1)).add(gegenlicht(ausP, T5));
          // Schleier: Streulicht aus vielen Innenreflexen, als breite Abfrage um die Strahlrichtung
          // in der Flüssigkeit deutlich stärker: LuxCore zeigt den Bernstein flächig leuchtend (Flüssigkeit im
          // Standbild mittlere Helligkeit 32, Bernstein-Anteil hoch); kalibriert am Vergleichsbild
          // Das Flüssigkeits-Streulicht gehört zum Blick durch die Vorderwand in die Flüssigkeit; von oben durch
          // die Oberfläche gesehen bleibt sie dunkel (so auch im LuxCore-Bild oberhalb der Spiegellinie).
          const schleier = envFern(this.uR.mul(T5), 0.7).mul(this.uSchleier)
            .mul(select(nMed.greaterThan(1.1), mix(8.0, 1.0, vonOben), 1.0));
          farbe.assign(hinten.mul(float(1).sub(Fa)).add(rueck.mul(Fa)).add(schleier).mul(weg).add(zusatz).mul(float(1).sub(Fc)).add(innen.mul(Fc)));
        });
      });
      return spiegel.mul(F).add(farbe.mul(float(1).sub(F)));
    });
  }

  material() {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = this.farbe();
    m.side = THREE.FrontSide;
    return m;
  }

  /** Je Bild: Lage der Flasche (Quaternion des Schwappmodells), Kamera, Flüssigkeitsebene und Wellen. */
  aktualisiere(modell, kameraWelt) {
    const q = modell.q;
    const Q = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    const R = new THREE.Matrix4().makeRotationFromQuaternion(Q);
    this.uR.value.setFromMatrix4(R);
    this.uRT.value.copy(this.uR.value).transpose();
    this.uKam.value.copy(kameraWelt).applyMatrix3(this.uRT.value);
    this.uNf.value.set(...modell.nWelt).applyMatrix3(this.uRT.value).normalize();
    this.uD.value = modell.d;
    this.uA.value.set(...modell.A);
  }
}
