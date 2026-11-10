import * as THREE from 'three';
import { GLTFLoader } from './lib/GLTFLoader.js';
import { VolumenTabelle } from './volumen.js';
import { Schwappmodell, DT, qVonWinkel, qMal, winkelableitung } from './schwappen.js';
import { ladeHDR } from './hdr.js';
import { baueAussehen } from './aussehen.js';
import { ENV_DREHUNG_Y } from './glas.js';

const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');
const lade = document.querySelector('#lade');
const params = new URLSearchParams(location.search);
let modell, gruppe, aussehen, renderer, szene, kamera;
let winkelX = 0, winkelZ = 0, gier = 0, zielX = 0, zielZ = 0, federX = 0, federZ = 0;
let gehalten = false, ziehen = false, geste = '', letzteX = 0, letzteY = 0, startX = 0, startY = 0;
let gierTempo = 0, gierSchwung = 0, letzteZeit = 0, letzteBewegung = 0;
let qAlt = [0, 0, 0, 1], omegaAlt = [0, 0, 0], gerechnet = 0;
let pixelDichte = 1, qualitaetReduziert = false;
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
  aussehen.teller.setze(gier, Math.hypot(winkelX, winkelZ));
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
  halteLage(gx, gz) {
    gehalten = true; ziehen = false;
    winkelX = gx * Math.PI / 180; winkelZ = gz * Math.PI / 180; gier = 0;
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
  loslassen() {
    gehalten = false;
    zielX = zielZ = 0;
    gierSchwung = 0;
  },
};

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const grenze = Math.sqrt(2.1e6 / Math.max(1, w * h));
  pixelDichte = Math.min(devicePixelRatio || 1, 2, grenze) * 0.999;
  renderer.setPixelRatio(pixelDichte);
  renderer.setSize(w, h, false);
  kamera.aspect = w / h;
  kamera.updateProjectionMatrix();
}

function zeiger() {
  canvas.addEventListener('pointerdown', e => {
    if (gehalten) return;
    ziehen = true; geste = '';
    startX = letzteX = e.clientX; startY = letzteY = e.clientY;
    letzteZeit = letzteBewegung = performance.now();
    gierTempo = gierSchwung = 0;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!ziehen || gehalten) return;
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
  const ende = () => {
    if (!ziehen) return;
    ziehen = false;
    if (geste === 'drehen' && performance.now() - letzteBewegung < 150) {
      gierSchwung = THREE.MathUtils.clamp(gierTempo, -5, 5);
    }
    zielX = zielZ = 0;
  };
  canvas.addEventListener('pointerup', ende);
  canvas.addEventListener('pointercancel', ende);
  addEventListener('resize', resize);
}

function fpsAnpassen(schnitt) {
  if (schnitt >= 45) return;
  if (pixelDichte > 1.01) {
    pixelDichte = Math.max(1, pixelDichte - 0.2);
    renderer.setPixelRatio(pixelDichte);
  } else if (!qualitaetReduziert) {
    qualitaetReduziert = true;
    aussehen.blasen.visible = false;
    aussehen.glas.uSchritte.value = 16;   // gröbere Brechung: weniger Marschschritte je Strahl
  }
}

async function main() {
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
  // und in den gebackenen Tellerbildern.
  gruppe = new THREE.Group();
  szene.add(gruppe);
  const feldDaten = new Float32Array(feld);
  if (status) status.textContent = 'Volumen-Tabelle wird aufgebaut …';
  await new Promise(r => setTimeout(r, 0));
  const tabelle = new VolumenTabelle(feldDaten, beschreibung.hoehlung, beschreibung.fuellung);
  modell = new Schwappmodell(beschreibung, tabelle);
  modell.regler(50, 50);
  aussehen = await baueAussehen(gruppe, gltf, glasGltf, meta, szene, feldDaten, hdr);
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
  renderer.render(szene, kamera);
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
    renderer.render(szene, kamera);
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
