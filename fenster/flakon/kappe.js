// web/kappe.js — die Kappe (Verschluss): gedrehtes, umlaufend gebürstetes Metall mit sichtbarer Struktur (Vertrag §6.11).
// Die Kappe ist ein Drehteil: die Bürstung läuft auf dem Mantel um die Achse und auf der Deckfläche in Kreisen. Solche
// Rillen streuen das Licht quer zu sich breit und längs kaum — die Softboxen der Umgebung erscheinen deshalb als
// senkrechte, weiche Lichtbänder auf dem Mantel (wie im LuxCore-Standbild), dazwischen wird es dunkler: ein
// Helligkeitsverlauf in jeder Drehlage. Dazu kommen ungleichmäßige Rauheit, feine Kratzer und eine Fase an der
// Oberkante mit eigenem Glanzlicht (sie spiegelt die Reflektoren über der Szene).
// flakon.glb bleibt unverändert: die Fase entsteht beim Laden aus den vorhandenen Ringen der Kantenrundung; die
// Struktur-Texturen werden hier gerechnet (fester Zufall), es gibt dafür keine Dateien.
import * as THREE from 'three/webgpu';
import { Fn, dFdx, dFdy, atan, float, mix, normalLocal, pmremTexture, positionLocal, smoothstep, texture, uniform, vec2,
  vec3 } from 'three/tsl';
import { SPOT_RICHTUNG, VERSCHLUSS } from './glas.js';

// Fase: von (Radius 17 mm, y 143,8 mm) nach (15,8 mm, 145 mm), also 1,2 mm unter 45°
const FASE_Y = 0.1438, FASE_R = 0.0158;
const UMLAUF = 2;            // Wiederholungen der Bürst-Textur um den Umfang (107 mm)
const QUER_M = 0.0128;       // Höhe einer Wiederholung quer zur Bürstung
const KRATZ_M = 0.032;       // Höhe der Kratzer-Textur (einmal um den Umfang)

function zufall(saat) {
  let a = saat >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kastenfilter entlang einer Achse mit Umlauf (kachelbar); dreimal nacheinander ergibt nahezu eine Glocke. */
function weich(feld, w, h, breite, entlangU) {
  if (breite < 2) return feld;
  const aus = new Float32Array(feld.length), n = entlangU ? w : h, m = entlangU ? h : w, halb = breite >> 1;
  for (let k = 0; k < m; k++) {
    const an = i => entlangU ? k * w + ((i % n) + n) % n : (((i % n) + n) % n) * w + k;
    let summe = 0;
    for (let i = -halb; i <= halb; i++) summe += feld[an(i)];
    for (let i = 0; i < n; i++) {
      aus[an(i)] = summe / (2 * halb + 1);
      summe += feld[an(i + halb + 1)] - feld[an(i - halb)];
    }
  }
  return aus;
}

function rauschen(w, h, rnd, u, v) {
  let f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = rnd() - 0.5;
  for (let k = 0; k < 3; k++) { f = weich(f, w, h, u, true); f = weich(f, w, h, v, false); }
  let q = 0;
  for (let i = 0; i < f.length; i++) q += f[i] * f[i];
  const s = 1 / Math.sqrt(q / f.length + 1e-20);
  for (let i = 0; i < f.length; i++) f[i] *= s;      // Mittel 0, Streuung 1
  return f;
}

function alsTextur(kanaele, w, h, hub) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) d[i * 4 + c] = Math.max(0, Math.min(255, 127.5 + kanaele[c][i] * hub[c]));
    d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Bürstung: R feine Rillen (ein bis zwei Bildpunkte, 0,05 mm), G mittlere Bänder (0,3 mm), B breite Bänder (1 mm);
 *  alle lang entlang u (Umfang). */
function buerstTextur() {
  const w = 1024, h = 256, rnd = zufall(4211);
  return alsTextur([rauschen(w, h, rnd, 56, 1), rauschen(w, h, rnd, 150, 5), rauschen(w, h, rnd, 280, 18)], w, h, [46, 46, 46]);
}

/** Gebrauchsspuren: R Kratzer (dünne, kurze Striche in allen Richtungen, die meisten flach zur Bürstung), G wolkige
 *  Rauheit (Griffspuren), B große Flecken. */
