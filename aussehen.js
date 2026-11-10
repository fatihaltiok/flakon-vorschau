// web/aussehen.js — Materialien und Szenenaufbau (Teller mit LuxCore-Lichtbildern, Boden, Verschluss, Etikett,
// Bläschen, Glas). Das Glas samt Flüssigkeit rechnet web/glas.js; hier wird nur verdrahtet.
import * as THREE from 'three';
import { Fn, cameraPosition, float, frontFacing, mix, normalLocal, normalWorld, pmremTexture,
  positionLocal, positionWorld, select, smoothstep, texture, uniform, uv, vec2, vec3 } from 'three/tsl';
import { Glas, envRichtung } from './glas.js';
import { EchtzeitLicht } from './tellerlicht.js';

async function bild(url, farbe = false, flipY = true) {
  const t = await new THREE.TextureLoader().loadAsync(url);
  t.colorSpace = farbe ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = flipY;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Teller: die 8 LuxCore-Bilder (Lichtkegel, Schatten, Kaustik) sind das Licht auf dem Teller; sie bleiben in der
 *  Welt fest (Lichteinfall fest), nur der Flakon dreht — der Teller sitzt in der drehenden Gruppe, deshalb wird die
 *  Bildabfrage um die Drehung zurückgedreht. Über 8° Neigung weich in einen schlichten Lichtkegel mit Schatten. */
export class Teller {
  constructor(mesh, bilder, tellerTex) {
    this.bilder = bilder;
    this.uMisch = uniform(0);
    this.uGier = uniform(0);
    this.uKlar = uniform(1);
    this.uGain = uniform(0.2);
    this.a = texture(bilder[0]);
    this.b = texture(bilder[1]);
    this.index = -1;
    // Bild: Mitte = Tellerachse, Breite 0,18 m, Bildoben = −z (Welt). Abfrage aus Flaschenkoordinaten.
    const bildUV = Fn(() => {
      const c = this.uGier.cos(), s = this.uGier.sin();
      const x = positionLocal.x, z = positionLocal.z;
      const xw = x.mul(c).add(z.mul(s)), zw = z.mul(c).sub(x.mul(s));   // Ry(gier): Flasche → Welt
      return vec2(xw.div(0.18).add(0.5), zw.div(0.18).add(0.5));   // Zeile 0 der Datei (oben) = −z
    });
    /** Gebackenes Tellerlicht an einer Weltstelle (x, z) — auch für Strahlen aus dem Glas-Shader. */
    // Die Bilder sind 8-Bit und tonwertbegrenzt: das gebündelte, gefärbte Licht (Kaustik) ist in Wahrheit viel
    // heller als der Teller ringsum. Warme, gesättigte Stellen werden deshalb wieder angehoben (uWarm).
    this.uWarm = uniform(2.2);
    const gebackenAn = u => {
      const c = mix(this.a.sample(u), this.b.sample(u), this.uMisch).rgb;
      return c.mul(c.r.sub(c.b).mul(3).clamp(0, 1).mul(this.uWarm).add(1));
    };
    // Echtzeit-Licht (tellerlicht.js, nur WebGPU): ersetzt die Bilder, solange uEcht 1 ist. Es rechnet in
    // Flaschenkoordinaten und gilt auch gekippt — kein Überblenden zwischen Lagen, kein Ersatz beim Kippen.
    this.uEcht = uniform(0);
    this.echt = null;   // wird vor dem ersten Bild gesetzt (baueAussehen), die Shader entstehen erst danach
    this.lichtWelt = (xw, zw) => {
      const alt = gebackenAn(vec2(xw.div(0.18).add(0.5), zw.div(0.18).add(0.5)));
      if (!this.echt) return alt.mul(this.uGain);
      const c = this.uGier.cos(), s = this.uGier.sin();   // Welt → Flasche (nur die Drehung)
      return mix(alt, this.echt.lichtLokal(xw.mul(c).sub(zw.mul(s)), xw.mul(s).add(zw.mul(c))), this.uEcht).mul(this.uGain);
    };
    const licht = Fn(() => {
      const u = bildUV();
      const gebacken = gebackenAn(u);
      // Ersatz beim Kippen, weltfest wie die gebackenen Bilder: Kegel des Spots (von hinten rechts oben), weicher
      // Schatten des Flakons und darin klein der warme Fleck des Lichts, das durch die Flüssigkeit fällt
      const x = u.x.sub(0.5).mul(0.18), z = u.y.sub(0.5).mul(0.18);
      const kegel = smoothstep(0.105, 0.02, vec2(x.sub(0.03), z.add(0.035)).length()).mul(0.16).add(0.02);
      const schatten = float(1).sub(smoothstep(0.045, 0.022, vec2(x.add(0.012), z.sub(0.02).mul(0.75)).length()).mul(0.7));
      const warm = smoothstep(0.02, 0.003, vec2(x.add(0.018), z.sub(0.046)).length()).mul(0.22);
      const ersatz = vec3(kegel.mul(schatten)).add(vec3(1.0, 0.48, 0.10).mul(warm));
      const bilder = mix(ersatz, gebacken, this.uKlar);
      if (!this.echt) return bilder;
      return mix(bilder, this.echt.lichtLokal(positionLocal.x, positionLocal.z), this.uEcht);
    });
    // Kornstruktur über eine ebene Abbildung (das Tellernetz hat keine UVs)
    const p = mesh.geometry.attributes.position, werte = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { werte[i * 2] = p.getX(i) / 0.18 + 0.5; werte[i * 2 + 1] = p.getZ(i) / 0.18 + 0.5; }
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(werte, 2));
    const feinTex = texture(tellerTex, uv().mul(2));
    const seite = normalLocal.y.lessThan(0.5);
    // Ohne Normal-Map: die Struktur steckt in den gebackenen Bildern; auf der Seitenkante erzeugte sie Streifen.
    const mat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.6, metalness: 0, envMapIntensity: 0.4 });
    // Gebackenes Licht als Eigenleuchten, feine Kornstruktur multiplikativ; die Seitenkante bleibt dunkel.
    mat.colorNode = vec3(0.0);   // nur gebackenes Licht, kein Szenenlicht auf dem Teller
    mat.emissiveNode = Fn(() => {
      const fein = feinTex.rgb.div(0.06).clamp(0.8, 1.2);
      const oben = licht().mul(fein).mul(this.uGain);
      return select(seite, vec3(0.006), oben);
    })();
    mesh.material = mat;
    this.mesh = mesh;
  }

  setze(gier, neigung) {
    const w = ((gier * 180 / Math.PI) % 360 + 360) % 360;
    const i = Math.floor(w / 45) % 8, j = (i + 1) % 8;
    if (i !== this.index) {
      this.a.value = this.bilder[i];
      this.b.value = this.bilder[j];
      this.index = i;
    }
    this.uMisch.value = (w % 45) / 45;
    this.uGier.value = gier;
    const grad = neigung * 180 / Math.PI;
    this.uKlar.value = THREE.MathUtils.clamp((14 - grad) / 6, 0, 1);
  }
}

