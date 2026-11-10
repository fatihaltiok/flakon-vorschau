// web/schwappen.js — Schwappmodell, rein (kein DOM, kein three.js).
// Spiegel: Ebene senkrecht zur scheinbaren Schwerkraft, Abstand aus der Volumen-Tabelle.
// Schwappen: je Achse zwei gedämpfte Schwinger um die momentane Gleichgewichtsebene;
// die Gesamtneigung T (Weltachsen) folgt T̈ + 2ζω Ṫ + ω²(T − u) = 0 mit der Gleichgewichts-
// neigung u aus der scheinbaren Schwerkraft (Abramson/Ibrahim: Pendel/Feder-Masse).
// Mode 2 (cos(2πx/L), wasserrecht an der Wand) wird über die Moden-1-Auslenkung angeregt.
// Oberfläche: y = (d + h − nₓx − n_zz)/n_y mit h = Σ A·sin/cos in Flaschenkoordinaten.

export const DT = 1 / 240;
export const MODELL = {
  L: 0.05,                 // Breite des eckigen Spiegelbereichs (Modell, halbe Breite 25 mm)
  yC: 0.0425,              // Flüssigkeitsschwerpunkt über dem Drehpunkt (Boden-Mitte)
  g: 9.81,
  beta: 0.08,              // Modalanteil der zweiten Mode
  zeta2: 0.08,
  klemme1: 0.008,          // Auslenkung Mode 1 am Rand begrenzt (keine Spritzer)
  klemme2: 0.002,
};

