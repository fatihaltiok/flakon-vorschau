import * as THREE from 'three';
import { GLTFLoader } from './lib/GLTFLoader.js';

// Die eigenen Module werden erst in main() geladen: fehlt eines (kaputte Auslieferung), landet der Fehler im Fang
// unten und die Seite zeigt einen Satz statt einer endlosen Ladeanzeige (Gegenprüfung T2n, Befund 1).
let VolumenTabelle, Schwappmodell, DT, qVonWinkel, qMal, winkelableitung, ladeHDR, baueAussehen, ENV_DREHUNG_Y, baueGlaettung;
async function ladeModule() {
  const [v, s, h, a, g, k] = await Promise.all([import('./volumen.js'), import('./schwappen.js'), import('./hdr.js'),
    import('./aussehen.js'), import('./glas.js'), import('./glaettung.js')]);
  ({ VolumenTabelle } = v);
  ({ Schwappmodell, DT, qVonWinkel, qMal, winkelableitung } = s);
  ({ ladeHDR } = h); ({ baueAussehen } = a); ({ ENV_DREHUNG_Y } = g); ({ baueGlaettung } = k);
}

/** Volumen-Tabelle in einem Arbeiter-Thread bauen (volumen.js selbst bleibt unverändert); die Seite bleibt dabei
 *  bedienbar und lädt weiter (Gegenprüfung T2n, Befund 3). Geht das nicht, wird wie bisher an Ort und Stelle gebaut. */
function baueTabelle(feldDaten, hoehlung, fuellung) {
  return new Promise(fertig => {
    const ersatz = () => fertig(new VolumenTabelle(feldDaten, hoehlung, fuellung));
    let arbeiter;
    try {
      arbeiter = new Worker(new URL('./volumen-arbeiter.js', import.meta.url), { type: 'module' });
    } catch (_) { ersatz(); return; }
    arbeiter.onmessage = e => {
      arbeiter.terminate();
      if (!e.data || !e.data.tabelle) { ersatz(); return; }
      // Gleiche Klasse, gleiche Abfragen — nur die Felder kommen fertig gerechnet aus dem Arbeiter
      fertig(Object.assign(Object.create(VolumenTabelle.prototype), e.data.tabelle));
    };
    arbeiter.onerror = () => { arbeiter.terminate(); ersatz(); };
    arbeiter.postMessage({ feld: feldDaten, hoehlung, fuellung });
  });
}

const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');
const lade = document.querySelector('#lade');
const params = new URLSearchParams(location.search);
let modell, gruppe, aussehen, renderer, szene, kamera;
let winkelX = 0, winkelZ = 0, gier = 0, zielX = 0, zielZ = 0, federX = 0, federZ = 0;
let gehalten = false, ziehen = false, geste = '', letzteX = 0, letzteY = 0, startX = 0, startY = 0;
let gierTempo = 0, gierSchwung = 0, letzteZeit = 0, letzteBewegung = 0;
let qAlt = [0, 0, 0, 1], omegaAlt = [0, 0, 0], gerechnet = 0;
let pixelDichte = 1, dichteAbzug = 0, sparstufe = 0, ausgabe = null;
// Echtzeit-Licht auf dem Tuch (§6.9, §6.10): lichtTakt 1 = jedes Bild, 2 = jedes zweite; lichtStufe 0 voll, 1 klein, 2 aus
let lichtTakt = 1, lichtStufe = 0, bildNr = 0;
// Zoom der Kamera (1 bis 3): ein Ausschnitt des vollen Bildes; zoomX/zoomY = linke obere Ecke des Ausschnitts (0..1)
let zoom = 1, zoomX = 0, zoomY = 0;
let flakonAn = true, etikettAn = true;
const finger = new Map();
let pinch = null, tippZeit = 0, tippX = 0, tippY = 0, druckZeit = 0, druckWeg = 0;
let bereitAufloesen, bereitAblehnen;
const bereit = new Promise((l, a) => { bereitAufloesen = l; bereitAblehnen = a; });

function qAktuell() {
  const qy = [0, Math.sin(gier / 2), 0, Math.cos(gier / 2)];
  return qMal(qVonWinkel(winkelX, winkelZ), qy);
}

