import * as THREE from 'three/webgpu';

export async function ladeHDR(url) {
  const bytes = new Uint8Array(await fetch(url).then(r => {
    if (!r.ok) throw new Error(`HDR ${r.status}`);
    return r.arrayBuffer();
  }));
  let p = 0;
  function zeile() {
    const a = p;
    while (p < bytes.length && bytes[p++] !== 10) {}
    return new TextDecoder().decode(bytes.subarray(a, p - 1));
  }
  if (!zeile().startsWith('#?')) throw new Error('Kein Radiance-HDR');
  while (zeile().trim() !== '') {}
  const auf = zeile().trim().split(/\s+/);
  if (auf[0] !== '-Y' || auf[2] !== '+X') throw new Error('HDR-Ausrichtung nicht unterstützt');
  const h = Number(auf[1]), w = Number(auf[3]);
  const rgba = new Float32Array(w * h * 4);
  const zeileRGBE = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    if (p + 4 > bytes.length || bytes[p++] !== 2 || bytes[p++] !== 2
        || (bytes[p++] << 8 | bytes[p++]) !== w) throw new Error('HDR-RLE erwartet');
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < w) {
        const n = bytes[p++];
        if (n > 128) {
          const v = bytes[p++];
          for (let i = 0; i < n - 128; i++) zeileRGBE[c * w + x++] = v;
        } else {
          for (let i = 0; i < n; i++) zeileRGBE[c * w + x++] = bytes[p++];
        }
      }
    }
    // Zeilen von unten nach oben ablegen: three.js erwartet v = 1 (asin(y) = +90°) in der letzten Zeile
    const ziel = h - 1 - y;
    for (let x = 0; x < w; x++) {
      // Die RLE-Zeile liegt kanalweise vor (erst alle R, dann G, B, E) — nicht verschränkt
      const o = (ziel * w + x) * 4, e = zeileRGBE[3 * w + x];
      const f = e ? 2 ** (e - 136) : 0;
      let r = zeileRGBE[x] * f, g = zeileRGBE[w + x] * f, b = zeileRGBE[2 * w + x] * f;
      // Unter dem Flakon lag beim Rendern der Welt-Grauwert (0,05) im Loch des ausgeblendeten Tellers:
      // dort steht in der Szene der dunkle Teller — auf dessen Helligkeit absenken.
      if (y >= h / 2 && Math.max(r, g, b) - Math.min(r, g, b) < 0.003 && r > 0.044 && r < 0.058) {
        r = g = b = 0.004;
      }
      // Das kleine Gegenlicht hinter dem Flakon (Licht_Gegen_3, 30 cm nah) steht nicht im Panorama: ohne
      // Parallaxe würde es jeder Strahl Richtung −z sehen. Es wird herausgenommen und in glas.js als echtes
      // Rechteck an seinem Ort eingerechnet. Softboxen bleiben (≤ 8).
      if (Math.max(r, g, b) > 50) { r = g = b = 0.04; }
      rgba[o] = Math.min(8, r); rgba[o + 1] = Math.min(8, g); rgba[o + 2] = Math.min(8, b); rgba[o + 3] = 1;
    }
  }
  const halb = new Uint16Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) halb[i] = THREE.DataUtils.toHalfFloat(rgba[i]);
  const tex = new THREE.DataTexture(halb, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
