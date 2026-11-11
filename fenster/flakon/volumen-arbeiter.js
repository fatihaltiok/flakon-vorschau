// web/volumen-arbeiter.js — baut die Volumen-Tabelle (web/volumen.js, unverändert) abseits der Seite, damit das Laden
// die Seite nicht am Stück blockiert (Gegenprüfung T2n, Befund 3). Zurück gehen nur die fertigen Felder.
import { VolumenTabelle } from './volumen.js';

self.onmessage = e => {
  try {
    const t = new VolumenTabelle(e.data.feld, e.data.hoehlung, e.data.fuellung);
    self.postMessage({ tabelle: { punkte: t.punkte, anzahl: t.anzahl, bezug: t.bezug, schrittTh: t.schrittTh,
      schrittPh: t.schrittPh, zeilen: t.zeilen, spalten: t.spalten, d: t.d } }, [t.punkte.buffer, t.d.buffer]);
  } catch (fehler) {
    self.postMessage({ fehler: String(fehler && fehler.message || fehler) });
  }
};