function aktualisiere() {
  const q = modell.q;
  gruppe.quaternion.set(q[0], q[1], q[2], q[3]);
  aussehen.glas.aktualisiere(modell, kamera.position);
  aussehen.tuch.setze(gier, Math.hypot(winkelX, winkelZ), aussehen.glas);
  if (lichtAn()) aussehen.tuch.echt.aktualisiere(aussehen.glas);
}

function lichtAn() {
  return !!(aussehen && aussehen.tuch.echt && aussehen.tuch.echt.aktiv);
}

function lichtAus() {
  if (!lichtAn()) return;
  aussehen.tuch.uEcht.value = 0;       // ab jetzt wieder die LuxCore-Bilder
  aussehen.tuch.echt.aktiv = false;    // nicht mehr rechnen; die Lichttextur bleibt (der Shader kennt sie noch)
}

function schrittMitBewegung() {
  const q = qAktuell();
  const omega = winkelableitung(qAlt, q, DT);
  const alpha = [(omega[0] - omegaAlt[0]) / DT, (omega[1] - omegaAlt[1]) / DT, (omega[2] - omegaAlt[2]) / DT];
  omegaAlt = omega; qAlt = q;
  modell.schritt(DT, q, omega, alpha);
}

const kontroller = {
  bereit,
  parameter: () => modell.parameter(),
  gerechneteZeit: () => gerechnet,
  backend: () => renderer.backend.isWebGPUBackend === true ? 'webgpu' : 'webgl',
  gierGrad: () => gier * 180 / Math.PI,
  halteLage(gx, gz, g = 0) {
    gehalten = true; ziehen = false;
    winkelX = gx * Math.PI / 180; winkelZ = gz * Math.PI / 180; gier = g * Math.PI / 180;
    federX = federZ = gierSchwung = gierTempo = 0;
    qAlt = qAktuell(); omegaAlt = [0, 0, 0];
    modell.setzeLage(qAlt);
    aktualisiere();
  },
  async schritt(n) {
    const q = qAktuell();
    for (let i = 0; i < n; i++) modell.schritt(DT, q, [0, 0, 0], [0, 0, 0]);
    aktualisiere();
  },
  async fahreNeigung(achse, grad, sekunden) {
    if (!['x', 'z'].includes(achse) || !Number.isFinite(grad) || !(sekunden > 0)) throw new Error('Ungültige Neigungsfahrt');
    gehalten = true;
    federX = federZ = gierSchwung = 0;
    const startx = winkelX, startz = winkelZ;
    const zielx = achse === 'x' ? grad * Math.PI / 180 : winkelX;
    const zielz = achse === 'z' ? grad * Math.PI / 180 : winkelZ;
    const n = Math.max(2, Math.round(sekunden / DT));
    qAlt = qAktuell(); omegaAlt = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n, weg = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2;
      winkelX = startx + (zielx - startx) * weg;
      winkelZ = startz + (zielz - startz) * weg;
      schrittMitBewegung();
    }
    schrittMitBewegung();
    omegaAlt = [0, 0, 0];
    aktualisiere();
  },
  oberflaecheY: xz => modell.oberflaecheY(xz),
  neigungGrad: () => Math.hypot(winkelX, winkelZ) * 180 / Math.PI,
  zeigeFluessigkeit(an) { aussehen.glas.uFluessig.value = an ? 1 : 0; },
  zeigeEtikett(an) { etikettAn = !!an; aussehen.etikett.visible = etikettAn && flakonAn; aussehen.glas.uEtikett.value = an ? 1 : 0; },
  tellerLicht: () => lichtAn() ? 'echtzeit' : 'bilder',
  lichtBild: () => lichtAn() ? aussehen.tuch.echt.lies() : null,   // nur für Eichung und Sichtung
  unterlage: () => 'tuch',
  tuchHoehe: (x, z) => aussehen.tuch.hoehe(x, z),
  tuchLicht: (x, z) => lichtAn() ? aussehen.tuch.bestrahlung(x, z) : null,
  // nur für Eichung: Werte des Tuch-Materials setzen
  tuchWerte(w) {
    for (const [n, v] of Object.entries(w)) {
      const u = aussehen.tuch[n];
      if (u.value && u.value.isColor) u.value.set(v);
      else if (u.value && u.value.fromArray) u.value.fromArray(v);
      else u.value = v;
    }
  },
  lichtStufe(n) { if (n >= 2) { lichtStufe = 2; lichtAus(); } else if (n === 1 && lichtAn()) lichtKlein(); },   // nur für Sichtung: Stufen der Selbstanpassung
  lichtWerte(w) { if (lichtAn()) for (const [n, v] of Object.entries(w)) aussehen.tuch.echt[n].value = v; },
  // Nur das Zeichnen des Flakons aus/ein; das Licht auf dem Tuch wird weiter gerechnet, als wäre er da
  zeigeFlakon(an) {
    flakonAn = !!an;
    aussehen.glasMesh.visible = flakonAn;
    aussehen.verschluss.visible = flakonAn;
    aussehen.etikett.visible = flakonAn && etikettAn;
    aussehen.blasen.visible = flakonAn && sparstufe === 0;
  },
  zoom: () => zoom,
  setzeZoom(z, fx = 0.5, fy = 0.5) { setzeZoom(z, fx, fy, fx, fy); },
  loslassen() {
    gehalten = false;
    zielX = zielZ = 0;
    gierSchwung = 0;
  },
};

