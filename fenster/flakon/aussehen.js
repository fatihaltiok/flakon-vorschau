// web/aussehen.js — Materialien und Szenenaufbau (Satintuch, Verschluss, Etikett, Bläschen, Glas). Das Glas samt
// Flüssigkeit rechnet web/glas.js, das Tuch web/tuch.js; hier wird nur verdrahtet.
import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, float, frontFacing, mix, normalWorld, pmremTexture, positionWorld, select, texture,
  uniform, vec3 } from 'three/tsl';
import { Glas, envRichtung } from './glas.js';
import { Tuch } from './tuch.js';
import { Kappe } from './kappe.js';

async function bild(url, farbe = false, flipY = true) {
  const t = await new THREE.TextureLoader().loadAsync(url);
  t.colorSpace = farbe ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = flipY;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export async function baueAussehen(gruppe, gltf, glasGltf, meta, szene, feldDaten, hdr, opt = {}) {
  // Bilder und Felder liegen neben diesem Modul, nicht neben der einbettenden Seite (Vertrag §7.1)
  const d = meta.dateien, basis = new URL('./aussehen/', import.meta.url).href;
  const namen = ['glas_normal', 'glas_rauheit', 'etikett', 'etikett_hoehe', 'etikett_maske'];
  const tex = {};
  await Promise.all(namen.map(async n => {
    tex[n] = await bild(basis + d[n], n === 'etikett', false);
  }));
  // Tuch: Höhenfeld, Normalen-Textur (Falten und Webstruktur) und die acht Lichtbilder für den Ersatz ohne Rechenshader
  const ti = meta.tuch;
  if (!ti) throw new Error('aussehen.json enthält kein Tuch');
  const [hoehen, tuchNormal, lichtbilder] = await Promise.all([
    fetch(basis + ti.hoehe).then(r => { if (!r.ok) throw new Error(`${ti.hoehe} fehlt`); return r.arrayBuffer(); }),
    bild(basis + ti.normal, false, false),
    Promise.all(ti.licht.map(async n => {
      const t = await bild(basis + n, true, false);
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    })),
  ]);

  let etikett, verschluss;
  gltf.scene.traverse(ob => {
    if (!ob.isMesh) return;
    const name = ob.name.toLowerCase();
    if (name.includes('glas')) {
      ob.visible = false;
    } else if (!['etikett', 'verschluss'].some(n => name.includes(n))) {
      // Der Drehteller steckt weiter im Modell (Etikett und Verschluss hängen an ihm), wird aber nicht mehr
      // gezeichnet (§6.10)
      ob.material = new THREE.MeshBasicMaterial({ visible: false });
    } else if (name.includes('etikett')) {
      const m = new THREE.MeshPhysicalNodeMaterial({ map: tex.etikett, roughness: 0.6, metalness: 0,
        bumpMap: tex.etikett_hoehe, bumpScale: 0.0004, envMapIntensity: 0.9 });
      const druck = texture(tex.etikett_maske).r;
      // Rückseite: dunkles Papier ohne Druck (sonst erscheint die Schrift gespiegelt durch das Glas)
      m.colorNode = select(frontFacing, texture(tex.etikett).rgb, vec3(0.012, 0.007, 0.009));
      m.metalnessNode = druck.mul(0.85);
      m.roughnessNode = float(0.58).sub(druck.mul(0.3));
      m.side = THREE.DoubleSide;
      ob.material = m;
      etikett = ob;
    } else if (name.includes('verschluss')) {
      verschluss = ob;      // Material: kappe.js (braucht die Lage der Flasche aus dem Glas, siehe unten)
    }
  });
  gruppe.add(gltf.scene);

  // Glas und Tuch brauchen einander (das Glas zeigt das Tuch gebrochen, das Licht auf dem Tuch kennt die Lage der Flasche); die
  // Shader entstehen erst beim Bauen der Materialien weiter unten
  let tuch;
  const glas = new Glas(feldDaten, hdr, tex, (P, V) => tuch.farbeAn(P, V, false), opt.halb);
  tuch = new Tuch(ti, new Uint16Array(hoehen), tuchNormal, lichtbilder, hdr, glas, { flach: opt.flach });
  // Das Tuch liegt fest in der Welt (§6.11): es hängt an der Szene, nicht an der Gruppe der Flasche
  szene.add(tuch.mesh);
  // Kappe: umlaufend gebürstetes Metall mit Fase und Gebrauchsspuren (§6.11)
  const kappe = new Kappe(verschluss, hdr, glas);
  verschluss.material = kappe.material();
  let glasMesh;
  glasGltf.scene.traverse(ob => { if (ob.isMesh) glasMesh = ob; });
  if (!glasMesh) throw new Error('Export glas.glb enthält kein Glasnetz');
  // Echtzeit-Licht auf dem Tuch: nur mit Rechenshadern (WebGPU), sonst bleiben die LuxCore-Bilder (Vertrag §6.9, §6.10)
  if (opt.renderer && opt.raster) tuch.starteEchtzeit(opt.renderer, glas, glasMesh.geometry, opt.raster, opt.pixel);
  glasMesh.material = glas.material();
  glasMesh.renderOrder = 3;
  gruppe.add(glasGltf.scene);

  // Bläschen: winzige Lichtpunkte im Glas, nach dem Glas gezeichnet (ohne Tiefentest), Rand hell und Mitte
  // leicht dunkel wie eine Luftblase; auf der Rückseite der Flasche schwächer, unter dem Etikett gar nicht.
  const blasenListe = meta.blasen.filter(b => !(b.position[2] > 0.014 && Math.abs(b.position[0]) < 0.029
    && b.position[1] > 0.016 && b.position[1] < 0.055));
  const blasenMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
  const uBlasen = uniform(1);
  const blick = cameraPosition.sub(positionWorld).normalize();
  const rand = float(1).sub(normalWorld.dot(blick).abs()).clamp(0, 1);
  blasenMat.colorNode = Fn(() => {
    const spiegel = pmremTexture(hdr, envRichtung(blick.negate().reflect(normalWorld)), float(0.15)).mul(0.9);
    return mix(vec3(0.02), spiegel.add(0.25), rand.pow(2));
  })();
  blasenMat.opacityNode = rand.pow(1.6).mul(0.85).add(0.08).mul(uBlasen);
  const blasen = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 7), blasenMat, Math.max(1, blasenListe.length));
  const matrix = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
  blasenListe.forEach((b, i) => {
    pos.fromArray(b.position);
    quat.fromArray(b.quaternion);
    scale.fromArray(b.achsen).multiplyScalar(0.8);
    matrix.compose(pos, quat, scale);
    blasen.setMatrixAt(i, matrix);
  });
  blasen.instanceMatrix.needsUpdate = true;
  blasen.renderOrder = 4;
  blasen.frustumCulled = false;
  gruppe.add(blasen);
  return { glas, glasMesh, blasen, tuch, uBlasen, etikett, verschluss, kappe };
}
