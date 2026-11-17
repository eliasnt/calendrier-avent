/* ============================================================
   Calendrier de l'Avent — logique
   Tu n'as normalement rien à modifier ici.
   ============================================================ */
(() => {
  'use strict';

  const CFG = window.CONFIG || {};
  const ANNEE = CFG.annee || new Date().getFullYear();
  const NB = CFG.nbJours || 24;
  const FUSEAU = CFG.fuseauUTC ?? 1;
  const CLE_SESSION = 'avent-code';
  const CLE_OUVERTES = 'avent-ouvertes-' + ANNEE;
  const CLE_ESSAIS = 'avent-essais';
  const LONGUEUR_CODE = 6;

  const $ = (s) => document.querySelector(s);
  const stock = {
    get(k, s = localStorage) { try { return JSON.parse(s.getItem(k)); } catch { return null; } },
    set(k, v, s = localStorage) { try { s.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k, s = localStorage) { try { s.removeItem(k); } catch { /* ignore */ } },
  };

  /* ---------------- Heure fiable ----------------
     On se base sur l'heure du serveur (GitHub Pages) pour éviter
     qu'on puisse tricher en changeant l'heure du téléphone. */
  let decalage = 0;
  const maintenant = () => Date.now() + decalage;
  const estLocal = ['file:'].includes(location.protocol) ||
    ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
  // Une case n'est disponible qu'à partir de minuit (heure de Paris) le jour J, partout.
  const estDispo = (jour, t) => t >= ouverture(jour);

  async function synchroniserHeure() {
    if (location.protocol === 'file:') return;
    try {
      const r = await fetch(location.pathname + '?t=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
      const d = Date.parse(r.headers.get('Date'));
      if (!isNaN(d)) decalage = d - Date.now();
    } catch { /* hors ligne : on garde l'heure locale */ }
  }

  // Ouverture de la case "jour" : minuit (heure de Paris par défaut) le jour J
  const ouverture = (jour) => Date.UTC(ANNEE, 11, jour, 0, 0, 0) - FUSEAU * 3600e3;

  /* ---------------- Déchiffrement ---------------- */
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  let cleMedia = null;
  const cacheMedias = {};

  // Gros fichier chiffré à part ("chiffre:media/xxx.bin|iv|type") -> adresse lisible par le navigateur
  async function dechiffrerMedia(ref, progression) {
    if (cacheMedias[ref]) return cacheMedias[ref];
    const [chemin, iv, type] = ref.slice('chiffre:'.length).split('|');
    const rep = await fetch(chemin);
    if (!rep.ok) throw new Error('media ' + rep.status);
    const total = +rep.headers.get('Content-Length') || 0;
    const morceaux = [];
    let recu = 0;
    const lecteur = rep.body.getReader();
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value); recu += value.length;
      if (total) progression?.(recu / total);
    }
    const tout = new Uint8Array(recu);
    let pos = 0;
    for (const m of morceaux) { tout.set(m, pos); pos += m.length; }
    const clair = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(iv) }, cleMedia, tout);
    return (cacheMedias[ref] = URL.createObjectURL(new Blob([clair], { type })));
  }

  async function dechiffrer(code) {
    const D = window.DONNEES_CHIFFREES;
    if (!D) throw new Error('donnees-absentes');
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
    const cle = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64(D.sel), iterations: D.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const clair = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(D.iv) }, cle, b64(D.data));
    cleMedia = cle; // gardée en mémoire pour déchiffrer les vidéos à la demande
    // Sur ton ordinateur : on affiche directement contenu.js (tes dernières modifs, sans rechiffrer)
    if (estLocal && window.CONTENU) return window.CONTENU;
    return JSON.parse(new TextDecoder().decode(clair));
  }

  // En local uniquement : charge contenu.js (jamais en ligne, il n'y est pas)
  function chargerContenuLocal() {
    if (!estLocal) return Promise.resolve();
    return new Promise((ok) => {
      const s = document.createElement('script');
      s.src = 'contenu.js?t=' + Date.now();
      s.onload = s.onerror = ok;
      document.head.appendChild(s);
    });
  }

  /* ---------------- Connexion ---------------- */
  let saisie = '';
  let enCours = false;
  const points = $('#points');
  const pave = $('#pave');
  const erreur = $('#erreur-code');

  function dessinerPoints() {
    [...points.children].forEach((p, i) => p.classList.toggle('plein', i < saisie.length));
  }

  function tempsBlocage() {
    const e = stock.get(CLE_ESSAIS) || {};
    return Math.max(0, (e.jusqua || 0) - Date.now());
  }

  function majBlocage() {
    const reste = tempsBlocage();
    pave.classList.toggle('bloque', reste > 0);
    if (reste > 0) {
      erreur.textContent = `Trop d'essais. Réessaie dans ${Math.ceil(reste / 1000)} s.`;
      setTimeout(majBlocage, 1000);
    } else if (erreur.dataset.bloque) {
      erreur.textContent = ''; delete erreur.dataset.bloque;
    }
    if (reste > 0) erreur.dataset.bloque = '1';
  }

  function touche(t) {
    if (enCours || tempsBlocage() > 0) return;
    if (t === 'effacer') saisie = saisie.slice(0, -1);
    else if (t === 'valider') { if (saisie.length === LONGUEUR_CODE) valider(); return; }
    else if (/^\d$/.test(t) && saisie.length < LONGUEUR_CODE) saisie += t;
    erreur.textContent = '';
    dessinerPoints();
    if (saisie.length === LONGUEUR_CODE) valider();
  }

  async function valider() {
    enCours = true;
    erreur.textContent = 'Vérification…';
    try {
      const contenu = await dechiffrer(saisie);
      stock.del(CLE_ESSAIS);
      stock.set(CLE_SESSION, saisie, sessionStorage);
      points.classList.add('ok');
      erreur.textContent = '';
      setTimeout(() => ouvrirCalendrier(contenu), 350);
    } catch (e) {
      if (e.message === 'donnees-absentes') {
        erreur.textContent = 'Fichier donnees.js manquant (voir LISEZMOI).';
      } else {
        const ess = stock.get(CLE_ESSAIS) || { n: 0 };
        ess.n = (ess.n || 0) + 1;
        if (ess.n >= 5) ess.jusqua = Date.now() + 30000 * Math.pow(2, Math.min(ess.n - 5, 6));
        stock.set(CLE_ESSAIS, ess);
        erreur.textContent = 'Ce n’est pas le bon code…';
        points.classList.remove('secoue'); void points.offsetWidth; points.classList.add('secoue');
        majBlocage();
      }
      saisie = '';
      setTimeout(dessinerPoints, 300);
    } finally {
      enCours = false;
    }
  }

  pave.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-touche]');
    if (b) touche(b.dataset.touche);
  });
  document.addEventListener('keydown', (e) => {
    if ($('#ecran-connexion').hidden) return;
    if (/^\d$/.test(e.key)) touche(e.key);
    else if (e.key === 'Backspace') touche('effacer');
    else if (e.key === 'Enter') touche('valider');
  });

  /* ---------------- Calendrier ---------------- */
  let CONTENU = null;
  let ouvertes = new Set(stock.get(CLE_OUVERTES) || []);
  const cases = [];

  // Ordre mélangé des cases (toujours le même)
  function ordreMelange(n) {
    // Cherche un ordre mélangé qui remplit la grille sans trou en 4 ET 6 colonnes
    for (let g = 20251201; g < 20251201 + 5000; g++) {
      const ordre = melanger(n, g);
      if (sansTrou(ordre, 4) && sansTrou(ordre, 6)) return ordre;
    }
    return melanger(n, 20251201);
  }

  // Simule le placement "dense" de la grille CSS et vérifie qu'il ne reste aucun trou
  function sansTrou(ordre, cols) {
    const occ = [];
    const libre = (r, c) => !(occ[r] && occ[r][c]);
    let total = 0;
    for (const jour of ordre) {
      const t = formeDuJour(jour)[1];
      const w = t === 'grand' ? 2 : 1;
      const h = t === 'petit' ? 1 : 2;
      total += w * h;
      placement:
      for (let r = 0; ; r++) {
        for (let c = 0; c + w <= cols; c++) {
          let ok = true;
          for (let dr = 0; dr < h && ok; dr++) for (let dc = 0; dc < w && ok; dc++) ok = libre(r + dr, c + dc);
          if (ok) {
            for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) (occ[r + dr] ||= [])[c + dc] = 1;
            break placement;
          }
        }
      }
    }
    return occ.length === Math.ceil(total / cols) && total % cols === 0;
  }

  function melanger(n, graine) {
    const alea = () => ((graine = (graine * 1103515245 + 12345) % 2147483648) / 2147483648);
    const t = Array.from({ length: n }, (_, i) => i + 1);
    for (let i = t.length - 1; i > 0; i--) {
      const j = Math.floor(alea() * (i + 1));
      [t[i], t[j]] = [t[j], t[i]];
    }
    return t;
  }

  /* Forme, taille et couleur de chaque case.
     grand = 2×2, haut = 1×2, petit = 1×1  (2 grands + 6 hauts + 16 petits = grille pleine) */
  const SPECIALES = {
    24: ['etoile', 'grand', 'or'],
    12: ['cadeau', 'grand', 'rouge'],
    3: ['sapin', 'haut', 'vert'],
    7: ['chaussette', 'haut', 'rouge'],
    10: ['sapin', 'haut', 'vert'],
    15: ['chaussette', 'haut', 'vert'],
    18: ['sapin', 'haut', 'vert'],
    21: ['chaussette', 'haut', 'rouge'],
  };
  const PETITES = [
    ['boule', 'rouge'], ['cadeau', 'vert'], ['etoile', 'or'], ['chalet', 'rouge'], ['boule', 'bleu'],
    ['cloche', 'or'], ['cadeau', 'bleu'], ['boule', 'or'], ['etoile', 'or'], ['cadeau', 'creme'],
    ['boule', 'vert'], ['chalet', 'rouge'], ['cloche', 'or'], ['cadeau', 'rouge'], ['boule', 'rouge'], ['etoile', 'or'],
  ];
  let indexPetite = 0;
  const cachePetites = {};
  function formeDuJour(jour) {
    if (SPECIALES[jour] && jour <= NB) return SPECIALES[jour];
    if (!cachePetites[jour]) {
      const [f, c] = PETITES[indexPetite++ % PETITES.length];
      cachePetites[jour] = [f, 'petit', c];
    }
    return cachePetites[jour];
  }

  const echap = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ouvrirCalendrier(contenu) {
    CONTENU = contenu;
    const acc = contenu.accueil || {};
    $('#surtitre').textContent = acc.surtitre || `Décembre ${ANNEE}`;
    $('#titre-accueil').textContent = acc.titre || 'Calendrier de l’Avent';
    $('#message-accueil').textContent = acc.message || '';
    $('#pied').textContent = acc.signature || '';

    const grille = $('#grille');
    grille.innerHTML = '';
    cases.length = 0;
    ordreMelange(NB).forEach((jour, idx) => {
      const [forme, taille, couleur] = formeDuJour(jour);
      const rot = ((jour * 37) % 11 - 5) * (taille === 'petit' ? 1.2 : 0.6);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `case f-${forme} t-${taille} c-${couleur}`;
      b.style.setProperty('--rot', rot.toFixed(1) + 'deg');
      b.dataset.jour = jour;
      const titre = contenu.jours?.[jour]?.titre || '';
      b.innerHTML = `
        <span class="deco" aria-hidden="true"></span>
        <span class="forme">
          <span class="interieur"><span class="coeur">${echap(contenu.jours?.[jour]?.emoji || '❤️')}</span><span class="mini-titre">${echap(titre)}</span></span>
          <span class="porte"><span class="contenu-porte"><span class="numero">${jour}</span><span class="etat"></span></span></span>
        </span>`;
      b.addEventListener('click', () => cliquerCase(jour, b));
      grille.appendChild(b);
      cases.push({ jour, el: b, etat: b.querySelector('.etat') });
    });

    $('#ecran-connexion').hidden = true;
    $('#ecran-calendrier').hidden = false;
    window.scrollTo(0, 0);
    tic();
    setInterval(tic, 1000);
  }

  const deux = (n) => String(n).padStart(2, '0');
  function decouper(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return { j: Math.floor(s / 86400), h: Math.floor(s / 3600) % 24, m: Math.floor(s / 60) % 60, s: s % 60 };
  }
  function court(ms) {
    const d = decouper(ms);
    if (d.j >= 1) return `J-${d.j + (d.h || d.m || d.s ? 1 : 0)}`;
    return `${deux(d.h)}:${deux(d.m)}:${deux(d.s)}`;
  }
  function phrase(ms) {
    const d = decouper(ms);
    if (d.j > 0) return `${d.j} jour${d.j > 1 ? 's' : ''} et ${d.h} h`;
    if (d.h > 0) return `${d.h} h ${deux(d.m)} min`;
    return `${d.m} min ${deux(d.s)} s`;
  }

  function tic() {
    const t = maintenant();

    // Cases
    for (const c of cases) {
      const dispo = estDispo(c.jour, t);
      const ouverte = ouvertes.has(c.jour) && dispo;
      c.el.classList.toggle('verrouillee', !dispo);
      c.el.classList.toggle('disponible', dispo && !ouverte);
      c.el.classList.toggle('ouverte', ouverte);
      c.etat.textContent = dispo ? (ouverte ? '' : 'à ouvrir') : '🔒 ' + court(ouverture(c.jour) - t);
      c.el.setAttribute('aria-label', `Jour ${c.jour}` + (dispo ? (ouverte ? ', ouverte' : ', à ouvrir') : ', verrouillée'));
    }

    // Grand compte à rebours
    const compte = $('#compte');
    const libelle = $('#compte-libelle');
    let cible = null;
    let prochain = null;
    for (let j = 1; j <= NB; j++) {
      if (ouverture(j) > t) { cible = ouverture(j); prochain = j; break; }
    }
    compte.classList.toggle('fini', cible === null);
    if (cible === null) {
      libelle.textContent = CONTENU.accueil?.messageFin || 'Toutes les cases sont ouvertes ✨';
      return;
    }
    if (prochain === 1) libelle.textContent = CONTENU.accueil?.texteAvantDebut || 'Patience… la première case s’ouvre dans';
    else {
      const aujourdhui = prochain - 1;
      libelle.textContent = ouvertes.has(aujourdhui)
        ? `Prochaine case (le ${prochain}) dans`
        : `La case du ${aujourdhui} t’attend ! Prochaine (le ${prochain}) dans`;
    }
    const d = decouper(cible - t);
    $('#cr-j').textContent = deux(d.j);
    $('#cr-h').textContent = deux(d.h);
    $('#cr-m').textContent = deux(d.m);
    $('#cr-s').textContent = deux(d.s);
  }

  let minuteurBulle;
  function bulle(txt) {
    const b = $('#bulle');
    b.textContent = txt; b.hidden = false;
    b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
    clearTimeout(minuteurBulle);
    minuteurBulle = setTimeout(() => { b.hidden = true; }, 2600);
  }

  function cliquerCase(jour, el) {
    const t = maintenant();
    if (!estDispo(jour, t)) {
      el.classList.remove('secoue'); void el.offsetWidth; el.classList.add('secoue');
      bulle(`Pas encore ! La case ${jour} s’ouvre dans ${phrase(ouverture(jour) - t)} 🤫`);
      return;
    }
    if (!ouvertes.has(jour)) {
      ouvertes.add(jour);
      stock.set(CLE_OUVERTES, [...ouvertes]);
      tic();
      paillettes(el);
      setTimeout(() => afficherFenetre(jour), 750);
    } else {
      afficherFenetre(jour);
    }
  }

  /* ---------------- Fenêtre ---------------- */
  function idYoutube(url) {
    const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }
  function idSpotify(url) {
    const m = String(url).match(/open\.spotify\.com\/(?:intl-\w+\/)?(track|album|playlist|episode)\/(\w+)/);
    return m ? `${m[1]}/${m[2]}` : null;
  }

  function media(url, type) {
    if (!url) return null;
    if (url.startsWith('chiffre:')) {
      const mime = url.split('|')[2] || '';
      const boite = document.createElement('div');
      boite.className = 'media-chargement';
      boite.innerHTML = `<span>${mime.startsWith('video') ? '🎬' : '✨'} Chargement… <b>0 %</b></span><i><u></u></i>`;
      const pct = boite.querySelector('b'), barre = boite.querySelector('u');
      dechiffrerMedia(url, (p) => { pct.textContent = Math.round(p * 100) + ' %'; barre.style.width = p * 100 + '%'; })
        .then((src) => {
          const el = media(src,mime.startsWith('image') ? 'image' : (mime.startsWith('audio') ? 'audio' : 'video'));
          if (boite.isConnected) boite.replaceWith(el);
        })
        .catch(() => { boite.querySelector('span').textContent = 'Impossible de charger le fichier 😕 Vérifie ta connexion et rouvre la case.'; });
      return boite;
    }
    const yt = idYoutube(url);
    if (yt) {
      const f = document.createElement('iframe');
      f.src = `https://www.youtube-nocookie.com/embed/${yt}`;
      f.className = 'video-yt';
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true;
      return f;
    }
    const sp = idSpotify(url);
    if (sp) {
      const f = document.createElement('iframe');
      f.src = `https://open.spotify.com/embed/${sp}`;
      f.height = sp.startsWith('track') ? 152 : 352;
      f.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
      f.loading = 'lazy';
      return f;
    }
    if (type === 'image') {
      const i = document.createElement('img'); i.src = url; i.alt = ''; i.loading = 'lazy'; return i;
    }
    if (type === 'audio' || /\.(mp3|m4a|ogg|wav)(\?|$)/i.test(url)) {
      const a = document.createElement('audio'); a.src = url; a.controls = true; return a;
    }
    const v = document.createElement('video'); v.src = url; v.controls = true; v.playsInline = true; return v;
  }

  function afficherFenetre(jour) {
    const j = CONTENU.jours?.[jour] || {};
    $('#fenetre-jour').textContent = `${jour} décembre`;
    $('#fenetre-titre').textContent = j.titre || `Jour ${jour}`;
    const zone = $('#fenetre-media');
    zone.innerHTML = '';
    const images = [].concat(j.image || []);
    images.forEach((src) => { const m = media(src, 'image'); if (m) zone.appendChild(m); });
    [j.video, j.musique].forEach((src) => { const m = media(src); if (m) zone.appendChild(m); });

    // Le message accepte du HTML simple (<b>, <i>, <br>…) — c'est toi qui l'écris.
    $('#fenetre-message').innerHTML = j.message || '';

    // Poème (optionnel, pour n'importe quel jour)
    const zonePoeme = $('#fenetre-poeme');
    zonePoeme.innerHTML = '';
    const vers = String(j.poeme || '').replace(/^\s*\n|\n\s*$/g, '');
    if (vers.trim()) {
      if (j.poemeTitre) {
        const h = document.createElement('h3'); h.textContent = j.poemeTitre; zonePoeme.appendChild(h);
      }
      vers.split(/\n\s*\n/).forEach((strophe) => {
        const p = document.createElement('p');
        p.textContent = strophe.split('\n').map((l) => l.trim()).join('\n');
        zonePoeme.appendChild(p);
      });
      if (j.poemeSignature) {
        const s = document.createElement('p'); s.className = 'signature-poeme'; s.textContent = j.poemeSignature; zonePoeme.appendChild(s);
      }
    }

    $('#fenetre-jeu').innerHTML = '';
    if (j.motsMeles?.grille?.length) jeuMotsMeles($('#fenetre-jeu'), j.motsMeles, jour);
    if (j.coupons?.liste?.length) afficherCoupons($('#fenetre-jeu'), j.coupons, jour);
    if (j.puzzle?.image) jeuPuzzle($('#fenetre-jeu'), j.puzzle, jour);
    if (j.wishlist?.souhaits?.length) afficherWishlist($('#fenetre-jeu'), j.wishlist, jour);
    if (j.sudoku?.grille?.length) jeuSudoku($('#fenetre-jeu'), j.sudoku, jour);
    if (j.motsFleches?.grille?.length) jeuMotsFleches($('#fenetre-jeu'), j.motsFleches, jour);
    if (j.lettresNom?.nom) afficherLettresNom($('#fenetre-jeu'), j.lettresNom);
    if (j.quiz?.questions?.length) jeuQuiz($('#fenetre-jeu'), j.quiz, jour);
    if (j.cadeauEnVrai) afficherCadeauEnVrai($('#fenetre-jeu'), j.cadeauEnVrai);
    if (j.paires?.photos?.length) jeuPaires($('#fenetre-jeu'), j.paires, jour);
    if (j.pendu?.mot) jeuPendu($('#fenetre-jeu'), j.pendu, jour);
    document.querySelector('.fenetre').classList.toggle('fenetre-large', !!(j.motsFleches?.grille?.length || j.puzzle?.image));

    const lien = $('#fenetre-lien');
    lien.innerHTML = '';
    if (j.lien) {
      const a = document.createElement('a');
      a.href = j.lien; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = j.texteLien || 'Ouvrir 🎁';
      lien.appendChild(a);
    }
    $('#voile').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#fermer').focus();
  }

  function fermerFenetre() {
    $('#voile').hidden = true;
    document.body.style.overflow = '';
    // stoppe vidéos / musiques
    $('#fenetre-media').innerHTML = '';
    $('#fenetre-jeu').innerHTML = '';
  }

  /* ---------------- Puzzle ---------------- */
  function jeuPuzzle(zone, cfg, jour) {
    const COLS = cfg.colonnes || 4, ROWS = cfg.lignes || 3, N = COLS * ROWS;
    const cle = `avent-puzzle-${ANNEE}-${jour}`;
    let places = new Set(stock.get(cle) || []);

    const bloc = document.createElement('div');
    bloc.className = 'puzzle';
    bloc.innerHTML = `
      <div class="pz-entete">
        <span class="pz-score"></span>
        <span class="pz-actions">
          <button type="button" class="pz-melanger">🔀 Mélanger</button>
          <button type="button" class="pz-recommencer">↺ Recommencer</button>
        </span>
      </div>
      <div class="pz-zone"><div class="pz-plateau"></div></div>
      <p class="pz-aide">Fais glisser les pièces dans le cadre. Elles se collent toutes seules quand elles sont à la bonne place.</p>
      <div class="pz-victoire" hidden></div>`;
    zone.appendChild(bloc);
    const zoneEl = bloc.querySelector('.pz-zone');
    const plateau = bloc.querySelector('.pz-plateau');
    const score = bloc.querySelector('.pz-score');
    const victoire = bloc.querySelector('.pz-victoire');

    // Forme des encoches (toujours la même pour ce jour)
    let g = 1000 + jour * 7919;
    const alea = () => ((g = (g * 16807) % 2147483647) / 2147483647);
    const H = [], V = [];
    for (let r = 0; r < ROWS; r++) { H[r] = []; V[r] = []; for (let c = 0; c < COLS; c++) { H[r][c] = alea() < .5 ? 1 : -1; V[r][c] = alea() < .5 ? 1 : -1; } }
    const bords = (r, c) => ({
      haut: r === 0 ? 0 : -H[r - 1][c],
      droite: c === COLS - 1 ? 0 : V[r][c],
      bas: r === ROWS - 1 ? 0 : H[r][c],
      gauche: c === 0 ? 0 : -V[r][c - 1],
    });

    const img = new Image();
    img.onload = construire;
    img.src = cfg.image;

    let pieces = [];
    let W, BH, w, h, S, pad, zH, ZW, ox = 0, cote = false;

    function cheminPiece(ctx, b) {
      const coins = [[pad, pad], [pad + w, pad], [pad + w, pad + h], [pad, pad + h]];
      const normales = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      const tabs = [b.haut, b.droite, b.bas, b.gauche];
      // forme d'une encoche : [u le long du bord, v vers l'extérieur]
      const forme = [[.36, 0], [.40, 0, .30, .24, .50, .24], [.70, .24, .60, 0, .64, 0]];
      ctx.beginPath();
      ctx.moveTo(pad, pad);
      for (let i = 0; i < 4; i++) {
        const [x0, y0] = coins[i], [x1, y1] = coins[(i + 1) % 4];
        const dx = x1 - x0, dy = y1 - y0, [nx, ny] = normales[i], t = tabs[i];
        const P = (u, v) => [x0 + dx * u + nx * v * S * t, y0 + dy * u + ny * v * S * t];
        if (t) {
          ctx.lineTo(...P(...forme[0]));
          ctx.bezierCurveTo(...P(forme[1][0], forme[1][1]), ...P(forme[1][2], forme[1][3]), ...P(forme[1][4], forme[1][5]));
          ctx.bezierCurveTo(...P(forme[2][0], forme[2][1]), ...P(forme[2][2], forme[2][3]), ...P(forme[2][4], forme[2][5]));
        }
        ctx.lineTo(x1, y1);
      }
      ctx.closePath();
    }

    function construire() {
      // Sur ordinateur (fenêtre plein écran) : plateau aussi grand que l écran le permet,
      // pièces à côté si la photo est en hauteur, en dessous sinon
      ZW = zoneEl.clientWidth;
      const ratio = img.naturalWidth / img.naturalHeight;
      const large = !!zoneEl.closest(".fenetre-large") && innerWidth >= 900;
      if (large) {
        // plus grand plateau possible tel que plateau ET pièces à côté tiennent dans la hauteur de l écran
        const maxH = Math.max(320, innerHeight - 250);
        const hauteur = (Wt) => {
          const bh = Wt / ratio, ww = Wt / COLS, hh = bh / ROWS, pd = Math.min(ww, hh) * .26;
          const pw = ww + 2 * pd, ph = hh + 2 * pd, tw = ZW - Wt - 28;
          const n = Math.max(1, Math.floor((tw + pd) / (pw * .82)));
          return Math.max(bh, Math.ceil(N / n) * ph * .8 + ph * .25);
        };
        cote = true; ox = 0; W = ZW * 0.3;
        for (let Wt = ZW * 0.3; Wt <= ZW * 0.72; Wt += 4) if (hauteur(Wt) <= maxH) W = Wt;
      } else { cote = false; W = ZW; ox = 0; }
      plateau.style.width = W + "px";
      plateau.style.marginLeft = ox + "px";
      BH = W / ratio;
      w = W / COLS; h = BH / ROWS; S = Math.min(w, h); pad = S * .26;
      plateau.style.height = BH + 'px';
      plateau.style.backgroundSize = `${w}px ${h}px`;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      pieces = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const cv = document.createElement('canvas');
          const pw = w + 2 * pad, ph = h + 2 * pad;
          cv.width = Math.ceil(pw * dpr); cv.height = Math.ceil(ph * dpr);
          cv.style.width = pw + 'px'; cv.style.height = ph + 'px';
          cv.className = 'pz-piece';
          const ctx = cv.getContext('2d');
          ctx.scale(dpr, dpr);
          cheminPiece(ctx, bords(r, c));
          ctx.save(); ctx.clip();
          ctx.drawImage(img, -c * w + pad, -r * h + pad, W, BH);
          ctx.restore();
          ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.stroke();
          const p = { i: r * COLS + c, el: cv, bx: ox + c * w - pad, by: r * h - pad };
          pieces.push(p);
          zoneEl.appendChild(cv);
          brancherGlisser(p);
        }
      }
      disposer();
    }

    function poser(p, x, y) { p.x = x; p.y = y; p.el.style.transform = `translate(${x}px, ${y}px)`; }

    // Place les pièces bien posées, éparpille les autres sous le cadre
    function disposer() {
      const libres = pieces.filter((p) => !places.has(p.i)).sort(() => Math.random() - .5);
      const pw = w + 2 * pad, ph = h + 2 * pad;
      const x0 = cote ? W + 28 : 0, tw = ZW - x0;          // zone où ranger les pièces libres
      const y0 = cote ? 0 : BH + 18;
      const parLigne = Math.max(1, Math.floor((tw + pad) / (pw * .82)));
      const lignes = Math.ceil(libres.length / parLigne);
      const pasX = parLigne > 1 ? (tw - pw + 2 * pad) / (parLigne - 1) : 0;
      const hTas = lignes ? lignes * ph * .8 + ph * .25 : 0;
      zH = cote ? Math.max(BH, hTas) : BH + 18 + hTas;
      zoneEl.style.height = zH + 'px';
      pieces.forEach((p) => {
        if (places.has(p.i)) { poser(p, p.bx, p.by); p.el.classList.add('pz-place'); }
        else p.el.classList.remove('pz-place');
      });
      libres.forEach((p, k) => {
        const col = k % parLigne, lig = Math.floor(k / parLigne);
        const jx = (Math.random() - .5) * pad * .8, jy = (Math.random() - .5) * pad * .6;
        poser(p, Math.max(x0 - pad, Math.min(ZW - pw + pad, x0 - pad + col * pasX + jx)), Math.max(-pad, y0 - pad * .5 + lig * ph * .8 + jy));
        p.el.style.zIndex = 10 + k;
      });
      majScore();
    }

    let zMax = 100;
    function brancherGlisser(p) {
      let dx = 0, dy = 0, actif = false;
      p.el.addEventListener('pointerdown', (e) => {
        if (places.has(p.i)) return;
        e.preventDefault();
        actif = true;
        try { p.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        p.el.style.zIndex = ++zMax;
        p.el.classList.add('pz-tenue');
        const z = zoneEl.getBoundingClientRect();
        dx = e.clientX - z.left - p.x; dy = e.clientY - z.top - p.y;
      });
      p.el.addEventListener('pointermove', (e) => {
        if (!actif) return;
        const z = zoneEl.getBoundingClientRect();
        const pw = w + 2 * pad, ph = h + 2 * pad;
        poser(p,
          Math.max(-pad, Math.min(ZW - pw + pad, e.clientX - z.left - dx)),
          Math.max(-pad, Math.min(zH - ph + pad, e.clientY - z.top - dy)));
      });
      const lacher = () => {
        if (!actif) return;
        actif = false;
        p.el.classList.remove('pz-tenue');
        if (Math.hypot(p.x - p.bx, p.y - p.by) < S * .32) {
          poser(p, p.bx, p.by);
          p.el.classList.add('pz-place');
          p.el.style.zIndex = 1;
          places.add(p.i);
          stock.set(cle, [...places]);
          p.el.animate([{ filter: 'brightness(1.6)' }, { filter: 'brightness(1)' }], { duration: 450 });
          majScore();
        }
      };
      p.el.addEventListener('pointerup', lacher);
      p.el.addEventListener('pointercancel', lacher);
    }

    function majScore() {
      score.textContent = `${places.size} / ${N} pièces`;
      const fini = places.size === N;
      bloc.classList.toggle('pz-fini', fini);
      if (fini && victoire.hidden) {
        victoire.hidden = false;
        victoire.innerHTML = `<strong>Bravo mon cœur ! 🧩</strong>${cfg.messageVictoire ? `<span>${echap(cfg.messageVictoire)}</span>` : ''}`;
        if (!plateau.querySelector('img')) {
          const im = document.createElement('img'); im.src = cfg.image; im.alt = ''; plateau.appendChild(im);
        }
        paillettes(plateau);
      }
    }

    bloc.querySelector('.pz-melanger').addEventListener('click', disposer);
    bloc.querySelector('.pz-recommencer').addEventListener('click', () => {
      if (places.size && !confirm('Recommencer le puzzle depuis le début ?')) return;
      places = new Set(); stock.del(cle);
      victoire.hidden = true; plateau.querySelector('img')?.remove();
      disposer();
    });
  }

  /* ---------------- Sudoku ---------------- */
  function jeuSudoku(zone, cfg, jour) {
    const depart = cfg.grille.map((l) => [...l.replace(/\s/g, '')].map((ch) => (/[1-9]/.test(ch) ? +ch : 0)));
    const n = depart.length;
    const bh = n === 6 ? 2 : Math.round(Math.sqrt(n)), bw = n / bh; // taille des blocs (6×6 -> 2 lignes × 3 colonnes)
    const cle = `avent-sudoku-${ANNEE}-${jour}`;

    // Solution calculée automatiquement
    const sol = depart.map((r) => r.slice());
    const possible = (g, r, c, v) => {
      for (let i = 0; i < n; i++) if (g[r][i] === v || g[i][c] === v) return false;
      const r0 = r - r % bh, c0 = c - c % bw;
      for (let i = 0; i < bh; i++) for (let j = 0; j < bw; j++) if (g[r0 + i][c0 + j] === v) return false;
      return true;
    };
    (function resoudre() {
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!sol[r][c]) {
        for (let v = 1; v <= n; v++) if (possible(sol, r, c, v)) { sol[r][c] = v; if (resoudre()) return true; sol[r][c] = 0; }
        return false;
      }
      return true;
    })();

    let saisie = stock.get(cle) || depart.map((r) => r.slice());
    let sel = null;

    const bloc = document.createElement('div');
    bloc.className = 'sudoku' + (n > 6 ? ' sd-n9' : '');
    bloc.innerHTML = `
      <div class="sd-entete"><span class="sd-score"></span><button type="button" class="sd-verifier">✔ Vérifier</button></div>
      <div class="sd-grille" style="--n:${n};--bw:${bw};--bh:${bh}"></div>
      <div class="sd-pave"></div>
      <p class="sd-aide">Touche une case vide, puis un chiffre. Chaque ligne, colonne et bloc doit contenir les chiffres de 1 à ${n} une seule fois.</p>
      <div class="sd-victoire" hidden></div>`;
    zone.appendChild(bloc);
    const grille = bloc.querySelector('.sd-grille');
    const pave = bloc.querySelector('.sd-pave');
    const score = bloc.querySelector('.sd-score');
    const victoire = bloc.querySelector('.sd-victoire');
    const cases = [];

    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sd-case' + (depart[r][c] ? ' sd-donnee' : '');
      if ((c + 1) % bw === 0 && c < n - 1) b.classList.add('sd-bord-d');
      if (c === n - 1) b.classList.add('sd-der');
      if ((r + 1) % bh === 0 && r < n - 1) b.classList.add('sd-bord-b');
      b.addEventListener('click', () => { if (!bloc.classList.contains('sd-fini')) { sel = [r, c]; dessiner(); } });
      grille.appendChild(b);
      cases.push({ r, c, el: b });
    }
    for (let v = 1; v <= n; v++) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = v;
      b.addEventListener('click', () => ecrire(v));
      pave.appendChild(b);
    }
    const eff = document.createElement('button'); eff.type = 'button'; eff.textContent = '⌫'; eff.className = 'sd-effacer';
    eff.addEventListener('click', () => ecrire(0));
    pave.appendChild(eff);

    function ecrire(v) {
      if (!sel || bloc.classList.contains('sd-fini')) return;
      const [r, c] = sel;
      if (depart[r][c]) return;
      saisie[r][c] = saisie[r][c] === v ? 0 : v;
      stock.set(cle, saisie);
      bloc.querySelectorAll('.sd-faux').forEach((e) => e.classList.remove('sd-faux'));
      dessiner();
    }

    function conflit(r, c) {
      const v = saisie[r][c];
      if (!v) return false;
      for (let i = 0; i < n; i++) {
        if (i !== c && saisie[r][i] === v) return true;
        if (i !== r && saisie[i][c] === v) return true;
      }
      const r0 = r - r % bh, c0 = c - c % bw;
      for (let i = 0; i < bh; i++) for (let j = 0; j < bw; j++) {
        const rr = r0 + i, cc = c0 + j;
        if ((rr !== r || cc !== c) && saisie[rr][cc] === v) return true;
      }
      return false;
    }

    function dessiner() {
      const vSel = sel ? saisie[sel[0]][sel[1]] : 0;
      let remplies = 0, aRemplir = 0;
      for (const k of cases) {
        const { r, c, el } = k, v = saisie[r][c];
        el.textContent = v || '';
        const memeZone = sel && (sel[0] === r || sel[1] === c ||
          (Math.floor(sel[0] / bh) === Math.floor(r / bh) && Math.floor(sel[1] / bw) === Math.floor(c / bw)));
        el.classList.toggle('sd-sel', !!sel && sel[0] === r && sel[1] === c);
        el.classList.toggle('sd-zone', !!memeZone);
        el.classList.toggle('sd-meme', !!vSel && v === vSel);
        el.classList.toggle('sd-conflit', !depart[r][c] && conflit(r, c));
        if (!depart[r][c]) { aRemplir++; if (v) remplies++; }
      }
      score.textContent = `${remplies} / ${aRemplir} cases`;
      const gagne = saisie.every((l, r) => l.every((v, c) => v === sol[r][c]));
      if (gagne && !bloc.classList.contains('sd-fini')) {
        bloc.classList.add('sd-fini');
        sel = null;
        victoire.hidden = false;
        victoire.innerHTML = `<strong>Sudoku réussi ! 🎉</strong>${cfg.messageVictoire ? `<span>${echap(cfg.messageVictoire)}</span>` : ''}`;
        paillettes(grille);
        dessiner();
      }
    }

    bloc.querySelector('.sd-verifier').addEventListener('click', () => {
      let faux = 0;
      for (const { r, c, el } of cases) {
        const ko = !depart[r][c] && saisie[r][c] && saisie[r][c] !== sol[r][c];
        el.classList.toggle('sd-faux', !!ko);
        if (ko) faux++;
      }
      bulle(faux ? `${faux} chiffre${faux > 1 ? 's' : ''} pas à la bonne place 🤔` : 'Tout ce que tu as mis est juste ! 👏');
    });

    dessiner();
  }

  /* ---------------- Mots fléchés ---------------- */
  function jeuMotsFleches(zone, cfg, jour) {
    const sansAccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    const sol = cfg.grille.map((l) => [...sansAccent(l.replace(/\s/g, ''))].map((ch) => (/[A-Z]/.test(ch) ? ch : null)));
    const H = sol.length, W = Math.max(...sol.map((l) => l.length));
    const estLettre = (r, c) => r >= 0 && c >= 0 && r < H && c < W && !!sol[r][c];
    const cle = `avent-fleches-${ANNEE}-${jour}`;
    const FLECHES = { droite: '▸', bas: '▾', 'bas-droite': '↳', 'droite-bas': '↴' };

    // Mots à partir des définitions
    const mots = [];
    for (const d of cfg.definitions || []) {
      const r = (d.ligne | 0) - 1, c = (d.colonne | 0) - 1, sens = d.sens in FLECHES ? d.sens : 'droite';
      let sr = r, sc = c, h = true;
      if (sens === 'droite') sc = c + 1;
      else if (sens === 'bas') { sr = r + 1; h = false; }
      else if (sens === 'bas-droite') sr = r + 1;
      else { sc = c + 1; h = false; }
      const cases = [];
      for (let rr = sr, cc = sc; estLettre(rr, cc); h ? cc++ : rr++) cases.push([rr, cc]);
      if (!cases.length) { console.warn('Mots fléchés : définition sans mot', d); continue; }
      mots.push({ r, c, sens, h, texte: d.texte || '', cases });
    }
    const motsDe = (r, c, h) => mots.find((m) => m.h === h && m.cases.some(([a, b]) => a === r && b === c));

    const vide = () => sol.map((l) => l.map((v) => (v ? '' : null)));
    let saisie = stock.get(cle);
    if (!Array.isArray(saisie) || saisie.length !== H) saisie = vide();
    let sel = null, horiz = true;

    const bloc = document.createElement('div');
    bloc.className = 'fleches';
    bloc.innerHTML = `
      <div class="sd-entete"><span class="sd-score"></span><button type="button" class="sd-verifier">✔ Vérifier</button></div>
      <div class="mf-def" aria-live="polite"></div>
      <div class="mf-grille" style="--w:${W};--h:${H}"></div>
      <div class="mf-clavier"></div>
      <p class="sd-aide">Touche une case bleue ou une case blanche pour voir la définition. Retouche la même case pour changer de sens.</p>
      <div class="sd-victoire" hidden></div>`;
    zone.appendChild(bloc);
    const grille = bloc.querySelector('.mf-grille');
    const bandeau = bloc.querySelector('.mf-def');
    const score = bloc.querySelector('.sd-score');
    const victoire = bloc.querySelector('.sd-victoire');
    const els = [];

    for (let r = 0; r < H; r++) {
      els.push([]);
      for (let c = 0; c < W; c++) {
        const b = document.createElement('button');
        b.type = 'button';
        if (sol[r][c]) {
          b.className = 'mf-case';
          b.addEventListener('click', () => choisir(r, c));
        } else {
          const ORDRE = { 'droite-bas': 0, droite: 1, bas: 2, 'bas-droite': 3 };
          const ds = mots.filter((m) => m.r === r && m.c === c).sort((a, b) => ORDRE[a.sens] - ORDRE[b.sens]);
          b.className = ds.length ? 'mf-defcase' : 'mf-decor';
          b.innerHTML = ds.length
            ? ds.map((m) => `<span class="mf-txt"><span class="mf-in">${echap(m.texte)}</span></span>`).join('') +
              ds.map((m, i) => `<i class="mf-f mf-${m.sens}" style="--y:${((i + 0.5) / ds.length) * 100}%">${FLECHES[m.sens]}</i>`).join('')
            : '<span>✦</span>';
          if (ds.length > 1) b.classList.add('mf-double');
          if (ds.length) {
            b.setAttribute('aria-label', ds.map((m) => m.texte).join(' / '));
            b.addEventListener('click', () => {
              const actuel = sel && ds.findIndex((m) => m === motCourant());
              const m = ds[(actuel >= 0 ? actuel + 1 : 0) % ds.length];
              sel = m.cases[0].slice(); horiz = m.h;
              const premierVide = m.cases.find(([a, bb]) => !saisie[a][bb]);
              if (premierVide) sel = premierVide.slice();
              dessiner();
            });
          } else b.tabIndex = -1;
        }
        grille.appendChild(b);
        els[r].push(b);
      }
    }

    const clavier = bloc.querySelector('.mf-clavier');
    for (const rangee of ['AZERTYUIOP', 'QSDFGHJKLM', 'WXCVBN⌫']) {
      const ligne = document.createElement('div');
      for (const k of rangee) {
        const t = document.createElement('button');
        t.type = 'button'; t.textContent = k;
        if (k === '⌫') t.className = 'sd-effacer';
        t.addEventListener('click', () => (k === '⌫' ? effacer() : ecrire(k)));
        ligne.appendChild(t);
      }
      clavier.appendChild(ligne);
    }

    function motCourant() {
      if (!sel) return null;
      return motsDe(sel[0], sel[1], horiz) || null;
    }
    function choisir(r, c) {
      if (bloc.classList.contains('sd-fini')) return;
      if (sel && sel[0] === r && sel[1] === c) {
        if (motsDe(r, c, !horiz)) horiz = !horiz;
      } else {
        sel = [r, c];
        if (!motsDe(r, c, horiz) && motsDe(r, c, !horiz)) horiz = !horiz;
      }
      dessiner();
    }
    function avancer(pas) {
      const m = motCourant();
      if (m) {
        const i = m.cases.findIndex(([a, b]) => a === sel[0] && b === sel[1]) + pas;
        if (i >= 0 && i < m.cases.length) sel = m.cases[i].slice();
        return;
      }
      const r = sel[0] + (horiz ? 0 : pas), c = sel[1] + (horiz ? pas : 0);
      if (estLettre(r, c)) sel = [r, c];
    }
    function sauver() {
      stock.set(cle, saisie);
      bloc.querySelectorAll('.sd-faux').forEach((e) => e.classList.remove('sd-faux'));
    }
    function ecrire(l) {
      if (!sel || bloc.classList.contains('sd-fini')) return;
      saisie[sel[0]][sel[1]] = l;
      sauver(); avancer(1); dessiner();
    }
    function effacer() {
      if (!sel || bloc.classList.contains('sd-fini')) return;
      if (!saisie[sel[0]][sel[1]]) avancer(-1);
      saisie[sel[0]][sel[1]] = '';
      sauver(); dessiner();
    }

    function dessiner() {
      const m = motCourant();
      let remplies = 0, total = 0;
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        const el = els[r][c];
        el.classList.toggle('mf-actif', !!m && m.r === r && m.c === c);
        if (!sol[r][c]) continue;
        total++;
        if (saisie[r][c]) remplies++;
        el.textContent = saisie[r][c] || '';
        el.classList.toggle('sd-sel', !!sel && sel[0] === r && sel[1] === c);
        el.classList.toggle('sd-zone', !!m && m.cases.some(([a, b]) => a === r && b === c));
      }
      score.textContent = `${remplies} / ${total} lettres`;
      bandeau.innerHTML = m
        ? `<b>${FLECHES[m.sens]}</b> ${echap(m.texte)} <small>(${m.cases.length} lettres)</small>`
        : (sel ? '<span>Pas de définition dans ce sens</span>' : '<span>Touche une case pour commencer ✏️</span>');
      const gagne = sol.every((l, r) => l.every((v, c) => !v || saisie[r][c] === v));
      if (gagne && !bloc.classList.contains('sd-fini')) {
        bloc.classList.add('sd-fini');
        sel = null;
        victoire.hidden = false;
        victoire.innerHTML = `<strong>Grille terminée ! 🎉</strong>${cfg.messageVictoire ? `<span>${echap(cfg.messageVictoire)}</span>` : ''}`;
        paillettes(grille);
        dessiner();
      }
    }

    bloc.querySelector('.sd-verifier').addEventListener('click', () => {
      let faux = 0;
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        const ko = !!sol[r][c] && !!saisie[r][c] && saisie[r][c] !== sol[r][c];
        els[r][c].classList.toggle('sd-faux', ko);
        if (ko) faux++;
      }
      bulle(faux ? `${faux} lettre${faux > 1 ? 's' : ''} pas bonne${faux > 1 ? 's' : ''} 🤔` : 'Tout ce que tu as mis est juste ! 👏');
    });

    // Clavier de l'ordinateur
    function touche(e) {
      if (!bloc.isConnected) { document.removeEventListener('keydown', touche); return; }
      if (!sel || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = sansAccent(e.key);
      if (/^[A-Z]$/.test(k)) { e.preventDefault(); ecrire(k); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); effacer(); }
      else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const [dr, dc] = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
        let r = sel[0] + dr, c = sel[1] + dc;
        while (r >= 0 && c >= 0 && r < H && c < W && !sol[r][c]) { r += dr; c += dc; }
        if (estLettre(r, c)) { sel = [r, c]; if (motsDe(r, c, dc !== 0)) horiz = dc !== 0; dessiner(); }
      }
    }
    document.addEventListener('keydown', touche);

    // Rétrécit le texte d'une définition jusqu'à ce qu'il tienne dans sa case
    function ajusterTextes() {
      const cote = grille.clientWidth / W;
      for (const t of grille.querySelectorAll('.mf-txt')) {
        if (!t.clientWidth) continue;
        const double = t.parentElement.classList.contains('mf-double');
        let px = Math.min(cote * (double ? 0.15 : 0.18), 15);
        t.style.fontSize = px + 'px';
        const cs = getComputedStyle(t), dedans = t.firstElementChild;
        const haut = t.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        const plage = document.createRange();
        plage.selectNodeContents(dedans);
        const tropLarge = () => [...plage.getClientRects()].some((x) => x.width > dedans.clientWidth + 0.5);
        while (px > 5 && (dedans.offsetHeight > haut + 0.5 || tropLarge())) {
          px -= 0.25; t.style.fontSize = px + 'px';
        }
      }
    }
    // Séparation foncée entre deux mots différents qui se touchent
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      if (!sol[r][c]) continue;
      const ensemble = (r2, c2, h) => mots.some((m) => m.h === h &&
        m.cases.some(([a, b]) => a === r && b === c) && m.cases.some(([a, b]) => a === r2 && b === c2));
      if (estLettre(r, c + 1) && !ensemble(r, c + 1, true)) els[r][c].classList.add('mf-sep-d');
      if (estLettre(r + 1, c) && !ensemble(r + 1, c, false)) els[r][c].classList.add('mf-sep-b');
    }
    if (window.ResizeObserver) new ResizeObserver(ajusterTextes).observe(grille);
    else requestAnimationFrame(ajusterTextes);

    dessiner();
  }

  /* ---------------- Lettres du prénom en gros, un mot autour de chacune ---------------- */
  function afficherLettresNom(zone, cfg) {
    const simple = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    const bloc = document.createElement('div');
    bloc.className = 'acro';
    let html = cfg.titre ? `<h3 class="acro-titre">${echap(cfg.titre)}</h3>` : '';
    html += '<div class="acro-grille">';
    let k = 0, delai = 0;
    for (const ch of cfg.nom) {
      if (!/\S/.test(ch)) { html += '<div class="acro-espace"></div>'; continue; }
      const mot = String(cfg.mots?.[k++] ?? '').trim();
      const cible = simple(ch);
      let avant = '', apres = '';
      if (/^\[.*\]$/.test(mot) || !mot) apres = mot;            // emplacement pas encore rempli
      else {
        // la lettre en MAJUSCULE dans le mot si tu l'as indiquée, sinon la première qui correspond
        let i = [...mot].findIndex((c) => c !== c.toLowerCase() && simple(c) === cible);
        if (i < 0) i = [...mot].findIndex((c) => simple(c) === cible);
        const lettres = [...mot];
        if (i < 0) apres = mot;
        else { avant = lettres.slice(0, i).join(''); apres = lettres.slice(i + 1).join(''); }
      }
      html += `<span class="acro-avant">${echap(avant.toLowerCase())}</span>` +
        `<span class="acro-lettre" style="animation-delay:${delai}s">${echap(ch.toUpperCase())}</span>` +
        `<span class="acro-apres${/^\[/.test(apres) ? ' acro-vide' : ''}">${echap(/^\[/.test(apres) ? apres : apres.toLowerCase())}</span>`;
      delai += 0.12;
    }
    html += '</div>';
    if (cfg.signature) html += `<p class="acro-signature">${echap(cfg.signature)}</p>`;
    bloc.innerHTML = html;
    zone.appendChild(bloc);
  }

  /* ---------------- Quiz ---------------- */
  function jeuQuiz(zone, cfg, jour) {
    const cle = `avent-quiz-${ANNEE}-${jour}`;
    const qs = cfg.questions.filter((q) => q?.question && q.choix?.length);
    let rep = stock.get(cle);
    if (!Array.isArray(rep)) rep = [];
    const bloc = document.createElement('div');
    bloc.className = 'qz';
    zone.appendChild(bloc);
    const bonneIdx = (q) => Math.max(0, Math.min(q.choix.length - 1, (Number(q.bonne) || 1) - 1));
    const score = () => rep.filter((r, i) => qs[i] && r === bonneIdx(qs[i])).length;

    function dessiner() {
      const i = rep.length;
      if (i >= qs.length) return fin();
      const q = qs[i];
      bloc.innerHTML = `
        ${cfg.titre ? `<h3 class="qz-titre">${echap(cfg.titre)}</h3>` : ''}
        <div class="qz-entete"><span>Question ${i + 1} / ${qs.length}</span><span class="qz-pts">${score()} ✓</span></div>
        <div class="qz-barre"><u style="width:${(i / qs.length) * 100}%"></u></div>
        <p class="qz-question">${echap(q.question)}</p>
        <div class="qz-choix">${q.choix.map((c, k) => `<button type="button" data-k="${k}"><b>${'ABCDEFGH'[k] || k + 1}</b><span>${echap(c)}</span></button>`).join('')}</div>
        <div class="qz-retour" hidden></div>`;
      bloc.querySelectorAll('.qz-choix button').forEach((b) => b.addEventListener('click', () => repondre(+b.dataset.k)));
    }

    function repondre(k) {
      const q = qs[rep.length];
      const bonne = bonneIdx(q);
      const btns = [...bloc.querySelectorAll('.qz-choix button')];
      btns.forEach((b, x) => { b.disabled = true; if (x === bonne) b.classList.add('qz-bon'); else if (x === k) b.classList.add('qz-faux'); });
      rep.push(k);
      stock.set(cle, rep);
      bloc.querySelector('.qz-pts').textContent = `${score()} ✓`;
      if (k === bonne) paillettes(btns[k]);
      const retour = bloc.querySelector('.qz-retour');
      retour.hidden = false;
      retour.innerHTML = `<strong class="${k === bonne ? 'ok' : 'ko'}">${k === bonne ? 'Bonne réponse ! ❤' : 'Raté !'}</strong>` +
        (q.anecdote ? `<span>${echap(q.anecdote)}</span>` : '') +
        `<button type="button" class="qz-suivant">${rep.length < qs.length ? 'Question suivante →' : 'Voir mon score 🎉'}</button>`;
      retour.querySelector('button').addEventListener('click', dessiner);
    }

    function fin() {
      const s = score(), n = qs.length;
      const palier = s === n ? 'Parfait, tu me connais par cœur ! 💯' : s >= n * 0.7 ? 'Très fort, mon cœur ! 🥰' : s >= n * 0.4 ? 'Pas mal du tout ! 😘' : 'Il va falloir réviser… avec moi 😏';
      bloc.innerHTML = `
        ${cfg.titre ? `<h3 class="qz-titre">${echap(cfg.titre)}</h3>` : ''}
        <div class="qz-fin">
          <div class="qz-note">${s}<small>/ ${n}</small></div>
          <strong>${palier}</strong>
          ${cfg.messageFin ? `<span>${echap(cfg.messageFin)}</span>` : ''}
          <ol class="qz-recap">${qs.map((q, i) => `<li class="${rep[i] === bonneIdx(q) ? 'ok' : 'ko'}"><span>${echap(q.question)}</span><em>${echap(q.choix[bonneIdx(q)])}</em></li>`).join('')}</ol>
          <button type="button" class="qz-rejouer">↺ Recommencer</button>
        </div>`;
      bloc.querySelector('.qz-rejouer').addEventListener('click', () => { rep = []; stock.del(cle); dessiner(); });
      if (s >= n * 0.7) paillettes(bloc.querySelector('.qz-note'));
    }
    dessiner();
  }

  /* ---------------- Cadeau offert en vrai ---------------- */
  function afficherCadeauEnVrai(zone, cfg) {
    const c = typeof cfg === 'object' ? cfg : {};
    const bloc = document.createElement('div');
    bloc.className = 'cv' + (c.festif ? ' cv-festif' : '');
    // Version festive : neige qui tombe, guirlande lumineuse, bandeau, plusieurs paquets, explosions de paillettes
    const neige = c.festif ? Array.from({ length: 26 }, (_, i) =>
      `<i style="left:${(i * 37) % 100}%;animation-delay:${-((i * 0.7) % 6).toFixed(2)}s;animation-duration:${5 + (i % 5)}s;font-size:${0.6 + (i % 4) * 0.25}rem">${'❄✦❅★'[i % 4]}</i>`).join('') : '';
    const guirlande = c.festif ? Array.from({ length: 14 }, (_, i) => `<b style="animation-delay:${(i % 4) * 0.35}s"></b>`).join('') : '';
    bloc.innerHTML = `
      ${c.festif ? `<div class="cv-neige" aria-hidden="true">${neige}</div><div class="cv-guirlande" aria-hidden="true">${guirlande}</div>` : ''}
      ${c.festif && c.bandeau !== '' ? `<p class="cv-bandeau">${echap(c.bandeau || 'Joyeux Noël')}</p>` : ''}
      ${c.festif ? '<div class="cv-pile" aria-hidden="true"><span>🎁</span><span class="cv-paquet">🎁</span><span>🎁</span></div>' : '<div class="cv-paquet" aria-hidden="true">🎁</div>'}
      <h3 class="cv-titre">${echap(c.titre || 'Ce cadeau-là, tu l’auras en vrai')}</h3>
      <p class="cv-texte">${echap(c.texte || 'Pas d’écran aujourd’hui : je te le donne en main propre.')}</p>
      ${c.indice ? `<p class="cv-indice"><b>Petit indice</b>${echap(c.indice)}</p>` : ''}
      ${c.signature ? `<p class="cv-signature">${echap(c.signature)}</p>` : ''}`;
    zone.appendChild(bloc);
    setTimeout(() => paillettes(bloc.querySelector('.cv-paquet')), 350);
    if (c.festif) {
      // quelques explosions de paillettes en plus, à différents endroits
      [700, 1100, 1500, 2100].forEach((t, i) => setTimeout(() => {
        if (!bloc.isConnected) return;
        paillettes(bloc.querySelectorAll('.cv-pile span, .cv-titre, .cv-bandeau')[i % 4] || bloc);
      }, t));
    }
  }

  /* ---------------- Jeu des paires (memory) ---------------- */
  function jeuPaires(zone, cfg, jour) {
    const cle = `avent-paires-${ANNEE}-${jour}`;
    const photos = cfg.photos.filter(Boolean);
    const n = photos.length * 2;
    let etat = stock.get(cle);
    if (!etat || !Array.isArray(etat.ordre) || etat.ordre.length !== n) etat = null;
    const nouveau = () => {
      const ordre = [...Array(n).keys()].map((i) => i % photos.length);
      for (let i = n - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [ordre[i], ordre[k]] = [ordre[k], ordre[i]]; }
      return { ordre, trouvees: [], coups: 0 };
    };
    etat = etat || nouveau();
    const cols = n <= 12 ? 3 : n <= 16 ? 4 : Math.ceil(Math.sqrt(n));

    const bloc = document.createElement('div');
    bloc.className = 'mem';
    zone.appendChild(bloc);
    let ouvertes = [], bloque = false;

    function dessiner() {
      bloc.innerHTML = `
        <div class="sd-entete"><span class="sd-score"></span><button type="button" class="sd-verifier">↺ Recommencer</button></div>
        <div class="mem-grille" style="--cols:${cols}"></div>
        <p class="sd-aide">Retourne deux cartes à la fois et retrouve les paires de photos.</p>
        <div class="sd-victoire" hidden></div>`;
      const grille = bloc.querySelector('.mem-grille');
      etat.ordre.forEach((ph, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mem-carte' + (etat.trouvees.includes(ph) ? ' mem-ouverte mem-trouvee' : '');
        b.setAttribute('aria-label', 'Carte ' + (i + 1));
        b.innerHTML = `<span class="mem-int"><span class="mem-dos">❤</span><span class="mem-face"><img alt="" draggable="false"></span></span>`;
        b.querySelector('img').src = photos[ph];
        b.addEventListener('click', () => retourner(b, ph));
        grille.appendChild(b);
      });
      bloc.querySelector('.sd-verifier').addEventListener('click', () => { etat = nouveau(); stock.set(cle, etat); ouvertes = []; bloque = false; dessiner(); });
      maj();
    }

    function maj() {
      bloc.querySelector('.sd-score').textContent = `${etat.trouvees.length} / ${photos.length} paires · ${etat.coups} coup${etat.coups > 1 ? 's' : ''}`;
      if (etat.trouvees.length === photos.length) {
        const v = bloc.querySelector('.sd-victoire');
        if (v.hidden) {
          v.hidden = false;
          v.innerHTML = `<strong>Toutes les paires trouvées ! 📸</strong><span>en ${etat.coups} coups</span>${cfg.messageVictoire ? `<span>${echap(cfg.messageVictoire)}</span>` : ''}`;
          bloc.classList.add('mem-fini');
        }
      }
    }

    function retourner(b, ph) {
      if (bloque || b.classList.contains('mem-ouverte')) return;
      b.classList.add('mem-ouverte');
      ouvertes.push({ b, ph });
      if (ouvertes.length < 2) return;
      etat.coups++;
      const [a, c] = ouvertes;
      ouvertes = [];
      if (a.ph === c.ph) {
        etat.trouvees.push(ph);
        setTimeout(() => { a.b.classList.add('mem-trouvee'); c.b.classList.add('mem-trouvee'); paillettes(c.b); }, 350);
        stock.set(cle, etat); maj();
      } else {
        bloque = true;
        stock.set(cle, etat); maj();
        setTimeout(() => { a.b.classList.remove('mem-ouverte'); c.b.classList.remove('mem-ouverte'); bloque = false; }, 950);
      }
    }
    dessiner();
  }

  /* ---------------- Pendu ---------------- */
  function jeuPendu(zone, cfg, jour) {
    const cle = `avent-pendu-${ANNEE}-${jour}`;
    const simple = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    const mot = [...String(cfg.mot).trim()];
    const lettresMot = new Set(mot.map(simple).filter((c) => /[A-Z]/.test(c)));
    const MAX = 7;
    let essais = stock.get(cle);
    if (!Array.isArray(essais)) essais = [];

    const bloc = document.createElement('div');
    bloc.className = 'pdu';
    // Le dessin : potence (toujours là), puis 7 étapes, une par erreur
    bloc.innerHTML = `
      <div class="sd-entete"><span class="sd-score"></span><button type="button" class="sd-verifier">↺ Recommencer</button></div>
      <svg class="pdu-dessin" viewBox="0 0 200 170" aria-hidden="true">
        <g class="pdu-potence"><path d="M20 160h110M45 160V12h85v20"/></g>
        <circle class="pdu-e" cx="130" cy="47" r="15"/>
        <path class="pdu-e" d="M130 62v45"/>
        <path class="pdu-e" d="M130 72l-22 18"/>
        <path class="pdu-e" d="M130 72l22 18"/>
        <path class="pdu-e" d="M130 107l-18 30"/>
        <path class="pdu-e" d="M130 107l18 30"/>
        <path class="pdu-e pdu-bonnet" d="M115 37q15-26 30 0zM145 35l7-12"/>
      </svg>
      ${cfg.indice ? `<p class="pdu-indice"><b>Indice</b>${echap(cfg.indice)}</p>` : ''}
      <div class="pdu-mot"></div>
      <div class="mf-clavier pdu-clavier"></div>
      <div class="sd-victoire" hidden></div>`;
    zone.appendChild(bloc);
    const clavier = bloc.querySelector('.pdu-clavier');
    ['AZERTYUIOP', 'QSDFGHJKLM', 'WXCVBN'].forEach((ligne) => {
      const d = document.createElement('div');
      for (const l of ligne) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = l; b.dataset.l = l;
        b.addEventListener('click', () => jouer(l));
        d.appendChild(b);
      }
      clavier.appendChild(d);
    });
    bloc.querySelector('.sd-verifier').addEventListener('click', () => { essais = []; stock.del(cle); dessiner(); });
    function touche(e) {
      if (!bloc.isConnected) return document.removeEventListener('keydown', touche);
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const l = simple(e.key || '');
      if (/^[A-Z]$/.test(l)) { e.preventDefault(); jouer(l); }
    }
    document.addEventListener('keydown', touche);

    const erreurs = () => essais.filter((l) => !lettresMot.has(l)).length;
    const gagne = () => [...lettresMot].every((l) => essais.includes(l));

    function jouer(l) {
      if (essais.includes(l) || gagne() || erreurs() >= MAX) return;
      essais.push(l);
      stock.set(cle, essais);
      dessiner(l);
    }

    function dessiner(derniere) {
      const err = erreurs(), fini = gagne(), perdu = !fini && err >= MAX;
      const reste = MAX - err;
      bloc.querySelector('.sd-score').textContent = `${reste} essai${reste > 1 ? 's' : ''} restant${reste > 1 ? 's' : ''}`;
      bloc.querySelectorAll('.pdu-e').forEach((el, i) => el.classList.toggle('pdu-vu', i < err));
      bloc.querySelector('.pdu-mot').innerHTML = mot.map((c) => {
        const s = simple(c);
        if (!/[A-Z]/.test(s)) return c === ' ' ? '<span class="pdu-espace"></span>' : `<span class="pdu-sep">${echap(c)}</span>`;
        const trouve = essais.includes(s);
        const vu = trouve || perdu;
        return `<span class="pdu-l${perdu && !trouve ? ' pdu-rate' : ''}${s === derniere ? ' pdu-neuf' : ''}">${vu ? echap(c.toUpperCase()) : ''}</span>`;
      }).join('');
      clavier.querySelectorAll('button').forEach((b) => {
        const l = b.dataset.l, joue = essais.includes(l);
        b.disabled = joue || fini || perdu;
        b.className = joue ? (lettresMot.has(l) ? 'pdu-bon' : 'pdu-faux') : '';
      });
      bloc.classList.toggle('sd-fini', fini);
      bloc.classList.toggle('pdu-perdu', perdu);
      const v = bloc.querySelector('.sd-victoire');
      v.hidden = !(fini || perdu);
      if (fini) {
        v.innerHTML = `<strong>Trouvé ! 🎉</strong>${cfg.messageVictoire ? `<span>${echap(cfg.messageVictoire)}</span>` : ''}`;
        if (derniere) paillettes(bloc.querySelector('.pdu-mot'));
      } else if (perdu) {
        v.innerHTML = `<strong>Perdu… 🙈</strong>${cfg.messageDefaite ? `<span>${echap(cfg.messageDefaite)}</span>` : ''}<span>Appuie sur « Recommencer » pour retenter.</span>`;
      }
    }
    dessiner();
  }

  /* ---------------- Wish list (lettre) ---------------- */
  function afficherWishlist(zone, cfg, jour) {
    const cle = `avent-wishlist-${ANNEE}-${jour}`;
    const faits = new Set(stock.get(cle) || []);
    const lettre = document.createElement('div');
    lettre.className = 'lettre';
    lettre.innerHTML = `
      <div class="lettre-cachet" aria-hidden="true">❤</div>
      <h3 class="lettre-titre"></h3>
      <p class="lettre-intro"></p>
      <ol class="lettre-liste"></ol>
      <p class="lettre-compte"></p>
      <p class="lettre-signature"></p>`;
    lettre.querySelector('.lettre-titre').textContent = cfg.titre || '';
    lettre.querySelector('.lettre-intro').textContent = cfg.intro || '';
    lettre.querySelector('.lettre-signature').textContent = cfg.signature || '';
    const liste = lettre.querySelector('.lettre-liste');
    const compte = lettre.querySelector('.lettre-compte');
    const majCompte = () => {
      compte.textContent = faits.size ? `${faits.size} / ${cfg.souhaits.length} réalisé${faits.size > 1 ? 's' : ''} ensemble ♡` : 'Coche un souhait quand on l’aura fait ensemble ♡';
    };
    cfg.souhaits.forEach((s, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<label><input type="checkbox"><span class="lettre-num">${i + 1}.</span><span class="lettre-souhait"></span></label>`;
      li.querySelector('.lettre-souhait').textContent = s;
      const cb = li.querySelector('input');
      cb.checked = faits.has(i);
      li.classList.toggle('fait', cb.checked);
      cb.addEventListener('change', () => {
        cb.checked ? faits.add(i) : faits.delete(i);
        li.classList.toggle('fait', cb.checked);
        stock.set(cle, [...faits]);
        majCompte();
        if (cb.checked) paillettes(li);
      });
      liste.appendChild(li);
    });
    majCompte();
    zone.appendChild(lettre);
  }

  /* ---------------- Coupons ---------------- */
  function afficherCoupons(zone, cfg, jour) {
    const cle = `avent-coupons-${ANNEE}-${jour}`;
    const utilises = stock.get(cle) || {};
    const bloc = document.createElement('div');
    bloc.className = 'coupons';
    cfg.liste.forEach((cp, i) => {
      const el = document.createElement('div');
      el.className = 'coupon';
      el.innerHTML = `
        <div class="coupon-talon"><span>N°</span><b>${i + 1}</b></div>
        <div class="coupon-corps">
          <p class="coupon-entete"></p>
          <p class="coupon-texte"></p>
          <p class="coupon-detail"></p>
          <button type="button" class="coupon-bouton">Utiliser ce coupon</button>
        </div>
        <div class="coupon-tampon" aria-hidden="true"><span>Utilisé</span><small></small></div>`;
      el.querySelector('.coupon-entete').textContent = cfg.entete || '';
      el.querySelector('.coupon-texte').textContent = cp.texte || '';
      el.querySelector('.coupon-detail').textContent = cp.detail || '';
      const maj = () => {
        const d = utilises[i];
        el.classList.toggle('utilise', !!d);
        el.querySelector('.coupon-tampon small').textContent = d
          ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : '';
        el.querySelector('.coupon-bouton').textContent = d ? 'Annuler' : 'Utiliser ce coupon';
      };
      el.querySelector('.coupon-bouton').addEventListener('click', () => {
        if (utilises[i]) {
          if (!confirm('Remettre ce coupon comme non utilisé ?')) return;
          delete utilises[i];
        } else {
          if (!confirm('Utiliser ce coupon maintenant ? 🎟️')) return;
          utilises[i] = Date.now();
          paillettes(el);
        }
        stock.set(cle, utilises);
        maj();
      });
      maj();
      bloc.appendChild(el);
    });
    zone.appendChild(bloc);
  }

  /* ---------------- Jeu : mots mêlés ---------------- */
  function jeuMotsMeles(zone, cfg, jour) {
    const lignes = cfg.grille.map((l) => l.toUpperCase().replace(/\s/g, ''));
    const R = lignes.length, C = Math.max(...lignes.map((l) => l.length));
    const mots = cfg.mots.map((m) => m.toUpperCase().replace(/\s/g, ''));
    const cleSauvegarde = `avent-mm-${ANNEE}-${jour}`;
    const couleurs = ['#e85d5d', '#4fb37f', '#e9a53a', '#5a8fe0', '#c86ad6', '#2bb3b3', '#ef7aa8', '#8a9c3a'];
    // trouves : { MOT: [r1, c1, r2, c2] }
    let trouves = stock.get(cleSauvegarde) || {};

    zone.innerHTML = `
      <div class="mm-entete">
        <span class="mm-score"></span>
        <button type="button" class="mm-indice">💡 Indice</button>
      </div>
      <div class="mm-plateau" style="--cols:${C};--rows:${R}">
        <svg class="mm-traits" viewBox="0 0 ${C} ${R}" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="mm-grille"></div>
      </div>
      <p class="mm-aide">Glisse ton doigt sur un mot (ou touche la première puis la dernière lettre).</p>
      <ul class="mm-mots"></ul>
      <div class="mm-victoire" hidden></div>`;

    const plateau = zone.querySelector('.mm-plateau');
    const grilleEl = zone.querySelector('.mm-grille');
    const svg = zone.querySelector('.mm-traits');
    const liste = zone.querySelector('.mm-mots');
    const score = zone.querySelector('.mm-score');
    const victoire = zone.querySelector('.mm-victoire');

    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const d = document.createElement('span');
        d.className = 'mm-lettre';
        d.dataset.r = r; d.dataset.c = c;
        d.textContent = lignes[r][c] || '';
        grilleEl.appendChild(d);
      }
    }
    mots.forEach((m) => {
      const li = document.createElement('li'); li.dataset.mot = m; li.textContent = m; liste.appendChild(li);
    });

    // Lettres sur la ligne entre deux cases (horizontale, verticale ou diagonale), sinon null
    function chemin(a, b) {
      const dr = Math.sign(b.r - a.r), dc = Math.sign(b.c - a.c);
      const n = Math.max(Math.abs(b.r - a.r), Math.abs(b.c - a.c));
      if (!(a.r === b.r || a.c === b.c || Math.abs(b.r - a.r) === Math.abs(b.c - a.c))) return null;
      let s = '';
      for (let i = 0; i <= n; i++) s += lignes[a.r + dr * i][a.c + dc * i] || '';
      return s;
    }

    const trait = (r1, c1, r2, c2, coul, cls) => {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l.setAttribute('x1', c1 + 0.5); l.setAttribute('y1', r1 + 0.5);
      l.setAttribute('x2', c2 + 0.5); l.setAttribute('y2', r2 + 0.5);
      l.setAttribute('stroke', coul);
      l.setAttribute('class', cls);
      svg.appendChild(l);
      return l;
    };

    function dessiner() {
      svg.innerHTML = '';
      Object.entries(trouves).forEach(([m, p]) => trait(...p, couleurs[mots.indexOf(m) % couleurs.length], 'mm-trouve'));
      liste.querySelectorAll('li').forEach((li) => li.classList.toggle('fait', !!trouves[li.dataset.mot]));
      const n = Object.keys(trouves).length;
      score.textContent = `${n} / ${mots.length} mots`;
      if (n === mots.length) {
        victoire.hidden = false;
        victoire.innerHTML = `<strong>Bravo ! 🎉</strong>${cfg.messageVictoire ? `<span>${echap(cfg.messageVictoire)}</span>` : ''}`;
      }
    }

    // ---- Sélection au doigt / à la souris ----
    let debut = null, fin = null, ancre = null, glisse = false, traitSel = null;
    const caseSous = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      return el && el.classList.contains('mm-lettre') && grilleEl.contains(el) ? { r: +el.dataset.r, c: +el.dataset.c, el } : null;
    };
    function majSelection() {
      if (traitSel) traitSel.remove();
      traitSel = null;
      if (!debut) return;
      const b = fin && chemin(debut, fin) ? fin : debut;
      traitSel = trait(debut.r, debut.c, b.r, b.c, '#f1cf75', 'mm-selection');
    }
    function valider(a, b) {
      const s = chemin(a, b);
      if (!s || s.length < 2) return false;
      const inv = [...s].reverse().join('');
      const m = mots.find((x) => !trouves[x] && (x === s || x === inv));
      if (!m) return false;
      trouves[m] = [a.r, a.c, b.r, b.c];
      stock.set(cleSauvegarde, trouves);
      dessiner();
      const li = liste.querySelector(`[data-mot="${m}"]`);
      li?.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 400 });
      if (Object.keys(trouves).length === mots.length) paillettes(plateau);
      return true;
    }
    function rate() {
      plateau.classList.remove('mm-rate'); void plateau.offsetWidth; plateau.classList.add('mm-rate');
    }

    plateau.addEventListener('pointerdown', (e) => {
      const p = caseSous(e);
      if (!p) return;
      e.preventDefault();
      if (ancre && (ancre.r !== p.r || ancre.c !== p.c)) {
        // 2e toucher : on valide de l'ancre jusqu'ici
        if (!valider(ancre, p)) rate();
        ancre = null; debut = null; fin = null; majSelection();
        return;
      }
      debut = p; fin = p; glisse = true; ancre = null;
      plateau.setPointerCapture?.(e.pointerId);
      majSelection();
    });
    plateau.addEventListener('pointermove', (e) => {
      if (!glisse) return;
      const p = caseSous(e);
      if (p && (!fin || p.r !== fin.r || p.c !== fin.c)) { fin = p; majSelection(); }
    });
    const lacher = () => {
      if (!glisse) return;
      glisse = false;
      if (fin && (fin.r !== debut.r || fin.c !== debut.c)) {
        if (!valider(debut, fin)) rate();
        debut = null; fin = null;
      } else {
        ancre = debut; // simple toucher : on attend la dernière lettre
      }
      majSelection();
    };
    plateau.addEventListener('pointerup', lacher);
    plateau.addEventListener('pointercancel', lacher);

    // ---- Indice : fait clignoter la 1re lettre d'un mot restant ----
    zone.querySelector('.mm-indice').addEventListener('click', () => {
      const restants = mots.filter((m) => !trouves[m]);
      if (!restants.length) return;
      const m = restants[Math.floor(Math.random() * restants.length)];
      const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]];
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) for (const [dr, dc] of dirs) {
        const er = r + dr * (m.length - 1), ec = c + dc * (m.length - 1);
        if (er < 0 || er >= R || ec < 0 || ec >= C) continue;
        if (chemin({ r, c }, { r: er, c: ec }) === m) {
          const el = grilleEl.children[r * C + c];
          el.classList.remove('mm-clignote'); void el.offsetWidth; el.classList.add('mm-clignote');
          bulle(`Indice : « ${m} » commence ici 👀`);
          return;
        }
      }
    });

    dessiner();
  }
  $('#fermer').addEventListener('click', fermerFenetre);
  $('#voile').addEventListener('click', (e) => { if (e.target.id === 'voile') fermerFenetre(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#voile').hidden) fermerFenetre(); });

  $('#bouton-verrou').addEventListener('click', () => {
    stock.del(CLE_SESSION, sessionStorage);
    location.reload();
  });

  /* ---------------- Paillettes ---------------- */
  function paillettes(el) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = el.getBoundingClientRect();
    const couleurs = ['#e9c46a', '#f6dfa2', '#ffffff', '#d4433e', '#7ed0a0'];
    for (let i = 0; i < 36; i++) {
      const p = document.createElement('div');
      p.className = 'paillette';
      p.style.background = couleurs[i % couleurs.length];
      p.style.left = r.left + r.width / 2 + 'px';
      p.style.top = r.top + r.height / 2 + 'px';
      document.body.appendChild(p);
      const ang = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 110;
      p.animate([
        { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
        { transform: `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist + 40}px) rotate(${Math.random() * 540}deg)`, opacity: 0 },
      ], { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.2,.8,.3,1)' }).onfinish = () => p.remove();
    }
  }

  /* ---------------- Neige ---------------- */
  function neige() {
    const c = $('#neige');
    const ctx = c.getContext('2d');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let flocons = [];
    function taille() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = innerWidth * dpr; c.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(120, innerWidth / 9));
      flocons = Array.from({ length: n }, () => ({
        x: Math.random() * innerWidth, y: Math.random() * innerHeight,
        r: .6 + Math.random() * 2.2, v: .25 + Math.random() * .8, o: Math.random() * Math.PI * 2,
      }));
    }
    taille();
    addEventListener('resize', taille);
    (function boucle() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.fillStyle = 'rgba(255,255,255,.8)';
      for (const f of flocons) {
        f.y += f.v; f.o += .01; f.x += Math.sin(f.o) * .35;
        if (f.y > innerHeight + 5) { f.y = -5; f.x = Math.random() * innerWidth; }
        ctx.globalAlpha = .35 + f.r / 4;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2); ctx.fill();
      }
      requestAnimationFrame(boucle);
    })();
  }

  /* ---------------- Guirlande lumineuse ---------------- */
  function guirlande() {
    const g = $('#guirlande');
    const couleurs = ['#ff5a4f', '#ffd166', '#5ad19a', '#5aa9ff', '#ff8fd6'];
    const n = 28;
    let html = '<svg viewBox="0 0 1000 60" preserveAspectRatio="none"><path d="';
    for (let k = 0; k < 5; k++) html += `${k ? '' : 'M0 6 '}Q${k * 200 + 100} 56 ${(k + 1) * 200} 6 `;
    html += '" /></svg>';
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n;
      const phase = (x * 5) % 1;
      const y = 6 + 50 * 2 * phase * (1 - phase) * 2 * 0.5;
      html += `<i style="left:${x * 100}%;top:${y}px;--c:${couleurs[i % couleurs.length]};animation-delay:${(i % 5) * 0.35}s"></i>`;
    }
    g.innerHTML = html;
  }

  /* ---------------- Démarrage ---------------- */
  (async function demarrer() {
    if (CFG.titreConnexion) $('#titre-connexion').textContent = CFG.titreConnexion;
    neige();
    guirlande();
    majBlocage();
    await Promise.all([synchroniserHeure(), chargerContenuLocal()]);
    const code = stock.get(CLE_SESSION, sessionStorage);
    if (code) {
      try { ouvrirCalendrier(await dechiffrer(code)); } catch { stock.del(CLE_SESSION, sessionStorage); }
    }
  })();
})();