/** Zoom z um die Bildstelle (bx, by) des vollen Bildes, die an der Fensterstelle (fx, fy) liegen soll (alles 0..1). */
function setzeZoom(z, bx, by, fx, fy) {
  zoom = THREE.MathUtils.clamp(z, 1, 3);
  const teil = 1 / zoom;
  zoomX = THREE.MathUtils.clamp(bx - fx * teil, 0, 1 - teil);
  zoomY = THREE.MathUtils.clamp(by - fy * teil, 0, 1 - teil);
  sichtfeld();
}

function sichtfeld() {
  const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  if (zoom > 1.0005) kamera.setViewOffset(w, h, zoomX * w, zoomY * h, w / zoom, h / zoom);
  else { kamera.clearViewOffset(); kamera.aspect = w / h; }
  kamera.updateProjectionMatrix();
}

function resize() {
  const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  // Zoomt der Nutzer die ganze Seite, wird entsprechend feiner gezeichnet — innerhalb der Pixelgrenze (§6.4, §6.8)
  const seitenzoom = Math.max(1, window.visualViewport ? visualViewport.scale : 1);
  const grenze = Math.sqrt(2.1e6 / (w * h));
  const hoechst = Math.min(Math.min(devicePixelRatio || 1, 2) * seitenzoom, grenze) * 0.999;
  pixelDichte = Math.max(Math.min(1, hoechst), hoechst - dichteAbzug);
  renderer.setPixelRatio(pixelDichte);
  renderer.setSize(w, h, false);
  sichtfeld();
}

function fensterStelle(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / Math.max(1, r.width), (e.clientY - r.top) / Math.max(1, r.height)];
}