export function qVonWinkel(gxRad, gzRad) {
  const ax = gxRad / 2, az = gzRad / 2;
  const qx = [Math.sin(ax), 0, 0, Math.cos(ax)], qz = [0, 0, Math.sin(az), Math.cos(az)];
  return qMal(qz, qx);     // Welt = Rz(gz)·Rx(gx)
}
export function qMal(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export function qKonj(a) { return [-a[0], -a[1], -a[2], a[3]]; }
export function qRot(q, v) {
  const p = [v[0], v[1], v[2], 0];
  const r = qMal(qMal(q, p), qKonj(q));
  return [r[0], r[1], r[2]];
}
// ω (Welt) aus dem Quaternion-Schritt (wie T1n3c)
export function winkelableitung(qAlt, qNeu, dt) {
  let d = qMal(qNeu, qKonj(qAlt));
  if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
  const s = Math.hypot(d[0], d[1], d[2]);
  const faktor = s > 1e-12 ? 2 * Math.atan2(s, d[3]) / (s * dt) : 2 / dt;
  return [d[0] * faktor, d[1] * faktor, d[2] * faktor];
}

export class Schwappmodell {
  constructor(modell, tabelle) {
    this.tabelle = tabelle;
    this.spiegelY = modell.fuellung.spiegel_y;
    this.f1 = Math.sqrt(1.841 * MODELL.g / modell.fuellung.innenradius_mittel_R
      * Math.tanh(1.841 * modell.fuellung.fuellhoehe_h / modell.fuellung.innenradius_mittel_R)) / (2 * Math.PI);
    this.om1 = 2 * Math.PI * this.f1;
    // Mode 2 nach dem Rechteck-Verhältnis k₂/k₁ = 2: ω² = g·k·tanh(k·h)
    const k1 = Math.PI / MODELL.L, k2 = 2 * Math.PI / MODELL.L;
    this.om2 = this.om1 * Math.sqrt(k2 * Math.tanh(k2 * modell.fuellung.fuellhoehe_h)
      / (k1 * Math.tanh(k1 * modell.fuellung.fuellhoehe_h)));
    this.zeta = 0.04;
    this.gFaktor = 1;
    this.q = [0, 0, 0, 1];
    this.T = [0, 0]; this.v = [0, 0];
    this.a2 = [0, 0]; this.v2 = [0, 0];
    this.nWelt = [0, 1, 0]; this.d = this.spiegelY;
    this.A = [0, 0, 0, 0];   // A1x, A1z, A2x, A2z (Flaschenachsen)
  }

  regler(staerke, nachklingen) {
    this.gFaktor = 0.5 + staerke / 100;
    this.zeta = 0.065 - 0.05 * nachklingen / 100;
  }
  parameter() { return { dt: DT, frequenz: this.f1, daempfung: this.zeta }; }

  #ebene(omegaWelt, alphaWelt) {
    const rWelt = qRot(this.q, [0, MODELL.yC, 0]);
    const om = omegaWelt, al = alphaWelt;
    const zx = al[1] * rWelt[2] - al[2] * rWelt[1], zy = al[2] * rWelt[0] - al[0] * rWelt[2], zz = al[0] * rWelt[1] - al[1] * rWelt[0];
    const k1x = om[1] * rWelt[2] - om[2] * rWelt[1], k1y = om[2] * rWelt[0] - om[0] * rWelt[2], k1z = om[0] * rWelt[1] - om[1] * rWelt[0];
    const kx = om[1] * k1z - om[2] * k1y, ky = om[2] * k1x - om[0] * k1z, kz = om[0] * k1y - om[1] * k1x;
    // Ebenen-Normale "oben" = −scheinbare Schwerkraft = (0,g,0) + α×r + ω×(ω×r)
    const roh = [zx + kx, MODELL.g + zy + ky, zz + kz];
    const betrag = Math.hypot(roh[0], roh[1], roh[2]) || 1;
    const nWelt = [roh[0] / betrag, roh[1] / betrag, roh[2] / betrag];
    nWelt[1] = Math.max(0.3, nWelt[1]);
    const nFlask = qRot(qKonj(this.q), nWelt);
    this.d = this.tabelle.abstandFuerNormal(nFlask);
    this.nWelt = nWelt;
    return nWelt;
  }

  setzeLage(q) {
    this.q = q.slice();
    this.T = [0, 0]; this.v = [0, 0]; this.a2 = [0, 0]; this.v2 = [0, 0];
    this.#ebene([0, 0, 0], [0, 0, 0]);
    this.#amplituden();
  }

  schritt(dt, q, omegaWelt, alphaWelt) {
    this.q = q.slice();
    const nWelt = this.#ebene(omegaWelt, alphaWelt);
    const u = [-nWelt[0] / nWelt[1], -nWelt[2] / nWelt[1]];   // Gleichgewichtsneigung (Welt)
    for (let i = 0; i < 2; i++) {
      this.v[i] += dt * (this.om1 ** 2 * (u[i] - this.T[i]) - 2 * this.zeta * this.om1 * this.v[i]);
      this.T[i] += dt * this.v[i];
      const a1 = (this.T[i] - u[i]) * (MODELL.L / Math.PI);
      this.v2[i] += dt * (this.om2 ** 2 * (MODELL.beta * a1 - this.a2[i]) - 2 * MODELL.zeta2 * this.om2 * this.v2[i]);
      this.a2[i] += dt * this.v2[i];
    }
    this.#amplituden();
  }

  // Wellen-Amplituden in Flaschenachsen (Welt-Abweichung gedreht), begrenzt, mit Stärke-Faktor
  #amplituden() {
    const n = this.nWelt;
    const u = [-n[0] / n[1], -n[2] / n[1]];
    const s1 = [(this.T[0] - u[0]) * this.gFaktor, 0, (this.T[1] - u[1]) * this.gFaktor];
    const s2 = [this.a2[0] * this.gFaktor, 0, this.a2[1] * this.gFaktor];
    const f1 = qRot(qKonj(this.q), s1), f2 = qRot(qKonj(this.q), s2);
    const klemm = (w, k) => Math.max(-k, Math.min(k, w));
    const f1x = klemm(f1[0] * MODELL.L / Math.PI, MODELL.klemme1), f1z = klemm(f1[2] * MODELL.L / Math.PI, MODELL.klemme1);
    this.A = [f1x, f1z, klemm(f2[0], MODELL.klemme2), klemm(f2[2], MODELL.klemme2)];
  }

  // Welt-Höhe y der Oberfläche über den Welt-Orten xz (flach x0,z0,x1,z1,…), immer endlich
  oberflaecheY(xzFlach) {
    const n = this.nWelt, d = this.d, [A1x, A1z, A2x, A2z] = this.A;
    const ny = Math.max(0.3, n[1]);
    const ergebnis = new Float32Array(xzFlach.length / 2);
    for (let i = 0; i < ergebnis.length; i++) {
      const x = xzFlach[i * 2], z = xzFlach[i * 2 + 1];
      const y0 = (d - n[0] * x - n[2] * z) / ny;
      const p = qRot(qKonj(this.q), [x, y0, z]);
      // Auslenkung läuft an der Wand waagerecht aus (nur innerhalb |x|,|z| ≤ L/2 gewellt)
      const xf = Math.max(-MODELL.L / 2, Math.min(MODELL.L / 2, p[0]));
      const zf = Math.max(-MODELL.L / 2, Math.min(MODELL.L / 2, p[2]));
      const h = A1x * Math.sin(Math.PI * xf / MODELL.L) + A2x * Math.cos(2 * Math.PI * xf / MODELL.L)
        + A1z * Math.sin(Math.PI * zf / MODELL.L) + A2z * Math.cos(2 * Math.PI * zf / MODELL.L);
      const y = (d + h - n[0] * x - n[2] * z) / ny;
      ergebnis[i] = Number.isFinite(y) ? y : y0;
    }
    return ergebnis;
  }
}