/** Boden unter dem Teller: dunkel, leicht glänzend, spiegelt Softboxen und Teller. */
function baueBoden(szene) {
  const mat = new THREE.MeshPhysicalNodeMaterial({ color: 0x141416, roughness: 0.4, metalness: 0,
    envMapIntensity: 2.2 });
  const geo = new THREE.CircleGeometry(1.2, 64);
  geo.rotateX(-Math.PI / 2);
  const boden = new THREE.Mesh(geo, mat);
  boden.position.y = -0.0062;
  szene.add(boden);
  return boden;
}

export async function baueAussehen(gruppe, gltf, glasGltf, meta, szene, feldDaten, hdr, opt = {}) {
  const d = meta.dateien, basis = './aussehen/';
  const namen = ['glas_normal', 'glas_rauheit', 'etikett', 'etikett_hoehe', 'etikett_maske',
    'verschluss_normal', 'verschluss_rauheit', 'teller'];
  const tex = {};
  await Promise.all(namen.map(async n => {
    tex[n] = await bild(basis + d[n], ['etikett', 'teller'].includes(n), n === 'teller');
  }));
  const lichtbilder = await Promise.all(d.teller_licht.map(n => bild(basis + n, true, false)));

  let teller, etikett, verschluss;
  gltf.scene.traverse(ob => {
    if (ob.isMesh && !['glas', 'etikett', 'verschluss'].some(n => ob.name.toLowerCase().includes(n))) {
      teller = new Teller(ob, lichtbilder, tex.teller);
    }
  });
  if (!teller) throw new Error('flakon.glb enthält keinen Teller');
  gltf.scene.traverse(ob => {
    if (!ob.isMesh) return;
    const name = ob.name.toLowerCase();
    if (name.includes('glas')) {
      ob.visible = false;
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
      ob.material = new THREE.MeshPhysicalNodeMaterial({ color: 0xb4b4b8, metalness: 1,
        roughness: 0.25, normalMap: tex.verschluss_normal,
        normalScale: new THREE.Vector2(0.08, 0.08), anisotropy: 0.75, anisotropyRotation: 0,
        envMapIntensity: 1.0 });
      ob.material.roughnessNode = texture(tex.verschluss_rauheit).r.mul(0.3).add(0.15);
      verschluss = ob;
    }
  });
  gruppe.add(gltf.scene);
  baueBoden(szene);

  const glas = new Glas(feldDaten, hdr, tex, teller.lichtWelt, opt.halb);
  let glasMesh;
  glasGltf.scene.traverse(ob => {
    if (!ob.isMesh) return;
    glasMesh = ob;
    ob.material = glas.material();
    ob.renderOrder = 3;
  });
  if (!glasMesh) throw new Error('Export glas.glb enthält kein Glasnetz');
  // Echtzeit-Licht auf dem Teller: nur mit Rechenshadern (WebGPU), sonst bleiben die LuxCore-Bilder (Vertrag §6.9)
  if (opt.renderer && opt.raster) {
    teller.echt = new EchtzeitLicht(opt.renderer, glas, glasMesh.geometry, opt.raster, opt.pixel);
    teller.uEcht.value = 1;
  }
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
  return { glas, glasMesh, blasen, teller, uBlasen, etikett, verschluss };
}
