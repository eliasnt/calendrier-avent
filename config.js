// ============================================================
//  RÉGLAGES PUBLICS (visibles par tout le monde, même sans code)
//  -> Ne mets RIEN de secret ici. Le contenu secret va dans contenu.js
// ============================================================
window.CONFIG = {
  annee: 2026,          // année du calendrier
  nbJours: 24,          // nombre de cases (24 = jusqu'au 24 décembre)
  fuseauUTC: 1,         // décalage horaire : France en décembre = UTC+1
                        // -> les cases s'ouvrent à minuit heure de Paris

  // Texte affiché sur l'écran du code (avant connexion)
  titreConnexion: "Projet super secret pour Ines",
};
