import * as THREE from 'three/webgpu';
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

/** Adresse einer Datei neben diesem Modul: nichts wird relativ zur einbettenden Seite geladen (Vertrag §7.1) */
const hier = pfad => new URL(pfad, import.meta.url).href;

/** Zeichenflächen, auf denen der Flakon schon läuft: ein zweiter Start auf derselben Fläche wird abgelehnt (E-030) */
const belegt = new WeakSet();

/**
 * Startet den Flakon auf der Zeichenfläche `canvas` (Vertrag §7.1). Der Import dieses Moduls allein tut nichts.
 * optionen: { status?, lade?, fehler?, regler?: { staerke, nachklingen } } — HTML-Elemente der Seite; fehlt eines,
 * entfällt es. Erfüllt sich nach dem ersten gezeichneten Bild mit { sichtbar(ja) }; lehnt bei jedem Ladefehler ab.
 */
export async function starte(canvas, optionen = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    document.documentElement.dataset.flakon = 'fehler';
    throw new TypeError('starte(canvas): die Zeichenfläche fehlt');
  }
  if (belegt.has(canvas)) throw new Error('starte(canvas): auf dieser Zeichenfläche läuft der Flakon schon');
  belegt.add(canvas);
  canvas.style.touchAction = 'none';   // senkrecht ziehen kippt, auch ohne Stylesheet der Seite (Vertrag §6.3, E-030)
  const status = optionen.status || null, lade = optionen.lade || null, fehlerFeld = optionen.fehler || null;
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
  let flakonAn = true, etikettAn = true, verschlussAn = true;
  // Lage der Flasche (Vertrag §6.11): Welt = T(k)·R·T(−k)·Ry(gier)·Flasche = R·Ry(gier)·Flasche + versatz mit
  // versatz = k − R·k; k ist der Punkt der Standkante (Radius 32,5 mm), zu dem die Flasche hinkippt. Das Tuch liegt fest.
  const STAND_R = 0.0325;
  const versatz = new THREE.Vector3();
  // Kippgrenze: gemessen an allen Ecken des Glases gegen das Höhenfeld des Tuchs (alle Richtungen, alle Drehlagen).
  // Das Tuch selbst berührt die gekippte Flasche bis 60° nirgends. Die Lage-Formel (R = Rz·Rx) verdreht die Flasche
  // bei schrägen Kipprichtungen aber leicht um ihre Achse; die Standkante sinkt dort etwas unter die Ebene des Tuchs:
  // bei 30° höchstens 0,04 mm, bei 42° 0,24 mm, bei 48° 0,48 mm, bei 49° 0,54 mm (erlaubt: 0,5 mm). Finger und
  // Maus kippen deshalb weich begrenzt bis 40° (ab 36° läuft die Neigung ohne Ruck gegen die Grenze; mit dem
  // Überschwingen des Federzugs unter 42°), halteLage und fahreNeigung höchstens 48°.
  const KIPP_GRENZE = 40 * Math.PI / 180, KIPP_KNIE = 4 * Math.PI / 180, KIPP_HART = 48 * Math.PI / 180;
  let rohX = 0, rohZ = 0;      // ungebremstes Ziel der Kippgeste
  // Eigendrehung (§6.11): eine Umdrehung in 30 s nach der Uhrzeit; ruht in jeder Geste, setzt 2,5 s nach dem Loslassen
  // und dem Auslaufen des Schwungs wieder ein und läuft in 1,2 s weich an. Mit ?test aus, bis eigendrehung(true);
  // bei „Bewegung reduzieren“ immer aus.
  const EIGEN_TEMPO = 2 * Math.PI / 30, EIGEN_PAUSE = 2500, EIGEN_ANLAUF = 1200;
  const wenigBewegung = matchMedia('(prefers-reduced-motion: reduce)');
  let eigenGewollt = !params.has('test'), eigenAb = -1e9, eigenRest = 0;
  const eigenAn = () => eigenGewollt && !wenigBewegung.matches;
  /** Jede Geste (Drehen, Kippen, Zoomen) hält die Eigendrehung an; die Pause zählt ab dem letzten Aufruf. */
  function eigenRuhe() { eigenAb = performance.now() + EIGEN_PAUSE; }
  const finger = new Map();
  let pinch = null, tippZeit = 0, tippX = 0, tippY = 0, druckZeit = 0, druckWeg = 0;
  let bereitAufloesen, bereitAblehnen;
  const bereit = new Promise((l, a) => { bereitAufloesen = l; bereitAblehnen = a; });
  bereit.catch(() => {});      // den Fehler meldet starte() selbst (Ablehnung); hier nur für den Testzugang
  // Bildschleife (Vertrag §7.1): sicht = die Seite will Bilder (sichtbar(ja)); laeuft = requestAnimationFrame ist bestellt;
  // schleife = die Bildfunktion, sobald das erste Bild steht; verloren = Gerät oder Zeichenkontext sind weg
  let sicht = true, laeuft = false, rafNr = 0, schleife = null, verloren = false, pauseAb = 0;
  let vorher = 0, rest = 0, fpsStart = 0, fpsBilder = 0;
  let flaecheB = 0, flaecheH = 0;

  function schleifeAn() {
    if (laeuft || !sicht || verloren || !schleife) return;
    laeuft = true;
    rafNr = requestAnimationFrame(schleife);
  }

  /** Hält die eigene Bildschleife an und die von three.js: der WebGPURenderer bestellt ab dem ersten render() selbst
   *  jedes Bild ein requestAnimationFrame (renderer._animation); das nächste render() startet sie wieder. */
  function schleifeAus() {
    laeuft = false;
    cancelAnimationFrame(rafNr);
    if (renderer && renderer._animation) renderer._animation.stop();
  }

  /** Steuerung durch die einbettende Seite (§7.1): ohne Sicht keine Bilder, kein Licht, keine Physik; die Uhr der
   *  Eigendrehung steht so lange. Danach geht es ohne Sprung weiter, die Pause zählt nicht als langsame Bilder. */
  function sichtbar(ja) {
    ja = !!ja;
    if (ja === sicht) return;
    sicht = ja;
    if (!schleife || verloren) return;         // vor dem ersten Bild: main() startet die Schleife nur mit Sicht
    if (!sicht) { pauseAb = performance.now(); schleifeAus(); return; }
    const jetzt = performance.now();
    eigenAb += jetzt - pauseAb;
    vorher = fpsStart = jetzt; fpsBilder = 0;
    aktualisiere();
    zeichne();                                 // gleich ein Bild (die Größe kann sich in der Pause geändert haben)
    schleifeAn();
  }

  function zeigeFehler(satz) {
    const ziel = status || fehlerFeld;
    if (ziel) { ziel.hidden = false; ziel.textContent = satz; }
    if (lade) lade.hidden = true;
    document.documentElement.dataset.flakon = 'fehler';
  }

  /** Gerät (WebGPU) oder Zeichenkontext (WebGL) verloren: Schluss mit Zeichnen, die Seite zeigt ihr Ersatzbild (§7.1) */
  function verlust(info) {
    if (verloren) return;
    verloren = true;
    schleifeAus();
    zeigeFehler('Die 3D-Ansicht wurde unterbrochen (Grafikgerät verloren).');
    canvas.dispatchEvent(new CustomEvent('flakonfehler', { detail: { grund: 'geraeteverlust', api: info && info.api || '',
      meldung: info && info.message || '' } }));
  }

  function qAktuell() {
    const qy = [0, Math.sin(gier / 2), 0, Math.cos(gier / 2)];
    return qMal(qVonWinkel(winkelX, winkelZ), qy);
  }

  /** Wirkliche Neigung der Flaschenachse gegen die Senkrechte bei den Winkeln (x, z): R = Rz·Rx, cos = cos x · cos z */
  const neigungVon = (x, z) => Math.acos(THREE.MathUtils.clamp(Math.cos(x) * Math.cos(z), -1, 1));

  /** Verkleinert die Winkel (x, z) so, dass die Neigung höchstens `grenze` ist; knie > 0: weicher Übergang, die
   *  Neigung läuft ab grenze − knie ohne Knick gegen die Grenze. Liefert [x, z]. */
  function begrenzeNeigung(x, z, grenze, knie = 0) {
    const m = neigungVon(x, z);
    if (m <= grenze - knie) return [x, z];
    const ziel = knie > 0 ? grenze - knie * Math.exp(-(m - (grenze - knie)) / knie) : grenze;
    let f = ziel / m;
    for (let i = 0; i < 4; i++) f *= ziel / Math.max(1e-9, neigungVon(x * f, z * f));
    return [x * f, z * f];
  }

  /** Verschiebung der Flasche aus der Kipp-Drehung: der Punkt der Standkante in Kipprichtung bleibt liegen (§6.11). */
  const _qKipp = new THREE.Quaternion(), _auf = new THREE.Vector3(), _k = new THREE.Vector3(), _rk = new THREE.Vector3();
  function setzeVersatz() {
    const q = qVonWinkel(winkelX, winkelZ);
    _qKipp.set(q[0], q[1], q[2], q[3]);
    _auf.set(0, 1, 0).applyQuaternion(_qKipp);
    const w = Math.hypot(_auf.x, _auf.z);
    if (w < 1e-9) { versatz.set(0, 0, 0); return; }
    _k.set(_auf.x / w * STAND_R, 0, _auf.z / w * STAND_R);
    versatz.copy(_k).sub(_rk.copy(_k).applyQuaternion(_qKipp));
  }

  function aktualisiere() {
    const q = modell.q;
    setzeVersatz();
    gruppe.quaternion.set(q[0], q[1], q[2], q[3]);
    gruppe.position.copy(versatz);
    aussehen.glas.aktualisiere(modell, kamera.position, versatz);
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
      // Lage nach §6.11 (Drehpunkt an der Standkante); über 48° Neigung tauchte die Standkante ins Tuch, dort ist Schluss
      [winkelX, winkelZ] = begrenzeNeigung(gx * Math.PI / 180, gz * Math.PI / 180, KIPP_HART);
      gier = g * Math.PI / 180;
      rohX = rohZ = zielX = zielZ = 0;
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
      const [zielx, zielz] = begrenzeNeigung(achse === 'x' ? grad * Math.PI / 180 : winkelX,
        achse === 'z' ? grad * Math.PI / 180 : winkelZ, KIPP_HART);
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
    // Weg des Lichts (§6.12): Rechenshader (WebGPU), Zeichendurchgänge (WebGL2) oder die LuxCore-Bilder
    lichtWeg: () => lichtAn() ? aussehen.tuch.echt.weg : 'bilder',
    lichtBild: () => lichtAn() ? aussehen.tuch.echt.lies() : null,   // nur für Eichung und Sichtung
    unterlage: () => 'tuch',
    // Weltkoordinaten (das Tuch liegt fest, §6.11)
    tuchHoehe: (x, z) => aussehen.tuch.hoehe(x, z),
    tuchLicht: (x, z) => lichtAn() ? aussehen.tuch.bestrahlung(x, z) : null,
    /** Weltlage eines Flaschenpunkts in der Lage, in der gerade gezeichnet wird */
    weltpunkt(x, y, z) {
      const p = new THREE.Vector3(x, y, z).applyQuaternion(gruppe.quaternion).add(gruppe.position);
      return [p.x, p.y, p.z];
    },
    /** Eigendrehung ein/aus (mit ?test anfangs aus); eingeschaltet läuft sie sofort an, ohne die Pause nach einer Geste */
    eigendrehung(an) { eigenGewollt = !!an; eigenAb = performance.now(); },
    eigendrehungAn: () => eigenAn(),
    /** Nur das Zeichnen der Kappe aus/ein; ihr Schatten auf dem Tuch bleibt */
    zeigeVerschluss(an) { verschlussAn = !!an; aussehen.verschluss.visible = verschlussAn && flakonAn; },
    // nur für Eichung: Werte des Tuch-Materials setzen
    tuchWerte(w) {
      for (const [n, v] of Object.entries(w)) {
        const u = aussehen.tuch[n];
        if (u.value && u.value.isColor) u.value.set(v);
        else if (u.value && u.value.fromArray) u.value.fromArray(v);
        else u.value = v;
      }
    },
    kappeWerte(w) { for (const [n, v] of Object.entries(w)) aussehen.kappe[n].value = v; },   // nur für Eichung
    lichtStufe(n) { if (n >= 2) { lichtStufe = 2; lichtAus(); } else if (n === 1 && lichtAn()) lichtKlein(); },   // nur für Sichtung: Stufen der Selbstanpassung
    lichtWerte(w) { if (lichtAn()) for (const [n, v] of Object.entries(w)) aussehen.tuch.echt[n].value = v; },
    // Nur das Zeichnen des Flakons aus/ein; das Licht auf dem Tuch wird weiter gerechnet, als wäre er da
    zeigeFlakon(an) {
      flakonAn = !!an;
      aussehen.glasMesh.visible = flakonAn;
      aussehen.verschluss.visible = flakonAn && verschlussAn;
      aussehen.etikett.visible = flakonAn && etikettAn;
      aussehen.blasen.visible = flakonAn && sparstufe === 0;
    },
    zoom: () => zoom,
    setzeZoom(z, fx = 0.5, fy = 0.5) { setzeZoom(z, fx, fy, fx, fy); },
    loslassen() {
      // Nach dem Halten läuft die Eigendrehung (wenn eingeschaltet) gleich wieder an
      if (gehalten) eigenAb = performance.now();
      gehalten = false;
      rohX = rohZ = zielX = zielZ = 0;
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
    flaecheB = w; flaecheH = h;
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
    geste = 'zoom'; rohX = rohZ = zielX = zielZ = 0; gierTempo = 0;
  }

  function zeiger() {
    canvas.addEventListener('pointerdown', e => {
      finger.set(e.pointerId, { x: e.clientX, y: e.clientY });
      eigenRuhe();
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
        rohZ = THREE.MathUtils.clamp(rohZ - dx * 0.0018, -0.8, 0.8);
        rohX = THREE.MathUtils.clamp(rohX + dy * 0.0018, -0.8, 0.8);
        // weich begrenzt: die Flasche kippt über ihre Standkante, aber nie so weit, dass sie ins Tuch taucht
        [zielX, zielZ] = begrenzeNeigung(rohX, rohZ, KIPP_GRENZE, KIPP_KNIE);
      }
      letzteX = e.clientX; letzteY = e.clientY; letzteZeit = jetzt;
    });
    const ende = e => {
      const dabei = finger.delete(e.pointerId);
      eigenRuhe();
      if (pinch) {
        // Nach dem Zoomen erst alle Finger heben, dann beginnt eine neue Geste
        if (finger.size < 2) pinch = null;
        if (finger.size === 0) ziehen = false;
        rohX = rohZ = zielX = zielZ = 0;
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
      rohX = rohZ = zielX = zielZ = 0;
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
      eigenRuhe();
      const [fx, fy] = fensterStelle(e);
      const schritt = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      setzeZoom(zoom * Math.exp(-schritt * 0.01), zoomX + fx / zoom, zoomY + fy / zoom, fx, fy);
    }, { passive: false });
    // Die Größe richtet sich nach der Zeichenfläche, nicht nach dem Browserfenster (§7.1). Das Setzen der Größe leert
    // die Fläche, und der Beobachter meldet sich erst nach dem Bild dieses Durchgangs: deshalb gleich neu zeichnen.
    new ResizeObserver(() => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h || (w === flaecheB && h === flaecheH)) return;
      resize();
      if (laeuft) { aktualisiere(); zeichne(); }
    }).observe(canvas);
    addEventListener('resize', resize);      // ändert der Browser nur die Pixel-Dichte (Seitenzoom), bleibt die Fläche gleich groß
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
    const dreiVerlust = renderer.onDeviceLost;
    renderer.onDeviceLost = info => { dreiVerlust.call(renderer, info); verlust(info); };
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    await renderer.init();
    szene = new THREE.Scene();
    szene.background = new THREE.Color(0x141418);
    if (status) status.textContent = 'Modell, Feld und Aussehen werden geladen …';
    const loader = new GLTFLoader();
    const [gltf, glasGltf, beschreibung, meta, feld, hdr] = await Promise.all([
      loader.loadAsync(hier('./modell/flakon.glb')), loader.loadAsync(hier('./aussehen/glas.glb')),
      fetch(hier('./modell/flakon.json')).then(r => r.json()), fetch(hier('./aussehen/aussehen.json')).then(r => r.json()),
      fetch(hier('./modell/hoehlung_sdf.bin')).then(r => r.arrayBuffer()), ladeHDR(hier('./aussehen/umgebung.hdr')),
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
    // Echtzeit-Licht (§6.12): unter WebGPU mit Rechenshadern, unter WebGL2 mit Zeichendurchgängen in Gleitkomma-Zielflächen
    // — dort nur, wenn in solche Flächen gezeichnet und additiv gemischt werden kann; sonst und mit ?bilder die
    // LuxCore-Bilder. Am Handy gleich in der kleinen Stufe.
    const live = !params.has('bilder') && (webgpu || ['EXT_color_buffer_float', 'EXT_float_blend']
      .every(name => renderer.backend.gl.getExtension(name) !== null));
    const handy = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
    const aussehenNeu = await baueAussehen(gruppe, gltf, glasGltf, meta, szene, feldDaten, hdr,
      { renderer, raster: live ? (Number(params.get('raster')) || (handy ? 128 : 256)) : 0,
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

    // Regler der Testseite (Stärke, Nachklingen): die Seite übergibt die beiden Eingabefelder
    const regler = optionen.regler;
    if (regler && regler.staerke && regler.nachklingen) {
      for (const e of [regler.staerke, regler.nachklingen]) {
        e.addEventListener('input', () => modell.regler(Number(regler.staerke.value), Number(regler.nachklingen.value)));
      }
    }
    zeiger();
    resize();
    qAlt = qAktuell();
    ausgabe = baueGlaettung(renderer, szene, kamera);
    zeichne();
    if (verloren) throw new Error('Grafikgerät verloren');
    if (status) status.textContent = `${(tabelle.bezug / 1000).toFixed(1).replace('.', ',')} ml · ${modell.f1.toFixed(2).replace('.', ',')} Hz · 240 Schritte/s`;
    if (lade) lade.hidden = true;
    document.documentElement.dataset.flakon = 'bereit';
    bereitAufloesen();

    eigenAb = performance.now();        // die Eigendrehung läuft nach dem ersten Bild weich an
    vorher = fpsStart = performance.now();
    function bild(jetzt) {
      if (!laeuft) return;
      const echt = Math.max(0, (jetzt - vorher) / 1000), vergangen = Math.min(0.05, echt);
      vorher = jetzt;
      if (!gehalten) {
        // Eigendrehung nach der Uhrzeit (nicht nach der Bildzahl): der Winkel dieses Bildes wird gleichmäßig auf die
        // Rechenschritte verteilt, damit das Schwappmodell eine ruhige Drehung sieht. Sie ruht, solange ein Finger
        // aufliegt oder der Drehschwung ausläuft; die Pause zählt ab dem Ende davon.
        if (finger.size > 0 || ziehen || pinch || gierSchwung !== 0) eigenRuhe();
        if (eigenAn()) {
          const t = THREE.MathUtils.clamp((performance.now() - eigenAb) / EIGEN_ANLAUF, 0, 1);
          eigenRest += EIGEN_TEMPO * t * t * (3 - 2 * t) * Math.min(0.25, echt);
        } else eigenRest = 0;
        rest = Math.min(0.05, rest + vergangen);
        const schritte = Math.floor(rest / DT);
        if (schritte > 0) {
          rest -= schritte * DT;
          const eigenSchritt = eigenRest / schritte;
          eigenRest = 0;
          for (let i = 0; i < schritte; i++) {
            gier += eigenSchritt;
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
        if (jetzt - fpsStart > 4000) {
          // Fenster zu lang (Tab war im Hintergrund, requestAnimationFrame ruhte): nicht bewerten, neu beginnen
          fpsStart = jetzt; fpsBilder = 0;
        } else if (jetzt - fpsStart >= 2000) {
          fpsAnpassen(fpsBilder * 1000 / (jetzt - fpsStart));
          fpsStart = jetzt; fpsBilder = 0;
        }
      } else {
        fpsStart = jetzt; fpsBilder = 0;
      }
      aktualisiere();
      zeichne();
      rafNr = requestAnimationFrame(bild);
    }
    schleife = bild;
    if (sicht) schleifeAn();
    else { pauseAb = performance.now(); schleifeAus(); }
  }

  try {
    await main();
  } catch (fehler) {
    schleifeAus();
    zeigeFehler(`Die 3D-Ansicht konnte nicht geladen werden: ${fehler.message}`);
    bereitAblehnen(fehler);
    throw fehler;
  }
  return { sichtbar };
}