function pinchStart() {
  const [a, b] = [...finger.values()];
  const [fx, fy] = fensterStelle({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
  pinch = { abstand: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), zoom, bx: zoomX + fx / zoom, by: zoomY + fy / zoom };
  // Zwei Finger zoomen nur: laufende Dreh- oder Kippgeste beenden, die Flasche federt zurück
  geste = 'zoom'; zielX = zielZ = 0; gierTempo = 0;
}

function zeiger() {
  canvas.addEventListener('pointerdown', e => {
    finger.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* Zeiger schon weg */ }
    if (finger.size === 2) { ziehen = true; pinchStart(); return; }
    if (finger.size > 2) return;
    druckZeit = performance.now(); druckWeg = 0;
    startX = letzteX = e.clientX; startY = letzteY = e.clientY;
    if (gehalten) return;
    ziehen = true; geste = '';
    letzteZeit = letzteBewegung = performance.now();
    gierTempo = gierSchwung = 0;
  });
  canvas.addEventListener('pointermove', e => {
    const f = finger.get(e.pointerId);
    // Nur Zeiger, die auf der Fläche gedrückt wurden und noch gedrückt sind, bewegen etwas: eine Maus, die ohne
    // Taste über das Fenster streicht (auch während einer anderen Geste), zählt nicht mit
    if (!f || (e.pointerType === 'mouse' && e.buttons === 0)) return;
    f.x = e.clientX; f.y = e.clientY;
    if (pinch && finger.size >= 2) {
      const [a, b] = [...finger.values()];
      const [fx, fy] = fensterStelle({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      setzeZoom(pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.abstand, pinch.bx, pinch.by, fx, fy);
      return;
    }
    druckWeg = Math.max(druckWeg, Math.hypot(e.clientX - startX, e.clientY - startY));
    if (!ziehen || gehalten || geste === 'zoom') return;
    const jetzt = performance.now(), dx = e.clientX - letzteX, dy = e.clientY - letzteY;
    if (!geste && Math.hypot(e.clientX - startX, e.clientY - startY) >= 12) {
      geste = Math.abs(e.clientX - startX) > 1.5 * Math.abs(e.clientY - startY) ? 'drehen' : 'kippen';
    }
    if (geste === 'drehen') {
      const schritt = dx * 0.006;
      gier += schritt;
      const dt = Math.max(0.008, (jetzt - letzteZeit) / 1000);
      gierTempo = 0.65 * gierTempo + 0.35 * schritt / dt;
      letzteBewegung = jetzt;
    } else if (geste === 'kippen') {
      zielZ = THREE.MathUtils.clamp(zielZ - dx * 0.0018, -0.8, 0.8);
      zielX = THREE.MathUtils.clamp(zielX + dy * 0.0018, -0.8, 0.8);
    }
    letzteX = e.clientX; letzteY = e.clientY; letzteZeit = jetzt;
  });
  const ende = e => {
    const dabei = finger.delete(e.pointerId);
    if (pinch) {
      // Nach dem Zoomen erst alle Finger heben, dann beginnt eine neue Geste
      if (finger.size < 2) pinch = null;
      if (finger.size === 0) ziehen = false;
      zielX = zielZ = 0;
      return;
    }
    if (geste === 'zoom') { if (finger.size === 0) ziehen = false; return; }
    // Doppeltipp / Doppelklick: Zoom zurück auf 1
    const jetzt = performance.now();
    if (dabei && e.type === 'pointerup' && druckWeg < 10 && jetzt - druckZeit < 300) {
      if (jetzt - tippZeit < 400 && Math.hypot(e.clientX - tippX, e.clientY - tippY) < 40) {
        setzeZoom(1, 0.5, 0.5, 0.5, 0.5);
        tippZeit = 0;
      } else { tippZeit = jetzt; tippX = e.clientX; tippY = e.clientY; }
    }
    if (!ziehen) return;
    ziehen = false;
    if (geste === 'drehen' && performance.now() - letzteBewegung < 150) {
      gierSchwung = THREE.MathUtils.clamp(gierTempo, -5, 5);
    }
    zielX = zielZ = 0;
  };
  canvas.addEventListener('pointerup', ende);
  canvas.addEventListener('pointercancel', ende);
  // Geht das Loslassen verloren (die Zeiger-Bindung endet ohne pointerup), endet die Geste trotzdem und die
  // Flasche federt zurück
  canvas.addEventListener('lostpointercapture', e => { if (finger.has(e.pointerId)) ende(e); });
  // Strg + Mausrad und Trackpad-Pinch (meldet Chrome als Rad mit Strg) zoomen die Kamera, nicht die Seite
  canvas.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const [fx, fy] = fensterStelle(e);
    const schritt = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    setzeZoom(zoom * Math.exp(-schritt * 0.01), zoomX + fx / zoom, zoomY + fy / zoom, fx, fy);
  }, { passive: false });
  addEventListener('resize', resize);
  if (window.visualViewport) visualViewport.addEventListener('resize', resize);
}

