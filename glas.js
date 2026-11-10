// web/glas.js — Glas und Flüssigkeit in einem Strahl (TSL, WebGPU und WebGL 2).
// Je Pixel der Außenhaut: Spiegelung der Umgebung (Fresnel), Brechung ins Glas (IOR 1,5), Marsch durch die
// Wand bis zur Innenhöhlung (Abstandsfeld hoehlung_sdf.bin, Kugelverfolgung), dort Brechung in Luft oder in die
// Flüssigkeit (IOR 1,36), Schnitt mit der Flüssigkeitsoberfläche aus dem Schwappmodell (Ebene + Wellen, genau wie
// oberflaecheY), Absorption über die Weglänge in der Flüssigkeit, Austritt durch die gegenüberliegende Innenwand und
// Abfrage der HDR-Umgebung. Die Glasdicke je Stelle kommt damit aus dem Modell selbst, nicht aus einem festen Wert.
import * as THREE from 'three';
import { Break, Fn, If, Loop, atan, cameraWorldMatrix, float, int, mix, normalMap, pmremTexture, positionLocal,
  select, smoothstep, texture, texture3D, uniform, uv, vec2, vec3 } from 'three/tsl';

export const SDF_U = [-0.042, 0.012, -0.042], SDF_S = 0.001, SDF_N = [85, 115, 85];
const K1 = Math.PI / 0.05, K2 = 2 * Math.PI / 0.05;
const IOR_GLAS = 1.5, IOR_FLUESSIG = 1.36;
// LuxCore: Transmission (0,99, 0,55, 0,10) nach 25 mm → Absorptionskoeffizient je Meter
export const ABSORPTION = [-Math.log(0.99) / 0.025, -Math.log(0.55) / 0.025, -Math.log(0.10) / 0.025];

/** Abstandsfeld als 3D-Textur. halb = true: 16-Bit-Gleitkomma — überall linear filterbar, auch wo 32-Bit-Texturen es
 *  nicht sind (WebGL 2 ohne OES_texture_float_linear, WebGPU ohne float32-filterable; Gegenprüfung T2n, Befund 4). */
