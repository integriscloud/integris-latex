# Design System — Plateforme de rédaction académique (variante vert toge et or)

Livraison pour l'équipe de développement. Elle couvre les pages 4 à 7 du canevas de design :
le Design System, la landing page, les quatre versions de la page d'accueil et les écrans de
l'application par rôle.

Version 0.1 — novembre 2026. Nom du produit encore à choisir : partout « [Nom du produit] ».

## Contenu du dossier

| Dossier / fichier | Contenu |
|---|---|
| `index.html` | Sommaire cliquable de tous les écrans. Commencer ici. |
| `ecrans-html/` | Chaque écran en HTML statique, ouvrable dans un navigateur. |
| `tokens/tokens.css` | Toutes les variables CSS : couleurs, typographie, espacements, rayons, ombres, mouvement. |
| `sources-canevas/` | Fichiers sources du canevas de design (format `.dc.html`). Utiles seulement pour réimporter dans l'outil de design. Ce ne sont **pas** des fichiers à intégrer dans le code. |

Les pages HTML chargent les polices depuis Google Fonts : il faut une connexion internet pour
les voir avec les bonnes polices. En production, héberger les polices soi-même (voir plus bas).

Les écrans sont des **maquettes** : le HTML sert de référence visuelle (couleurs, tailles,
espacements, textes), pas de code à copier tel quel. Les styles sont écrits en ligne pour la
maquette ; dans l'application, passer par les tokens et des composants.

## Les écrans

### 01 — Design System (`ecrans-html/01-design-system/`)
Fondations et principes, couleurs, typographie, espace et icônes, composants de base,
composants métier (compilation, erreurs en français, commentaires, historique, partage,
paiement mobile money), tokens.

### 02 — Landing page (`ecrans-html/02-landing/`)
⚠ Le texte de cette page ne parle qu'aux étudiants. Il doit être réécrit pour les quatre
publics (établissements, enseignants, étudiants, secrétariats) avant développement.

### 03 — Page d'accueil, 4 versions (`ecrans-html/03-accueil-versions/`)
Quatre propositions de hero animées (soutenance, nuit du dépôt, encadreur, mobile).
Une seule sera retenue.

### 04 — Écrans de l'application par rôle (`ecrans-html/04-ecrans-par-role/`)

| Rôle | Écrans |
|---|---|
| Tous | Carte des parcours · Se connecter · Créer un compte · Choisir son espace |
| Étudiant | Tableau de bord · Partager un document avec un professeur |
| Professeur | Tableau de bord · Relecture et validation d'un chapitre · Rédiger un devoir et l'envoyer au secrétariat |
| Secrétariat | File d'impression · Ouvrir, imprimer et remettre un devoir |
| Administrateur d'établissement | Tableau de bord · Utilisateurs et demandes de rattachement |

## Règles métier visibles dans les maquettes

- **Comptes** : inscription libre (étudiant, enseignant) **ou** invitation par l'établissement.
  Un enseignant inscrit seul doit être confirmé par l'administrateur de l'établissement.
- **Plusieurs rôles** : une même personne peut être professeur, administrateur et doctorante.
  Elle choisit son espace après connexion (écran sauté si un seul rôle) et peut en changer
  depuis le menu latéral sans se reconnecter.
- **Partage** : l'étudiant partage un document avec un professeur de son établissement, rôle
  « Encadrant » (commente, valide, fixe les échéances) ou « Lecteur ». Invitation possible d'un
  professeur absent de la plateforme.
- **Devoirs et impression** : le professeur rédige le sujet (et un corrigé privé, jamais
  transmis), puis envoie une demande d'impression : classe, nombre de copies, format, date de
  mise à disposition, date d'épreuve.
- **Confidentialité des sujets** : le secrétariat ne peut ouvrir un sujet qu'à partir de la date
  fixée par l'enseignant. Chaque ouverture, impression et remise est journalisée (qui, quand).
  L'aperçu porte un filigrane nominatif.
- **Établissement** : licences (ex. 412 / 500), invitations, import de listes (CSV, Excel),
  rattachements à confirmer, classes et filières, modèles officiels imposés, abonnement.

## Couleurs (résumé de `tokens/tokens.css`)