// Selbstanpassung (§6.4, §6.9): erst die Auflösung stufenweise bis Pixel-Dichte 1, dann das Echtzeit-Licht klein
// (Raster 128, jedes zweite Bild), dann die teuren Wirkungen: Stufe 1 Bläschen und Marschschritte, Stufe 2
// Oberflächenstruktur und Nebenstrahlen des Glases, Stufe 3 Nachglättung; zuletzt das Echtzeit-Licht aus (Bilder).
function fpsAnpassen(schnitt) {
  if (schnitt >= 45) return;
  if (pixelDichte > 1.01) {
    dichteAbzug += 0.2;
    resize();
  } else if (lichtAn() && lichtStufe === 0) {
    lichtKlein();
  } else if (sparstufe === 0) {
    sparstufe = 1;
    aussehen.blasen.visible = false;
    aussehen.glas.uSchritte.value = 16;   // gröbere Brechung: weniger Marschschritte je Strahl
  } else if (sparstufe === 1) {
    sparstufe = 2;
    aussehen.glas.uFein.value = 0;
  } else if (sparstufe === 2) {
    sparstufe = 3;
    ausgabe = null;                       // ohne Nachglättung direkt zeichnen (MSAA bleibt)
  } else if (lichtAn()) {
    lichtStufe = 2;
    lichtAus();                           // letzte Stufe: Licht auf dem Tuch wieder aus den LuxCore-Bildern
  }
}

// Handy-Stufe des Echtzeit-Lichts (§6.9): Raster 128 × 128 und nur jedes zweite Bild neu
function lichtKlein() {
  lichtStufe = 1;
  lichtTakt = 2;
  const echt = aussehen.tuch.echt;
  if (echt.raster > 128) echt.setzeRaster(128);
  echt.uMisch.value = 0.7;
}

function zeichne() {
  if (lichtAn() && bildNr++ % lichtTakt === 0) aussehen.tuch.echt.rechne();
  if (ausgabe) ausgabe.render();
  else renderer.render(szene, kamera);
}