function spurenTextur() {
  const w = 512, h = 512, rnd = zufall(977);
  const kratzer = new Float32Array(w * h);
  const strich = (x, y, winkel, laenge, staerke) => {
    const dx = Math.cos(winkel), dy = Math.sin(winkel);
    for (let s = 0; s < laenge; s += 0.5) {
      const fx = x + dx * s, fy = y + dy * s, ende = Math.min(1, s / 6, (laenge - s) / 6);
      const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
      for (const [ii, jj, g] of [[i, j, (1 - a) * (1 - b)], [i + 1, j, a * (1 - b)], [i, j + 1, (1 - a) * b], [i + 1, j + 1, a * b]]) {
        const z = (((jj % h) + h) % h) * w + (((ii % w) + w) % w);
        kratzer[z] = Math.max(kratzer[z], g * staerke * ende);
      }
    }
  };
  for (let k = 0; k < 70; k++) {
    // Die Textur ist um den Umfang 3,3-mal gröber als in der Höhe: Winkel hier flach wählen, im Bild streuen sie mehr
    const flach = rnd() < 0.7, winkel = (flach ? (rnd() - 0.5) * 0.5 : (rnd() - 0.5) * Math.PI) + (rnd() < 0.5 ? 0 : Math.PI);
    strich(rnd() * w, rnd() * h, winkel, 8 + rnd() * rnd() * 70, 0.8 + rnd() * rnd() * 2.6);
  }
  for (let k = 0; k < 30; k++) strich(rnd() * w, rnd() * h, rnd() * 6.283, 2 + rnd() * 4, 1.5 + rnd() * 2);   // kleine Macken
  return alsTextur([kratzer, rauschen(w, h, rnd, 34, 34), rauschen(w, h, rnd, 120, 120)], w, h, [75, 50, 50]);
}

/** Aus der Kantenrundung der Oberkante (Viertelkreis, 6 Ringe) wird eine Fase mit knappen Übergängen: gerader Mantel
 *  bis FASE_Y, 45° bis zum Radius FASE_R, dann die ebene Deckfläche. Nur die Lage und die Normalen der vorhandenen
 *  Ecken ändern sich. */
function formeFase(geo) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const ringe = new Set();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > 0.1425 + 5e-5 && y < VERSCHLUSS.y1 - 5e-5) ringe.add(Math.round(y * 1e5));
  }
  const ys = [...ringe].sort((a, b) => a - b);
  if (ys.length !== 6) return false;      // anderes Modell: Rundung lassen, wie sie ist
  const R = VERSCHLUSS.r, w = Math.SQRT1_2;
  // [Radius, Höhe, Normale radial, Normale nach oben]
  const neu = [[R, 0.14310, 1, 0], [R, FASE_Y - 0.00015, 1, 0], [R - 0.00004, FASE_Y + 0.00004, w, w],
    [(R + FASE_R) / 2, (FASE_Y + VERSCHLUSS.y1) / 2, w, w], [FASE_R + 0.00004, VERSCHLUSS.y1 - 0.00004, w, w],
    [FASE_R - 0.00014, VERSCHLUSS.y1, 0, 1]];
  for (let i = 0; i < pos.count; i++) {
    const k = ys.indexOf(Math.round(pos.getY(i) * 1e5));
    if (k < 0) continue;
    const x = pos.getX(i), z = pos.getZ(i), r = Math.hypot(x, z) || 1, [nr, ny, a, b] = neu[k];
    pos.setXYZ(i, x / r * nr, ny, z / r * nr);
    nor.setXYZ(i, x / r * a, b, z / r * a);
  }
  pos.needsUpdate = nor.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return true;
}

