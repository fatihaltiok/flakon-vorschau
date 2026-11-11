// web/volumen.js — Volumen-Tabelle Ebenen-Abstand über (Neigung, Richtung), rein, ohne DOM.
// Bezugsvolumen wie das Gate: Gitterpunkte der Höhlung (SDF < 0) unter dem Ruhespiegel,
// je ein Gitterschritt hoch drei. Für eine Normale n̂ wird der Abstand d so gewählt, dass
// count(n̂·p < d) gleich dem Bezug ist; eingebaut mit Zähl-Buckets (0,05 mm), interpoliert
// bilinear über Neigung ϑ (Grad, gegen +y der Flasche) und Richtung φ (Grad, atan2(nx, nz)).

const BUCKET_BREITE = 0.00005;   // 0,05 mm
const BUCKET_MIN = -0.15;

export class VolumenTabelle {
  constructor(feldDaten, hoehlung, fuellung) {
    const [nx, ny, nz] = hoehlung.anzahl;
    const u = hoehlung.ursprung, s = hoehlung.schritt;
    if (feldDaten.length !== nx * ny * nz) throw new Error(`Feld hat ${feldDaten.length} Werte statt ${nx * ny * nz}`);
    // Höhlungspunkte (x,y,z in Flaschen-Koordinaten) wie das Gate: Wert < 0
    const punkte = [];
    for (let z = 0; z < nz; z++) {
      const wz = u[2] + z * s;
      for (let y = 0; y < ny; y++) {
        const wy = u[1] + y * s;
        for (let x = 0; x < nx; x++) {
          if (feldDaten[x + nx * (y + ny * z)] < 0) punkte.push(u[0] + x * s, wy, wz);
        }
      }
    }
    this.punkte = new Float32Array(punkte);
    this.anzahl = this.punkte.length / 3;
    this.bezug = 0;
    for (let i = 0; i < this.anzahl; i++) if (this.punkte[i * 3 + 1] < fuellung.spiegel_y) this.bezug++;
    this.schrittTh = 5;
    this.schrittPh = 5;
    this.zeilen = 19;              // 0..90 Grad
    this.spalten = 72;             // 0..360 Grad
    this.d = new Float64Array(this.zeilen * this.spalten);   // float64: Grenzwerte liegen näher als Float32-Auflösung
    this.#bauen();
  }

  #bauen() {
    const n = this.anzahl, p = this.punkte;
    const anzahlBuckets = Math.ceil(0.3 / BUCKET_BREITE);
    const zaehler = new Uint32Array(anzahlBuckets);
    for (let i = 0; i < this.zeilen; i++) {
      const th = (i * this.schrittTh) * Math.PI / 180;
      for (let j = 0; j < this.spalten; j++) {
        const ph = (j * this.schrittPh) * Math.PI / 180;
        const nx = Math.sin(th) * Math.sin(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.cos(ph);
        zaehler.fill(0);
        for (let k = 0; k < n; k++) {
          const t = p[k * 3] * nx + p[k * 3 + 1] * ny + p[k * 3 + 2] * nz;
          let b = ((t - BUCKET_MIN) / BUCKET_BREITE) | 0;
          if (b < 0) b = 0; else if (b >= anzahlBuckets) b = anzahlBuckets - 1;
          zaehler[b]++;
        }
        // Ziel-Bucket suchen: kumuliertes Überschreiten von `bezug`
        let kum = 0, ziel = 0;
        for (let b = 0; b < anzahlBuckets; b++) {
          if (kum + zaehler[b] >= this.bezug) { ziel = b; break; }
          kum += zaehler[b];
        }
        // Zähl-Grenze im Ziel-Bucket exakt: Werte dort sammeln, sortieren, Mitte der
        // Grenzwerte nehmen (Gitterpunkte teilen sich oft denselben Wert — Schätzungen
        // scheitern dort, siehe (0,0) mit −2,75 %).
        const loB = BUCKET_MIN + ziel * BUCKET_BREITE, hiB = loB + BUCKET_BREITE;
        const sammel = [];
        for (let k = 0; k < n; k++) {
          const t = p[k * 3] * nx + p[k * 3 + 1] * ny + p[k * 3 + 2] * nz;
          if (t >= loB && t < hiB) sammel.push(t);
        }
        sammel.sort((a, b) => a - b);
        const stelle = this.bezug - kum;              // 1-basiert im Ziel-Bucket

        if (sammel.length === 0) {
          this.d[i * this.spalten + j] = (loB + hiB) / 2;
        } else {
          const lo = sammel[stelle - 1];
          const naechster = stelle < sammel.length ? sammel[stelle] : NaN;
          if (Number.isFinite(naechster) && naechster - lo > 1e-6) {
            this.d[i * this.spalten + j] = (lo + naechster) / 2;   // trifft `bezug` exakt
          } else {
            // Bande endet an lo: beide erreichbaren Zählungen bestimmen und die
            // näher am Bezug wählen. Die obere Grenze liegt weit genug oben, damit
            // die Float32-Rückgabe von oberflaecheY nicht auf lo zurückrundet.
            let oben = hiB;
            for (let b2 = ziel + 1; b2 < anzahlBuckets; b2++) {
              if (zaehler[b2] > 0) { oben = BUCKET_MIN + b2 * BUCKET_BREITE; break; }
            }
            if (oben <= lo + 1e-6) oben = lo + 1e-4;
            const dOben = (lo + oben) / 2;
            let cntA = kum, cntB = kum;
            for (const t of sammel) { if (t < lo) cntA++; if (t < dOben) cntB++; }
            this.d[i * this.spalten + j] = Math.abs(this.bezug - cntA) <= Math.abs(cntB - this.bezug) ? lo : dOben;
          }
        }
      }
    }
  }

  // Ebenen-Abstand d für die Flaschen-Normale (ϑ Grad gegen +y, φ Grad atan2(nx, nz))
  abstand(thGrad, phGrad) {
    const th = Math.min(90, Math.max(0, thGrad)) / this.schrittTh;
    const ph = ((phGrad % 360) + 360) % 360 / this.schrittPh;
    const i = Math.min(this.zeilen - 2, Math.floor(th)), j = Math.floor(ph) % this.spalten;
    const j2 = (j + 1) % this.spalten;
    const a = th - i, b = ph - Math.floor(ph);
    const d = this.d;
    return (1 - a) * ((1 - b) * d[i * this.spalten + j] + b * d[i * this.spalten + j2])
      + a * ((1 - b) * d[(i + 1) * this.spalten + j] + b * d[(i + 1) * this.spalten + j2]);
  }

  // Abstand für eine Normale als (nx, ny, nz) in Flaschen-Koordinaten
  abstandFuerNormal(n) {
    const th = Math.acos(Math.min(1, Math.max(-1, n[1]))) * 180 / Math.PI;
    const ph = Math.atan2(n[0], n[2]) * 180 / Math.PI;
    return this.abstand(th, ph);
  }
}
