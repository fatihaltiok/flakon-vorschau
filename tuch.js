// web/tuch.js — das gefaltete Satintuch unter dem Flakon (Vertrag §6.10).
// Ein Höhenfeld (tuch_hoehe.bin, aus der Stoffsimulation) ist die einzige Form des Tuchs: daraus entsteht das
// gezeichnete Netz, daran enden die Lichtstrahlen (tellerlicht.js), und der Testzugang fragt es ab. Das Tuch dreht
// und kippt mit dem Flakon; das Licht steht in der Welt fest.
// Satin: dunkelbrauner Grund, darüber ein anisotroper Glanz (glatt entlang der Fäden, breit quer dazu) vom Hauptlicht
// und von den Softboxen der Umgebung — er liegt als warmes Band auf den Faltenkämmen und wandert beim Drehen.
// Licht: unter WebGPU die Echtzeit-Rechnung (Schatten, gebündeltes Licht, Einfallswinkel je Faltenflanke), sonst acht
// LuxCore-Bilder der Bestrahlung auf dem Tuch (alle 45°, in Tuchkoordinaten), zwischen zwei Lagen überblendet.
import * as THREE from 'three';
import { Fn, cameraPosition, float, max, mix, modelWorldMatrixInverse, pmremTexture, positionLocal, smoothstep, step,
  texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { EchtzeitLicht, LICHT_BREITE, Lichtlage } from './tellerlicht.js';

const NETZ = 256;            // Zellen je Kante des gezeichneten Netzes über dem Höhenfeld
const FERN = 1.6;            // halbe Kante der flachen Fortsetzung (läuft ins Dunkle aus)
const HINTERGRUND = 0x141418;

export class Tuch {
  /** info: aussehen.json → tuch; hoehen: Uint16Array (oder null); normalTex: tuch_normal.png; bilder: 8 Lichtbilder;
   *  hdr: Umgebung; glas: Glas-Objekt (Drehlage der Flasche); opt.flach: Höhe überall 0 (nur Testzweck). */
  constructor(info, hoehen, normalTex, bilder, hdr, glas, opt = {}) {
    const n = this.n = info.pixel, B = this.breite = info.breite_m;
    this.flach = !!opt.flach;
    // ---------- Höhenfeld: Meter, [Zeile z, Spalte x] ----------
    const h = this.h = new Float32Array(n * n);
    let hmax = 0;
    if (!this.flach) for (let i = 0; i < n * n; i++) { h[i] = hoehen[i] * info.skala_m; if (h[i] > hmax) hmax = h[i]; }
    this.hmax = hmax;
    const halb = new Uint16Array(n * n);
    for (let i = 0; i < n * n; i++) halb[i] = THREE.DataUtils.toHalfFloat(h[i]);
    const hTex = this.hoeheTex = new THREE.DataTexture(halb, n, n, THREE.RedFormat, THREE.HalfFloatType);
    hTex.minFilter = hTex.magFilter = THREE.LinearFilter;
    hTex.wrapS = hTex.wrapT = THREE.ClampToEdgeWrapping;
    hTex.needsUpdate = true;
    this.uHmax = uniform(hmax);
    this.uFalten = uniform(this.flach ? 0 : 1);
    /** Höhe an der Stelle (x, z) im Shader — dieselben Werte wie hoehe(x, z) */
    this.hoeheAn = (x, z) => texture(hTex, vec2(x.div(B).add(0.5), z.div(B).add(0.5))).level(0).x;
    const nTex = texture(normalTex);
    /** Tuchnormale (Flaschenkoordinaten) aus der Normalen-Textur, die aus demselben Höhenfeld gerechnet ist */
    this.normalAn = (x, z) => {
      const t = nTex.sample(vec2(x.div(B).add(0.5), z.div(B).add(0.5)));
      // außerhalb des Höhenfelds ist das Tuch flach (die Textur wiederholt sich dort, für die Webstruktur)
      const an = step(max(x.abs(), z.abs()), B / 2).mul(this.uFalten);
      const nx = t.x.mul(255).sub(127.5).div(127.5).mul(an), nz = t.y.mul(255).sub(127.5).div(127.5).mul(an);
      return vec3(nx, float(1).sub(nx.mul(nx)).sub(nz.mul(nz)).max(0.04).sqrt(), nz).normalize();
    };

    // ---------- Licht ----------
    this.lage = new Lichtlage();
    this.echt = null;                 // Echtzeit-Licht (nur WebGPU), wird vor dem ersten Bild gesetzt
    this.uEcht = uniform(0);
    this.bilder = bilder;
    this.a = texture(bilder[0]);
    this.b = texture(bilder[1]);
    this.index = -1;
    this.uMisch = uniform(0);
    this.uKlar = uniform(1);          // 1: Bilder gelten (aufrecht), 0: gekippt → schlichter Ersatz
    // Bildwert → Bestrahlung in der Einheit des Echtzeit-Lichts, so eingestellt, dass das Tuch mit Bildern so hell
    // ist wie mit Echtzeit-Licht (Median im Tuchbereich 95 hier wie dort); das Licht der Softboxen (im Bild rund 0,08)
    // kommt hier wie dort aus der Umgebung und wird abgezogen
    this.uBild = uniform(0.45);
    this.uBildGrund = uniform(0.08);
    this.uWarm = uniform(2.2);        // 8-Bit-Bilder kappen das gebündelte, gefärbte Licht; warme Stellen wieder anheben
    // ---------- Aussehen ----------
    this.uFarbe = uniform(new THREE.Color(info.farbe || '#3A2418'));   // Grundfarbe (linear)
    this.uGlanzFarbe = uniform(new THREE.Vector3(1.0, 0.72, 0.48));    // warmer Glanz des Satins
    this.uGain = uniform(8.0);        // Bestrahlung → Leuchtdichte des Tuchs (am LuxCore-Standbild ausgerichtet)
    this.uDiffus = uniform(1.0);      // Stärke des matten Anteils
    this.uGlanz = uniform(0.25);      // Stärke des Glanzes vom Hauptlicht
    this.uUmgebung = uniform(0.5);    // Glanz der Softboxen (Umgebung)
    this.uRauLaengs = uniform(0.16);  // Rauheit entlang der Fäden
    this.uRauQuer = uniform(0.5);     // Rauheit quer dazu
    this.uWeb = uniform(1.0);         // Sichtbarkeit der Webstruktur
    this.uHintergrund = uniform(new THREE.Color(HINTERGRUND));
    this.uR = glas.uR;

    const gebackenAn = (x, z) => {
      const u = vec2(x.div(LICHT_BREITE).add(0.5), z.div(LICHT_BREITE).add(0.5));   // Zeile 0 der Datei (oben) = −z
      const c = mix(this.a.sample(u), this.b.sample(u), this.uMisch).rgb;
      return c.sub(this.uBildGrund).max(0).mul(c.r.sub(c.b).mul(3).clamp(0, 1).mul(this.uWarm).add(1)).mul(this.uBild);
    };
    /** Licht an der Tuchstelle: { diffus: Bestrahlung (Farbe), strahl: Licht senkrecht zum Strahl, l, nl } —
     *  aus der Echtzeit-Rechnung oder aus den Bildern */
    const licht = (x, z, N, falten) => {
      const P = vec3(x, this.hoeheAn(x, z), z);
      const zumLicht = this.lage.uL.sub(P);
      const abstand = zumLicht.length(), l = zumLicht.div(abstand), nl = N.dot(l).max(0);
      // Ersatz: die Bilder enthalten Einfallswinkel, Schatten und gebündeltes Licht der aufrechten Lage; gekippt
      // ein schlichter Lichtkegel mit weichem Schatten des Flakons
      const fern = this.lage.uD0.mul(this.lage.uD0).div(abstand.mul(abstand));
      const fuss = vec2(x, z).sub(l.xz.mul(float(0.05).div(l.y.max(0.2)))).length();
      const weich = float(1).sub(smoothstep(0.06, 0.02, vec2(x, z).length().min(fuss)).mul(0.75));
      const schlicht = fern.mul(this.lage.kegelAn(l.negate())).mul(this.lage.uStark).mul(weich).mul(1.4);
      const gebacken = gebackenAn(x, z);
      const bildDiffus = mix(vec3(schlicht.mul(nl)).add(0.01), gebacken, this.uKlar);
      const bildStrahl = mix(schlicht, gebacken.g.div(nl.max(0.25)).min(3.0), this.uKlar);
      if (!this.echt) return { diffus: bildDiffus, strahl: bildStrahl, l, nl };
      const e = this.echt.bestrahlung(x, z, N, falten);
      return { diffus: mix(bildDiffus, e.direkt.add(e.kaustik).add(e.grund), this.uEcht),
        strahl: mix(bildStrahl, e.strahl, this.uEcht), l, nl };
    };
    this.licht = licht;
    /** Skalare Bestrahlung (Mittel der Farbkanäle) — das meldet der Testzugang als tuchLicht */
    this.bestrahlungAn = (x, z) => {
      const d = licht(x, z, this.normalAn(x, z), true).diffus;
      return d.x.add(d.y).add(d.z).div(3);
    };
    // Anisotroper Glanz (GGX): T Fadenrichtung (glatt), Bq quer dazu (breit)
    const glanz = (N, T, H, lh) => {
      const Bq = N.cross(T).normalize();
      const Tt = Bq.cross(N);
      const a = Tt.dot(H).div(this.uRauLaengs), b = Bq.dot(H).div(this.uRauQuer), c = N.dot(H);
      const nenner = a.mul(a).add(b.mul(b)).add(c.mul(c));
      const D = float(1).div(nenner.mul(nenner).mul(this.uRauLaengs).mul(this.uRauQuer).mul(Math.PI));
      return D.div(lh.mul(lh).max(0.05).mul(4));
    };
    const ausblenden = r => smoothstep(0.24, 0.62, r);
    /** Farbe des Tuchs an der Stelle P (Flaschenkoordinaten), gesehen aus Richtung V (zum Auge). genau = false:
     *  für den Blick durch das Glas (ohne Faltenschatten, ohne Umgebungsglanz, ohne Webstruktur). */
    this.farbeAn = (P, V, genau = true) => {
      const x = P.x, z = P.z;
      const N = this.normalAn(x, z);
      const li = licht(x, z, N, genau);
      const nv = N.dot(V).max(0.02);
      // Webstruktur: feine Fäden, nur aus der Nähe und im Streiflicht (die Textur mittelt sich in der Ferne weg)
      const web = genau ? nTex.sample(vec2(x, z).mul(1 / 0.064)).z.sub(0.62).mul(this.uWeb) : float(0);
      const H = li.l.add(V).normalize();
      const lh = li.l.dot(H).max(0);
      // Zwei Fadenlagen: die langen, glatten Kettfäden (x) tragen den Glanz, die Schussfäden (z) wenig
      const spiegel = glanz(N, vec3(1, 0, 0), H, lh).mul(0.75).add(glanz(N, vec3(0, 0, 1), H, lh).mul(0.25));
      const fresnel = float(1).sub(lh).pow(5).mul(0.6).add(0.4);
      const diffus = this.uFarbe.mul(li.diffus).mul(this.uDiffus).mul(web.mul(0.25).add(1));
      const hauptGlanz = this.uGlanzFarbe.mul(spiegel).mul(fresnel).mul(li.strahl).mul(li.nl).mul(this.uGlanz).mul(web.mul(0.9).add(1));
      let farbe = diffus.add(hauptGlanz).mul(this.uGain);
      if (genau) {
        // Softboxen: breite, weiche Spiegelung der Umgebung, zum Streifwinkel hin stärker (Satin), in den Tälern
        // und unter dem Flakon schwächer
        const Rw = this.uR.mul(V.negate().reflect(N));
        const streif = float(1).sub(nv).pow(3).mul(0.85).add(0.15);
        const offen = N.y.mul(N.y).mul(smoothstep(0.02, 0.07, vec2(x, z).length()).mul(0.6).add(0.4));
        const umgebung = pmremTexture(hdr, Rw, float(0.42)).mul(this.uGlanzFarbe).mul(streif).mul(offen).mul(this.uUmgebung)
          .mul(web.mul(0.6).add(1));
        const himmel = pmremTexture(hdr, this.uR.mul(N), float(1.0)).mul(this.uFarbe).mul(offen).mul(1.2);
        farbe = farbe.add(umgebung).add(himmel);
      }
      return mix(farbe, this.uHintergrund, ausblenden(vec2(x, z).length()));
    };

    // ---------- Netz: Gitter über dem Höhenfeld, außen flach weiter ----------
    const geo = new THREE.BufferGeometry();
    const m1 = NETZ + 1, ort = new Float32Array((m1 * m1 + 8) * 3), idx = [];
    for (let j = 0; j < m1; j++) for (let i = 0; i < m1; i++) {
      const x = (i / NETZ - 0.5) * B, z = (j / NETZ - 0.5) * B, k = (j * m1 + i) * 3;
      ort[k] = x; ort[k + 1] = this.hoehe(x, z); ort[k + 2] = z;
    }
    for (let j = 0; j < NETZ; j++) for (let i = 0; i < NETZ; i++) {
      const a = j * m1 + i, b = a + 1, c = a + m1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const ecken = [[-1, -1], [1, -1], [1, 1], [-1, 1]], e0 = m1 * m1;
    ecken.forEach(([sx, sz], k) => {
      ort.set([sx * B / 2, 0, sz * B / 2], (e0 + k) * 3);
      ort.set([sx * FERN, 0, sz * FERN], (e0 + 4 + k) * 3);
    });
    for (let k = 0; k < 4; k++) {
      const q = (k + 1) % 4;
      idx.push(e0 + k, e0 + 4 + k, e0 + q, e0 + q, e0 + 4 + k, e0 + 4 + q);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(ort, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = Fn(() => {
      const kam = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
      return this.farbeAn(positionLocal, kam.sub(positionLocal).normalize(), true);
    })();
    mat.side = THREE.DoubleSide;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'Tuch';
    this.mesh.frustumCulled = false;

    // ---------- Abfrage der Bestrahlung für den Testzugang (dieselbe Rechnung wie im Bild) ----------
    this.karte = null;
    this.kartePixel = 512;
    this.karteBreite = 0.32;
  }

  /** Höhe des Tuchs (m) an der Stelle (x, z) in Flaschenkoordinaten; außerhalb des Höhenfelds 0. */
  hoehe(x, z) {
    const n = this.n, u = (x / this.breite + 0.5) * n - 0.5, v = (z / this.breite + 0.5) * n - 0.5;
    if (!(u > -1 && v > -1 && u < n && v < n)) return 0;
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const an = (a, b) => this.h[Math.min(n - 1, Math.max(0, b)) * n + Math.min(n - 1, Math.max(0, a))];
    return (an(i, j) * (1 - fu) + an(i + 1, j) * fu) * (1 - fv) + (an(i, j + 1) * (1 - fu) + an(i + 1, j + 1) * fu) * fv;
  }

  /** Echtzeit-Licht einschalten (nur WebGPU): Strahlen durch den Flakon auf das Höhenfeld */
  starteEchtzeit(renderer, glas, glasGeo, raster, pixel) {
    this.renderer = renderer;
    this.echt = new EchtzeitLicht(renderer, glas, glasGeo, this, this.lage, raster, pixel);
    this.uEcht.value = 1;
  }

  /** Je Bild: Drehung (für die Wahl der zwei Lichtbilder), Neigung, Lage des Lichts zur Flasche. */
  setze(gier, neigung, glas) {
    const w = ((gier * 180 / Math.PI) % 360 + 360) % 360;
    const i = Math.floor(w / 45) % 8, j = (i + 1) % 8;
    if (i !== this.index) {
      this.a.value = this.bilder[i];
      this.b.value = this.bilder[j];
      this.index = i;
    }
    this.uMisch.value = (w % 45) / 45;
    const grad = neigung * 180 / Math.PI;
    this.uKlar.value = THREE.MathUtils.clamp((14 - grad) / 6, 0, 1);
    this.lage.aktualisiere(glas.uRT.value);
  }

  /** Bestrahlung an der Stelle (x, z) aus der aktuellen Lichtrechnung (Einfallswinkel, Schatten, gebündeltes Licht):
   *  die Formel des Bildes wird in eine kleine Karte gezeichnet und ausgelesen; neu nur, wenn das Licht neu
   *  gerechnet wurde. */
  async bestrahlung(x, z) {
    if (!this.echt || !this.echt.aktiv) return null;
    const r = this.renderer, px = this.kartePixel, W = this.karteBreite;
    if (!this.karte) {
      const ziel = new THREE.RenderTarget(px, px, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false,
        samples: 0, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      const m = new THREE.NodeMaterial();
      m.fragmentNode = Fn(() => {
        const q = uv().sub(0.5).mul(W);
        return vec4(vec3(this.bestrahlungAn(q.x, q.y)), 1);
      })();
      m.depthTest = m.depthWrite = false;
      this.karte = { ziel, quad: new THREE.QuadMesh(m), stand: -1, zeit: 0, werte: null, laeuft: null };
    }
    const k = this.karte, jetzt = performance.now();
    if (k.stand !== this.echt.zaehler && jetzt - k.zeit > 150 || !k.werte) {
      if (!k.laeuft) {
        k.laeuft = (async () => {
          const stand = this.echt.zaehler;
          const alt = r.getRenderTarget(), ton = r.toneMapping;
          r.toneMapping = THREE.NoToneMapping;
          r.setRenderTarget(k.ziel);
          k.quad.render(r);
          r.setRenderTarget(alt);
          r.toneMapping = ton;
          const roh = await r.readRenderTargetPixelsAsync(k.ziel, 0, 0, px, px);
          k.werte = roh; k.stand = stand; k.zeit = performance.now(); k.laeuft = null;
        })();
      }
      await k.laeuft;
    }
    // bilinear aus der Karte (Zeile v = z, Spalte u = x)
    const u = (x / W + 0.5) * px - 0.5, v = (z / W + 0.5) * px - 0.5;
    if (!(u >= 0 && v >= 0 && u <= px - 1 && v <= px - 1)) return 0;
    const i = Math.min(px - 2, Math.floor(u)), j = Math.min(px - 2, Math.floor(v)), fu = u - i, fv = v - j;
    const an = (a, b) => this.karte.werte[(b * px + a) * 4];
    return (an(i, j) * (1 - fu) + an(i + 1, j) * fu) * (1 - fv) + (an(i, j + 1) * (1 - fu) + an(i + 1, j + 1) * fu) * fv;
  }
}
