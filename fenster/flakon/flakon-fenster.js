/* R-038, E-036: 3D-Flakon im Fenster der Startseite — der kleine Lader.
   Ohne three.js: zeigt bis zum Start das Standbild, beobachtet das Fenster und
   holt das Modul erst, wenn es weniger als eine Bildschirmhöhe entfernt ist
   (IntersectionObserver, rootMargin rund 100 %). Danach meldet eine zweite,
   strengere Beobachtung, ob das Fenster wirklich im Bild ist — die Szene läuft
   nur dann. Zeitüberschreitung 40 s ab dem Moment, in dem das Fenster nach dem Start des
   Ladens im Bild ist, Ablehnung und flakonfehler: Rückfall mit dem Satz aus Vertrag §3. */
(function () {
  "use strict";

  var fenster = document.querySelector(".flakon3d__fenster");
  if (!fenster) return;
  var canvas = fenster.querySelector("[data-flakon3d]");
  var laden = fenster.querySelector(".flakon3d__laden");
  var hinweis = fenster.querySelector(".flakon3d__hinweis");
  var satz = fenster.querySelector(".flakon3d__ersatz");
  var standbild = fenster.querySelector(".flakon3d__standbild");

  /* Hinweistext je nach Eingabegerät (§3): Maus „Waagerecht ziehen …“,
     Finger der Text aus dem HTML. */
  if (hinweis && matchMedia("(pointer:fine)").matches) {
    hinweis.textContent = "Waagerecht ziehen: drehen · Senkrecht ziehen: kippen";
  }
  /* Nach der ersten Berührung der Zeichenfläche blendet der Hinweis aus. */
  if (canvas && hinweis) {
    canvas.addEventListener("pointerdown", function () {
      hinweis.classList.add("benutzt");
    }, { once: true });
  }

  var zurueck = false;
  function ersatz() {
    if (zurueck) return;
    zurueck = true;
    /* Läuft der Flakon schon, anhalten: hinter dem Standbild soll nichts weiterrechnen. */
    if (flakon && typeof flakon.sichtbar === "function") flakon.sichtbar(false);
    if (laden) laden.hidden = true;
    if (hinweis) hinweis.hidden = true;
    if (canvas) canvas.hidden = true;
    if (standbild) standbild.hidden = false;
    if (satz) satz.hidden = false;
  }
  /* Gerät oder Kontext weg (Ereignis des Moduls, auch nach dem Start). */
  if (canvas) canvas.addEventListener("flakonfehler", ersatz);

  var flakon = null; /* Ergebnis von starte, trägt sichtbar() */
  var imBild = false;
  var gestartet = false;
  var erfuellt = false;
  var ladeBeobachter = null;

  var gestellt = false;
  /* Die 40 s laufen erst, wenn das Fenster nach dem Start wirklich im Bild ist:
     vorher läuft der Flakon nicht sichtbar an. */
  function stelle() {
    if (gestellt || !gestartet || !imBild) return;
    gestellt = true;
    window.setTimeout(function () {
      if (erfuellt || zurueck) return;
      ersatz();
    }, 40000);
  }

  function melde(ja) {
    imBild = !!ja;
    stelle();
    if (flakon && !zurueck && typeof flakon.sichtbar === "function") flakon.sichtbar(imBild);
  }

  function starten() {
    if (gestartet || zurueck) return;
    gestartet = true;
    if (ladeBeobachter) { ladeBeobachter.disconnect(); ladeBeobachter = null; }
    stelle();
    import("./flakon.js").then(function (modul) {
      if (zurueck) return; /* nach einem Rückfall wird nichts mehr gestartet */
      return modul.starte(canvas); /* ohne zweites Argument (Vertrag §2 Punkt 12) */
    }).then(function (erg) {
      if (zurueck || !erg) {
        /* Erst nach dem Rückfall fertig geworden (z. B. nach der Zeitüberschreitung): anhalten. */
        if (erg && typeof erg.sichtbar === "function") erg.sichtbar(false);
        return;
      }
      erfuellt = true;
      flakon = erg;
      melde(imBild); /* Sichtbarkeitsstand von vor dem Start nachreichen */
      if (laden) laden.hidden = true;
      if (standbild) standbild.hidden = true;
      if (hinweis) hinweis.hidden = false;
    }).catch(function () {
      ersatz();
    });
  }

  function beobachten() {
    if (!("IntersectionObserver" in window)) {
      melde(true);
      starten();
      return;
    }
    /* Streng: nur was wirklich im Bild ist, hält die Szene am Laufen. */
    var streng = new IntersectionObserver(function (eintraege) {
      melde(eintraege[eintraege.length - 1].isIntersecting); /* jüngster Eintrag */
    }, { threshold: 0 });
    streng.observe(fenster);
    /* Weit: erstes Mal, wenn das Fenster weniger als eine Bildschirmhöhe
       entfernt ist, wird das Modul geholt. Dieser Beobachter hört danach auf. */
    ladeBeobachter = new IntersectionObserver(function (eintraege) {
      for (var i = 0; i < eintraege.length; i++) {
        if (eintraege[i].isIntersecting) { starten(); return; }
      }
    }, { rootMargin: "100% 0px", threshold: 0 });
    ladeBeobachter.observe(fenster);
  }

  /* Erst beobachten, wenn die Seite geladen ist: bis dahin hat ScrollTrigger den
     Bühnenfilm noch nicht eingehängt (Steckplatz), das Fenster täte sonst schon
     eine Bildschirmhöhe über dem Anfang liegen. */
  if (document.readyState === "complete") {
    requestAnimationFrame(beobachten);
  } else {
    window.addEventListener("load", function () {
      requestAnimationFrame(beobachten);
    }, { once: true });
  }
})();