export function sdfTextur(feldDaten, halb = false) {
  let daten = feldDaten;
  if (halb) {
    daten = new Uint16Array(feldDaten.length);
    for (let i = 0; i < daten.length; i++) daten[i] = THREE.DataUtils.toHalfFloat(feldDaten[i]);
  }
  const t = new THREE.Data3DTexture(daten, ...SDF_N);
  t.format = THREE.RedFormat;
  t.type = halb ? THREE.HalfFloatType : THREE.FloatType;
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

// Etikett (web/modell/flakon.glb, Teil Etikett): Zylinderstück auf dem Bauch, Radius 34,1 mm, ±54,17° um +z,
// y 17,4 bis 53,4 mm; u läuft mit dem Winkel, v von oben nach unten. Verschluss: Zylinder r 17 mm, y 120 bis 145 mm.
export const ETIKETT = { r: 0.0341, halb: 54.166 * Math.PI / 180, y0: 0.0174, y1: 0.0534 };
export const VERSCHLUSS = { r: 0.017, y0: 0.120, y1: 0.145 };

export class Glas {
  /** tuchFarbe(P, V): Farbe des Tuchs an der Stelle P der Tuchebene, gesehen aus Richtung V (Flaschenkoordinaten) */
  constructor(feldDaten, hdr, tex, tuchFarbe, halb = false) {
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
    this.uGegenHof = uniform(0.4);  // weicher Hof um das Gegenlicht, durch die Flüssigkeit gesehen (Anteil der Kernhelligkeit)
    this.uSchmier = uniform(0.22);   // Streulicht des Schmierfilms (Fingerabdrücke, Wischspuren)
    this.uStaub = uniform(0.9);      // Streulicht der Staubkörner
    this.uSchleier = uniform(0.07);
    this.uSchleierFluessig = uniform(0.0);  // Anteil des Schleiers in der Flüssigkeit: 0 = klar
    this.uSchlieren = uniform(0.12); // Welligkeit der Innenwand-Normale // Streulicht-Anteil (Mehrfachreflexe, Schlieren): breite Umgebungsabfrage
    this.uSchritte = uniform(int(26));
    this.uEtikettLicht = uniform(3.5);  // Helligkeit der Etikett-Rückseite (Licht, das durch die Flasche fällt)
    this.uVerzerrung = uniform(0.2);
    this.uEtikett = uniform(1);  // 0: Etikett ausgeblendet (Testzugang)
    this.uFein = uniform(1);     // 0: Sparstufe ohne Oberflächenstruktur und Nebenstrahlen
    const sdfTex = this.sdfTex = sdfTextur(feldDaten, halb);

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
    // Das Tuch liegt nah: Strahlen nach unten schneiden die Tuchebene y = 0 (Flaschenkoordinaten, das Tuch kippt
    // mit) statt das Panorama zu fragen (das kennt keine Parallaxe) und sehen dort das Tuch mit seinem Licht.
    const bodenFarbe = (pF, dF) => {
      const t = pF.y.max(0).div(dF.y.min(-1e-4).negate());
      return tuchFarbe(pF.add(dF.mul(t)), dF.negate());
    };
    const env = (pF, dF, rauheit) => {
      const unten = smoothstep(0.03, -0.03, dF.y);
      return mix(envFern(this.uR.mul(dF), rauheit), bodenFarbe(pF, dF), unten);
    };
    // Verschluss durch das Glas gesehen: Strahl (Flasche) gegen den Zylinder der Kappe — Unterkante von unten,
    // Mantel von außen. Gebürstetes Metall: verwaschene Spiegelung der Umgebung.
    const szene = (pF, dF, rauheit) => {
      const ty = float(VERSCHLUSS.y0).sub(pF.y).div(dF.y.max(1e-4));
      const hu = pF.add(dF.mul(ty));
      const vonUnten = dF.y.greaterThan(1e-4).and(pF.y.lessThan(VERSCHLUSS.y0)).and(hu.xz.length().lessThan(VERSCHLUSS.r));
      const a = dF.xz.dot(dF.xz).max(1e-8), b = pF.xz.dot(dF.xz), c = pF.xz.dot(pF.xz).sub(VERSCHLUSS.r ** 2);
      const disk = b.mul(b).sub(a.mul(c));
      const tm = b.negate().sub(disk.max(0).sqrt()).div(a);
      const hm = pF.add(dF.mul(tm));
      const mantel = disk.greaterThan(0).and(tm.greaterThan(0)).and(c.greaterThan(0))
        .and(hm.y.greaterThan(VERSCHLUSS.y0)).and(hm.y.lessThan(VERSCHLUSS.y1));
      const n = select(vonUnten, vec3(0, -1, 0), vec3(hm.x, 0, hm.z).normalize());
      const metall = envFern(this.uR.mul(dF.reflect(n)), 0.38).mul(select(vonUnten, 0.45, 0.72));
      return select(vonUnten.or(mantel), metall, env(pF, dF, rauheit));
    };
    // Etikett von innen (durch Glas und Flüssigkeit) gesehen: Strahl im Glas vom Punkt p (innerhalb des Bauchs)
    // gegen den Zylinder der Etikettfläche. Liefert Deckung (0..1, Rand 0,25 mm weich) und die Farbe der
    // Rückseite: dunkles Papier, durch das die Heißfolie des Drucks matt-golden durchscheint — von hinten
    // gesehen von selbst spiegelverkehrt, wie bei einem echten Flakon.
    const etikettHinten = (pF, dF) => {
      const a = dF.xz.dot(dF.xz).max(1e-8), b = pF.xz.dot(dF.xz), c = pF.xz.dot(pF.xz).sub(ETIKETT.r ** 2);
      const t = b.negate().add(b.mul(b).sub(a.mul(c)).max(0).sqrt()).div(a);   // ferne Wand des Zylinders
      const h = pF.add(dF.mul(t));
      const winkel = atan(h.x, h.z);
      const rand = 0.00025;
      const disk = b.mul(b).sub(a.mul(c));
      const deckung = smoothstep(ETIKETT.halb, ETIKETT.halb - rand / ETIKETT.r, winkel.abs())
        .mul(smoothstep(ETIKETT.y0, ETIKETT.y0 + rand, h.y)).mul(smoothstep(ETIKETT.y1, ETIKETT.y1 - rand, h.y))
        .mul(disk.greaterThan(0).and(t.greaterThan(0.004)).select(1, 0)).mul(this.uEtikett);
      const uvE = vec2(winkel.div(2 * ETIKETT.halb).add(0.5), float(ETIKETT.y1).sub(h.y).div(ETIKETT.y1 - ETIKETT.y0)).clamp(0, 1);
      const druck = texture(tex.etikett_maske, uvE).level(0.5).r;
      const hoehe = texture(tex.etikett_hoehe, uvE).level(1).r;
      const papier = vec3(0.060, 0.036, 0.044).mul(hoehe.mul(0.5).add(0.75));
      const folie = vec3(0.95, 0.70, 0.28);
      // Licht auf der Rückseite: was von der Kameraseite durch die Flasche fällt (breite Umgebungsabfrage)
      const nInnen = vec3(h.x, 0, h.z).normalize().negate();
      const licht = pmremTexture(hdr, this.uR.mul(nInnen), float(0.9)).mul(this.uGain).mul(this.uEtikettLicht);
      return { deckung, farbe: mix(papier, folie, druck.mul(0.8)).mul(licht) };
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
    const gegenlicht = (pF, dF, hofAnteil) => {
      const p = this.uR.mul(pF), d = this.uR.mul(dF);
      const t = float(GEGENLICHT.z).sub(p.z).div(d.z.min(-1e-4));
      const h = p.add(d.mul(t));
      // Kern scharf (Rechteck, 2 mm Saum) und ein schwächerer Hof bis 40 mm (LuxCore: Spread 18°, die
      // Flüssigkeit verschmiert das Licht)
      const dx = h.x.sub(GEGENLICHT.x).abs(), dy = h.y.sub(GEGENLICHT.y).abs();
      const kern = smoothstep(GEGENLICHT.bx + 0.002, GEGENLICHT.bx - 0.002, dx).mul(smoothstep(GEGENLICHT.by + 0.002, GEGENLICHT.by - 0.002, dy));
      const hof = smoothstep(GEGENLICHT.bx + 0.05, GEGENLICHT.bx, dx).mul(smoothstep(GEGENLICHT.by + 0.05, GEGENLICHT.by, dy));
      const kegel = smoothstep(-0.86, -0.96, d.z);
      return this.uGegen.mul(kern.add(hof.mul(hofAnteil))).mul(kegel).mul(t.greaterThan(0).select(1, 0));
    };

    this.farbe = Fn(() => {
      // Normale mit Schlieren: Normal-Map im Sichtraum, dann Welt, dann Flasche
      const nView = normalMap(texture(tex.glas_normal, uv()), new THREE.Vector2(0.35, 0.35)).normalize();
      const nWelt = nView.transformDirection(cameraWorldMatrix);
      const n0 = this.uRT.mul(nWelt).normalize();
      // Gebrauchsspuren der Außenhaut (R Rauheit, G Staub, B Schmierfilm): verwaschen die Spiegelung und streuen
      // etwas Licht — im Streiflicht sichtbar, in der Gesamtansicht kaum (Vertrag §6.8)
      const spur = texture(tex.glas_rauheit, uv());
      const rau = spur.r.mul(this.uFein).add(0.012);
      const P0 = positionLocal;
      const V = P0.sub(this.uKam).normalize();
      const cos0 = V.dot(n0).negate().clamp(0, 1);
      const F = fresnel(cos0, 0.04);
      const Rv = V.reflect(n0);
      const spiegel = env(P0, Rv, rau);
      // Streulicht der Spuren: breit gestreute Umgebung um die Spiegelrichtung, dazu der Glanzhof des Spots
      const Rw = this.uR.mul(Rv);
      const hof = Rw.dot(spotRichtung).max(0).pow(40).mul(this.uSpot).mul(0.15);
      const streu = envFern(Rw, 0.55).add(envFern(this.uR.mul(n0), 1.0).mul(1.5)).add(hof).mul(spur.b.mul(this.uSchmier).add(spur.g.mul(this.uStaub))).mul(this.uFein);
      const T = V.refract(n0, 1 / IOR_GLAS).normalize().toVar();
      const farbe = vec3(0).toVar();

      const g1 = marschGlas(P0.add(T.mul(0.0004)), T);
      const g = { p: g1.p, tref: g1.tref };
      const sockel = float(1).toVar(); // Dämpfung nach einer Bodenspiegelung (siehe unten)
      const Ed = vec3(V).toVar();      // ruhige Blickrichtung für den Etikett-Strahl (gerader Blick, nach Bodenspiegelung der Glasstrahl)
      const G0 = vec3(P0).toVar();     // Ausgangspunkt des Strahls im Glas (nach einer Bodenspiegelung der Spiegelpunkt)
      // Massiver Sockel: Ein flach nach unten laufender Strahl trifft die ebene Standfläche (y = 0) jenseits des
      // Grenzwinkels (41,8°) und wird vollständig gespiegelt — der Sockel zeigt dann von unten die Höhlung mit
      // der Flüssigkeit statt der Unterlage (so auch im LuxCore-Bild).
      const tb = P0.y.negate().div(T.y.min(-1e-4));
      const hb = P0.add(T.mul(tb));
      If(g1.tref.lessThan(0.5).and(T.y.lessThan(-0.02)).and(T.y.greaterThan(-0.745)).and(hb.xz.length().lessThan(0.0325)), () => {
        T.assign(vec3(T.x, T.y.negate(), T.z));
        G0.assign(hb);
        Ed.assign(T);
        // Der gespiegelte Strahl sieht hinter der Flasche das nahe Gegenlicht, durch die Zylinderwand stark
        // verbreitert; im LuxCore-Bild ist das nur ein kleiner Glanzpunkt — am Vergleichsbild gedämpft.
        sockel.assign(0.35);
        const g2 = marschGlas(hb.add(T.mul(0.0004)), T);
        g.p.assign(g2.p);
        g.tref.assign(g2.tref);
      });
      If(g.tref.lessThan(0.5), () => {
        // Durch massives Glas (Boden, Rand) ohne Höhlung: Umgebung in Strahlrichtung
        farbe.assign(szene(G0, T, 0.08).add(gegenlicht(G0, T, 0.08).mul(0.35)).add(envFern(this.uR.mul(T), 0.7).mul(this.uSchleier)).mul(0.85).mul(sockel));
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
          // Was hinter der Flasche liegt, klar und scharf: Etikett-Rückseite (Strahl im Glas gegen die
          // Etikettfläche), sonst Verschluss, Tuch, Gegenlicht und Umgebung — in der Flüssigkeit ohne
          // Nebel, nur über die Weglänge getönt (Vertrag §6.8).
          // Der Sehstrahl zum Etikett wird nur zum Teil gebrochen (uVerzerrung): mit der vollen Brechung der
          // unregelmäßigen Innenwand zerfällt die Schrift in Fetzen; Fatih will sie „nicht übertrieben, aber ein
          // wenig verzerrt“. 0 = gerader Blick, 1 = volle Brechung.
          const et = etikettHinten(mix(G0, ausP, this.uVerzerrung), mix(Ed, T4, this.uVerzerrung).normalize());
          const fern = szene(ausP, T5, 0.05).add(gegenlicht(ausP, T5, select(nMed.greaterThan(1.1), this.uGegenHof, 0.12)));
          const hinten = mix(fern, et.farbe, et.deckung);
          // Schleier: etwas Streulicht aus den vielen Innenreflexen der dicken Glaswand (ein Strahl je Pixel
          // kennt sie nicht). Nur im Glas über der Flüssigkeit — die Flüssigkeit selbst bleibt klar.
          const schleier = envFern(this.uR.mul(T5), 0.7).mul(this.uSchleier)
            .mul(select(nMed.greaterThan(1.1), this.uSchleierFluessig, 1.0)).mul(float(1).sub(et.deckung));
          farbe.assign(hinten.mul(float(1).sub(Fa)).add(rueck.mul(Fa)).add(schleier).mul(weg).add(zusatz).mul(float(1).sub(Fc)).add(innen.mul(Fc)));
        });
      });
      return spiegel.mul(F).add(farbe.mul(float(1).sub(F))).add(streu);
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