async function main() {
  await ladeModule();
  if (params.has('test')) {
    const { testeZugang } = await import('./testzugang.js');
    testeZugang(kontroller);
  }
  renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: params.has('webgl') });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  await renderer.init();
  szene = new THREE.Scene();
  szene.background = new THREE.Color(0x141418);
  if (status) status.textContent = 'Modell, Feld und Aussehen werden geladen …';
  const loader = new GLTFLoader();
  const [gltf, glasGltf, beschreibung, meta, feld, hdr] = await Promise.all([
    loader.loadAsync('./modell/flakon.glb'), loader.loadAsync('./aussehen/glas.glb'),
    fetch('./modell/flakon.json').then(r => r.json()), fetch('./aussehen/aussehen.json').then(r => r.json()),
    fetch('./modell/hoehlung_sdf.bin').then(r => r.arrayBuffer()), ladeHDR('./aussehen/umgebung.hdr'),
  ]);
  szene.environment = hdr;
  szene.environmentIntensity = 1.0;
  szene.environmentRotation.set(0, ENV_DREHUNG_Y, 0);
  const k = meta.kamera;
  const fov = 2 * Math.atan(k.sensor_mm / (2 * k.linse_mm)) * 180 / Math.PI;
  kamera = new THREE.PerspectiveCamera(fov, 0.8, 0.001, 3);
  kamera.position.fromArray(k.position);
  kamera.lookAt(new THREE.Vector3().fromArray(k.ziel));
  // Alles Licht kommt aus der HDR-Umgebung; der Spot der Szene steckt im Glas-Shader (glas.js SPOT_RICHTUNG)
  // und im Licht auf dem Tuch (tuch.js, tellerlicht.js).
  gruppe = new THREE.Group();
  szene.add(gruppe);
  const feldDaten = new Float32Array(feld);
  if (status) status.textContent = 'Volumen-Tabelle wird aufgebaut …';
  const tabelleKommt = baueTabelle(feldDaten, beschreibung.hoehlung, beschreibung.fuellung);
  const webgpu = renderer.backend.isWebGPUBackend === true;
  // Abstandsfeld als 16-Bit-Textur, wo 32-Bit nicht linear filterbar ist (Gegenprüfung T2n, Befund 4); ?feld16 erzwingt es
  const halb = params.has('feld16') || (webgpu ? !renderer.hasFeature('float32-filterable')
    : !renderer.backend.gl.getExtension('OES_texture_float_linear'));
  // Echtzeit-Licht nur mit Rechenshadern (WebGPU); am Handy gleich in der kleinen Stufe
  const handy = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
  const aussehenNeu = await baueAussehen(gruppe, gltf, glasGltf, meta, szene, feldDaten, hdr,
    { renderer, raster: webgpu && !params.has('bilder') ? (Number(params.get('raster')) || (handy ? 128 : 256)) : 0,
      pixel: Number(params.get('lichtpx')) || (handy ? 768 : 1024), halb, flach: params.has('flach') });
  // Während der Arbeiter die Tabelle rechnet: die Shader in Portionen vorbereiten (erst das Tellerlicht, dann die
  // Szene), damit das erste Bild die Seite nicht am Stück blockiert (Gegenprüfung T2n, Befund 3)
  const pause = () => new Promise(r => setTimeout(r, 0));
  await pause();
  if (aussehenNeu.tuch.echt) {
    aussehenNeu.tuch.echt.aktualisiere(aussehenNeu.glas);
    aussehenNeu.tuch.echt.rechne();
    await pause();
  }
  resize();
  await renderer.compileAsync(szene, kamera);
  await pause();
  const tabelle = await tabelleKommt;
  modell = new Schwappmodell(beschreibung, tabelle);
  modell.regler(50, 50);
  aussehen = aussehenNeu;
  if (lichtAn() && handy) lichtKlein();
  aktualisiere();

  for (const e of document.querySelectorAll('input[type=range][data-regler]')) {
    e.addEventListener('input', () => {
      modell.regler(Number(document.querySelector('[data-regler="staerke"]').value),
        Number(document.querySelector('[data-regler="nachklingen"]').value));
    });
  }
  zeiger();
  resize();
  qAlt = qAktuell();
  ausgabe = baueGlaettung(renderer, szene, kamera);
  zeichne();
  if (status) status.textContent = `${(tabelle.bezug / 1000).toFixed(1).replace('.', ',')} ml · ${modell.f1.toFixed(2).replace('.', ',')} Hz · 240 Schritte/s`;
  if (lade) lade.hidden = true;
  document.documentElement.dataset.flakon = 'bereit';
  bereitAufloesen();

  let vorher = performance.now(), rest = 0, fpsStart = vorher, fpsBilder = 0;
  function bild(jetzt) {
    const vergangen = Math.min(0.05, (jetzt - vorher) / 1000);
    vorher = jetzt;
    if (!gehalten) {
      rest = Math.min(0.05, rest + vergangen);
      const schritte = Math.floor(rest / DT);
      if (schritte > 0) {
        rest -= schritte * DT;
        for (let i = 0; i < schritte; i++) {
          if (gierSchwung !== 0) {
            gier += gierSchwung * DT;
            gierSchwung *= Math.exp(-DT / 0.34);
            if (Math.abs(gierSchwung) < 0.02) gierSchwung = 0;
          }
          federX += (85 * (zielX - winkelX) - 13 * federX) * DT;
          federZ += (85 * (zielZ - winkelZ) - 13 * federZ) * DT;
          winkelX += federX * DT;
          winkelZ += federZ * DT;
          schrittMitBewegung();
        }
        gerechnet += schritte * DT;
      }
      fpsBilder++;
      if (jetzt - fpsStart >= 2000) {
        fpsAnpassen(fpsBilder * 1000 / (jetzt - fpsStart));
        fpsStart = jetzt; fpsBilder = 0;
      }
    } else {
      fpsStart = jetzt; fpsBilder = 0;
    }
    aktualisiere();
    zeichne();
    requestAnimationFrame(bild);
  }
  requestAnimationFrame(bild);
}

main().catch(fehler => {
  const ziel = status || document.querySelector('#fehler');
  if (ziel) {
    ziel.hidden = false;
    ziel.textContent = `Die 3D-Ansicht konnte nicht geladen werden: ${fehler.message}`;
  }
  if (lade) lade.hidden = true;
  document.documentElement.dataset.flakon = 'fehler';
  bereitAblehnen(fehler);
  throw fehler;
});