export class Kappe {
  /** netz: Teil „Verschluss“ aus flakon.glb (seine Koordinaten sind Flaschenkoordinaten); glas: Lage der Flasche und
   *  der Kamera (uR, uRT, uKam) */
  constructor(netz, hdr, glas) {
    this.fase = formeFase(netz.geometry);
    const buerst = texture(buerstTextur()), spuren = texture(spurenTextur());
    this.uFarbe = uniform(new THREE.Color(0.80, 0.80, 0.83));   // silbergrau (Spiegelfarbe des Metalls)
    this.uUmgebung = uniform(1.3);     // Helligkeit der gespiegelten Umgebung
    this.uLaengs = uniform(0.34);      // Rauheit entlang der Bürstung (seidenmatt)
    this.uMatt = uniform(0.45);        // breiter, matter Grundglanz (Anteil): hält die Kappe zwischen den Lichtbändern grau
    this.uQuer = uniform(0.30);        // Streuwinkel quer zur Bürstung (Rillen): macht die senkrechten Lichtbänder
    this.uRillen = uniform(0.17);      // Neigung der Fläche durch die einzelnen Rillen
    this.uLinien = uniform(0.6);       // Haarlinien: jede Rille spiegelt etwas heller oder dunkler als ihre Nachbarn
    this.uBaender = uniform(0.16);     // ungleichmäßige Bürstung: Bänder mit mehr oder weniger Streuung
    this.uWolken = uniform(0.22);      // ungleichmäßige Rauheit (Griffspuren)
    this.uKratzer = uniform(0.22);     // Helligkeit der Kratzer
    this.uSpot = uniform(2.2);         // Glanzlicht des Hauptlichts (Spot, steht nicht im Panorama)
    const spotW = uniform(SPOT_RICHTUNG);

    this.farbe = Fn(() => {
      const p = positionLocal;
      const r = p.xz.length().max(1e-5);
      const er = vec3(p.x.div(r), 0, p.z.div(r));
      const T = vec3(er.z, 0, er.x.negate());            // Richtung der Bürstung: um die Achse
      const Ng = normalLocal.normalize();
      const Bq = Ng.cross(T).normalize();                // quer zur Bürstung, in der Fläche
      // Abwicklung: u um den Umfang, s quer dazu (Mantelhöhe, über die Fase weiter auf die Deckfläche nach innen)
      const phi = atan(p.x, p.z).div(2 * Math.PI);
      const s = p.y.add(float(VERSCHLUSS.r).sub(r));
      const dpx = dFdx(p), dpy = dFdy(p);
      // Ableitungen von Hand: der Winkel springt hinten um (Naht), seine Ableitung nicht
      const dphi = vec3(p.z, 0, p.x.negate()).div(r.mul(r).mul(2 * Math.PI));
      const ds = vec3(er.x.negate(), 1, er.z.negate());
      const gx = vec2(dphi.dot(dpx), ds.dot(dpx)), gy = vec2(dphi.dot(dpy), ds.dot(dpy));
      const an = (tex, mu, mv, vu = 0, vv = 0) => tex.sample(vec2(phi.mul(mu).add(vu), s.mul(mv).add(vv)))
        .grad(gx.mul(vec2(mu, mv)), gy.mul(vec2(mu, mv)));
      const b1 = an(buerst, UMLAUF, 1 / QUER_M), b2 = an(buerst, UMLAUF + 1, 1 / (QUER_M * 2.7), 0.37, 0.61);
      const sp = an(spuren, 1, 1 / KRATZ_M);
      const rillen = b1.r.sub(0.5).mul(0.7).add(b1.g.sub(0.5).mul(0.6)).add(b2.r.sub(0.5).mul(0.4));   // einzelne Rillen
      const baender = b1.b.sub(0.5).add(b2.g.sub(0.5)).add(b2.b.sub(0.5).mul(1.3));                    // breite Züge
      const wolke = sp.g.sub(0.5).add(sp.b.sub(0.5).mul(0.6));
      const kratzer = sp.r.sub(0.5).max(0).mul(2);
      const V = glas.uKam.sub(p).normalize();
      // Die Rillen kippen die Fläche quer zur Bürstung hin und her
      const N = Ng.add(Bq.mul(rillen.mul(this.uRillen).mul(4))).normalize();
      const nv = N.dot(V).max(0.03);
      const quer = this.uQuer.mul(baender.mul(this.uBaender).mul(2).add(1).clamp(0.45, 1.8))
        .mul(wolke.mul(this.uWolken).add(1).clamp(0.6, 1.5));
      const laengs = this.uLaengs.mul(wolke.mul(this.uWolken).mul(1.6).add(1).clamp(0.55, 1.7)).add(kratzer.mul(0.25));
      const fresnel = c => this.uFarbe.add(vec3(1).sub(this.uFarbe).mul(float(1).sub(c).clamp(0, 1).pow(5)));
      // Umgebung: die Spiegelrichtung quer zur Bürstung aufgefächert (sieben Richtungen, Glockengewichte)
      const stufen = [[-1.8, 0.07], [-1.2, 0.14], [-0.6, 0.2], [0, 0.18], [0.6, 0.2], [1.2, 0.14], [1.8, 0.07]];
      let umgebung = vec3(0);
      for (const [t, g] of stufen) {
        const Nk = N.add(Bq.mul(quer.mul(t))).normalize();
        umgebung = umgebung.add(pmremTexture(hdr, glas.uR.mul(V.negate().reflect(Nk)), laengs).mul(g));
      }
      const matt = pmremTexture(hdr, glas.uR.mul(V.negate().reflect(N)), float(0.72));
      umgebung = mix(umgebung, matt, this.uMatt);
      // Hauptlicht: anisotropes Glanzlicht (schmal entlang der Bürstung, breit quer dazu)
      const L = glas.uRT.mul(spotW);
      const H = L.add(V).normalize();
      const aT = laengs.mul(laengs).max(0.02), aB = quer.mul(1.5).max(0.05);
      const th = T.dot(H).div(aT), bh = Bq.dot(H).div(aB), nh = N.dot(H);
      const nenner = th.mul(th).add(bh.mul(bh)).add(nh.mul(nh));
      const D = float(1).div(nenner.mul(nenner).mul(aT).mul(aB).mul(Math.PI));
      const nl = N.dot(L).max(0);
      const spot = D.mul(nl).div(float(4).mul(nl.mul(nv).max(0.08))).mul(this.uSpot).min(6);
      // Kratzer: blanke Flanken streuen etwas Licht aus allen Richtungen
      const streu = pmremTexture(hdr, glas.uR.mul(N), float(0.8)).mul(kratzer).mul(this.uKratzer);
      // Unterkante: dicht über dem Glas kommt weniger Licht an
      const kante = smoothstep(VERSCHLUSS.y0 - 0.0002, VERSCHLUSS.y0 + 0.0026, p.y).mul(0.75).add(0.25);
      const linien = b1.r.sub(0.5).add(b2.r.sub(0.5).mul(0.6)).mul(this.uLinien).add(1).clamp(0.6, 1.4);
      return umgebung.mul(this.uUmgebung).add(vec3(1.0, 0.97, 0.92).mul(spot)).mul(linien).mul(fresnel(nv)).add(streu).mul(kante);
    });
  }

  material() {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = this.farbe();
    return m;
  }
}
