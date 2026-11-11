// web/glaettung.js — Kantenglättung für das ganze Bild (Vertrag §6.8). Die Netzkanten glättet MSAA 4× (der
// Szenen-Durchgang erbt die Abtastzahl des Renderers); die Kanten, die erst im Strahl-Shader des Glases entstehen
// (Flüssigkeitslinie, Lichtkanten, Totalreflexion), sieht MSAA nicht — dafür läuft nach Tonwert und Farbraum eine
// FXAA-Glättung über das fertige Bild.
import * as THREE from 'three/webgpu';
import { Fn, convertToTexture, float, pass, renderOutput, select, textureSize, uv, vec2, vec3, vec4 } from 'three/tsl';

export function baueGlaettung(renderer, szene, kamera) {
  const pp = new THREE.RenderPipeline(renderer);
  pp.outputColorTransform = false;
  const bildNode = convertToTexture(renderOutput(pass(szene, kamera)));
  const hell = c => c.rgb.dot(vec3(0.299, 0.587, 0.114));
  pp.outputNode = Fn(() => {
    const p = uv();
    const groesse = vec2(textureSize(bildNode));
    const px = vec2(1).div(groesse);
    const m = bildNode.sample(p);
    const lNW = hell(bildNode.sample(p.add(vec2(-0.5, -0.5).mul(px))));
    const lNE = hell(bildNode.sample(p.add(vec2(0.5, -0.5).mul(px))));
    const lSW = hell(bildNode.sample(p.add(vec2(-0.5, 0.5).mul(px))));
    const lSE = hell(bildNode.sample(p.add(vec2(0.5, 0.5).mul(px))));
    const lM = hell(m);
    const lMin = lM.min(lNW).min(lNE).min(lSW).min(lSE), lMax = lM.max(lNW).max(lNE).max(lSW).max(lSE);
    const dir = vec2(lSW.add(lSE).sub(lNW.add(lNE)), lNW.add(lSW).sub(lNE.add(lSE))).toVar();
    const daempf = lNW.add(lNE).add(lSW).add(lSE).mul(0.25 / 8).max(1 / 128);
    const kehr = float(1).div(dir.x.abs().min(dir.y.abs()).add(daempf));
    dir.assign(dir.mul(kehr).clamp(-8, 8).mul(px));
    const a = bildNode.sample(p.add(dir.mul(1 / 3 - 0.5))).rgb.add(bildNode.sample(p.add(dir.mul(2 / 3 - 0.5))).rgb).mul(0.5);
    const b = a.mul(0.5).add(bildNode.sample(p.add(dir.mul(-0.5))).rgb.add(bildNode.sample(p.add(dir.mul(0.5))).rgb).mul(0.25));
    const lB = hell(b);
    const glatt = select(lB.lessThan(lMin).or(lB.greaterThan(lMax)), a, b);
    // Nur wo wirklich eine Kante steht; ruhige Flächen (Etikettschrift, Struktur) bleiben unberührt scharf
    const kante = lMax.sub(lMin).greaterThan(lMax.mul(0.125).max(0.03));
    return vec4(select(kante, glatt, m.rgb), 1);
  })();
  return pp;
}