| Rôle | Valeur | Usage |
|---|---|---|
| Toge 600 (`--toge-600`) | `#1F5C40` | Boutons principaux, liens, sélection. Contraste 7,9:1 sur blanc. |
| Toge 900 (`--toge-900`) | `#0C261C` | Menu latéral, panneaux sombres, hero. |
| Or 500 (`--or-500`) | `#94701F` | Accent : offres payantes, moments forts. Texte blanc dessus. |
| Or 600 (`--or-600`) | `#7A5A17` | Or utilisé pour du **texte** sur fond clair. |
| Or 300 (`--or-300`) | `#D6B566` | Or sur fond sombre (icônes, accents). |
| Papier (`--neutre-25`) | `#FBFAF7` | Fond général. |
| Succès | `#3A741B` sur `#ECF5E3` | Toujours avec une coche (pour ne pas confondre avec le vert de marque). |
| Information | `#2B5592` sur `#EAF0F8` | Hors ligne, en attente, aide. |
| Erreur | `#B42318` sur `#FDECEA` | Erreurs, retards, refus. |
| Avertissement | `#8A5A00` sur `#FFF4D6` | Quotas, données d'exemple. |

Couleurs des espaces (pastille du menu) : Étudiant `#7BB293`, Professeur `#D6B566`,
Secrétariat `#8FA9D4`, Établissement `#BDB8AD`.

Règle : 80 % neutres, 15 % vert, 5 % or. Tous les textes respectent au moins 4,5:1.

## Typographie

| Usage | Police | Remarques |
|---|---|---|
| Interface | Plus Jakarta Sans (400 à 700) | `--font-ui` |
| Titres, documents | Source Serif 4 (600, italique pour les accents) | `--font-doc` |
| Code LaTeX, journaux | JetBrains Mono (400, 500), ligatures désactivées | `--font-code` |

Les trois polices sont sous licence libre (OFL). En production : les héberger soi-même en
woff2, sous-ensemble latin étendu, `font-display: swap`. L'éditeur ne charge que Plus Jakarta
Sans et JetBrains Mono (environ 130 à 150 Ko).

Échelle : 48 / 36 / 30 / 24 / 20 / 18 / 16 / 14 / 12 px. Texte courant 16 px minimum,
14 px pour le secondaire, 12 px seulement pour les métadonnées.

## Espace, forme, interaction

- Grille de 4 px : 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80.
- Rayons : 4, 6, 10 (boutons, champs), 16 (cartes, panneaux), pilule.
- Cibles tactiles : 44 px minimum. Boutons 44 px (36 en barre d'outils, 52 pour les appels principaux).
- Points de rupture : 360, 600, 960, 1280 px. Les pages sont fluides ; le menu latéral passe
  au-dessus du contenu sur téléphone.
- Mouvement : 120 / 200 / 320 ms, courbe `cubic-bezier(0.2, 0, 0, 1)`, opacité et translation
  uniquement. Tout est coupé avec `prefers-reduced-motion`.
- Icônes : grille de 24 px, trait de 1,75 px. Bibliothèque conseillée : Lucide (licence ISC).
- Accessibilité : vrais `<button>`, `<a>`, `<label>` ; `aria-label` sur les boutons à icône seule.

## À savoir avant d'intégrer

- Tous les noms, chiffres et dates sont des **exemples** (« [Pr. Nom] », « 412 / 500 », etc.).
- « Créer un compte » est interactif dans le canevas (le formulaire change selon le profil).
  La version HTML montre l'état « Enseignant ».
- Les animations des versions d'accueil (horloge, texte tapé) sont figées dans le HTML statique ;
  les animations CSS d'entrée fonctionnent.
- Les prix et délais affichés sont des hypothèses de l'étude, à confirmer.

## Écrans encore à concevoir

Nouveau document depuis un modèle · éditeur en vert et or · échéances · retours (vue liste) ·
dépôt final · mes étudiants · TD rendus en ligne · historique et journal d'accès du secrétariat ·
classes et filières · modèles officiels · abonnement et factures · paramètres · notifications ·
versions mobiles des écrans de l'application · réécriture de la landing page pour tous les publics.
