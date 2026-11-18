# Integris LaTeX — Spécification V1

Nov 13, 2026 · @integris

## Vision et périmètre V1

Integris LaTeX est une plateforme d'édition LaTeX collaborative hébergée par Integris Cloud sur **latex.integriscloud.com**. Elle vise d'abord les étudiants, enseignants et chercheurs d'Afrique de l'Ouest, avec paiement LigdiCash, interface en français et en anglais, et un cycle de soumission étudiant–encadreur qu'Overleaf n'offre pas.

**La V1 contient :** comptes et plans (Gratuit, Standard, Team, Business), projets et modèles, éditeur LaTeX, compilation isolée, collaboration en temps réel, commentaires avec propositions de remplacement, soumissions et validation, tableau de bord d'encadrement (Business), paiement LigdiCash, reçus par e-mail, back-office Integris.

**Hors V1 :** mode hors ligne, IA, suivi des modifications façon Word, droits fins par fichier, éditeur visuel, recharges de quota, WhatsApp, modèles personnels, connexion Google, SSO d'établissement, import Excel, liaison avec les comptes du portail Integris, préproduction.

Ce document fait foi. Toute règle absente ici doit être tranchée et ajoutée avant d'être codée.

## Plans, comptes et membres

Quatre plans. Seuls **Team** et **Business** rattachent d'autres comptes, et seul le titulaire (celui qui paie) peut le faire. Tous les nombres de sièges et tous les quotas sont fixés à l'avance et modifiables dans le back-office sans toucher au code.

|  | Gratuit | Standard | Team | Business |
| --- | --- | --- | --- | --- |
| Usage | Découverte | Individuel | Petite équipe, un gestionnaire | Organisation : admins, groupes, encadrement |
| Sièges | 1 | 1 | 2 à 10 (titulaire inclus) | 10 et plus (titulaire inclus) |
| Prix mensuel | 0 | 2 000 FCFA | 2 500 FCFA/siège | 2 000 FCFA/siège |
| Prix annuel | 0 | 20 000 FCFA | 25 000 FCFA/siège | 20 000 FCFA/siège, dégressif au-delà de 100 sièges |
| Projets | 3 | Illimités | Illimités | Illimités |
| Collaborateurs par projet | 1 | 5 | Illimités | Illimités |
| Durée max d'une compilation | 20 s | 2 min | 4 min | 4 min |
| Compilations par heure | 30 | 120 | 200 | 200 |
| Stockage | 100 Mo | 2 Go | 5 Go/siège | 5 Go/siège |
| Historique des versions | 24 h | 90 jours | Illimité | Illimité |
| Compilation automatique | Non | Oui | Oui | Oui |
| Soumission à un encadreur | Oui | Oui | Oui | Oui |
| Tableau de bord d'encadrement | Non | Non | Non | Oui (30 étudiants suivis max par encadreur) |
| Requêtes IA par jour (V2) | 5 | 50 | 100 | 100 |
| Priorité de compilation | Basse | Normale | Haute | Haute |

Stockage en unités binaires : 1 Mo = 1 048 576 octets, 1 Go = 1 073 741 824 octets. Le taux de la dégressivité Business au-delà de 100 sièges reste à fixer (voir Points ouverts) : aucune remise n'est appliquée d'ici là.

**Règles des comptes et des sièges :**

- **Le compte appartient à la personne.** Inscription par téléphone et code OTP par SMS ; e-mail et mot de passe en option. L'e-mail devient obligatoire et vérifié au premier paiement, car les reçus sont envoyés par e-mail uniquement.
- **Le titulaire occupe un siège.** Lui seul ajoute ou retire des membres ; en Business, il peut déléguer à 5 administrateurs au plus.
- **Payer ne donne pas accès aux contenus.** Le titulaire voit les membres et leur consommation, jamais les projets.
- **Invitation** par téléphone ou e-mail ; l'invité reçoit un SMS avec un lien et doit accepter ; le lien crée le compte s'il n'existe pas.
- **Plusieurs organisations** : un compte peut occuper des sièges dans plusieurs Team ou Business ; il bénéficie du meilleur quota.
- **Standard déjà payé** : il est mis en pause et prolongé d'autant tant que la personne occupe un siège ; il reprend quand elle le perd.
- **Retrait d'un membre** : il garde son compte et ses projets et repasse en Gratuit (ou retrouve son Standard en pause). Le siège libéré n'est réattribuable qu'après 30 jours.
- **Quotas par siège**, jamais mis en commun. La consommation est décomptée sur le propriétaire du projet.
- **Dépassement** : action bloquée avec un message clair et une proposition de plan supérieur. Aucune facturation automatique.
- **Fin d'abonnement ou non-paiement** : 7 jours de grâce, puis retour en Gratuit. Rien n'est supprimé ; les projets au-delà des limites du Gratuit passent en lecture seule. Les membres sont prévenus par SMS 3 jours avant.
- **Tableau de bord du titulaire** : sièges achetés, utilisés et libres ; consommation du mois par membre ; alertes à 80 % et 100 % ; date de renouvellement ; ajout ou retrait de sièges.

## Projets, partage et encadrement

Un projet est un dossier LaTeX complet. On le partage en entier (droits au niveau du projet en V1) ; la soumission sert à cibler les fichiers à relire.

**Projets :**

- **Contenu** : dossiers et fichiers ; fichier principal désigné (`main.tex` par défaut). Types acceptés : `.tex`, `.bib`, `.sty`, `.cls`, `.txt`, `.md`, `.png`, `.jpg`, `.pdf`, `.eps`. 10 Mo maximum par fichier.
- **Création** : projet vide, depuis un modèle, import ZIP (couvre les exports Prism et Overleaf), duplication.
- **Modèles** : modèles publics publiés par Integris ; modèles officiels ajoutés par un Business, visibles de ses seuls membres.
- **Historique** : version automatique après chaque période d'activité de 10 minutes, versions nommées à la demande, restauration de n'importe quelle version (dans la limite de l'historique du plan).
- **Suppression** : corbeille de 30 jours, puis effacement définitif.

| Rôle sur un projet | Lire | Commenter | Modifier | Partager, supprimer |
| --- | --- | --- | --- | --- |
| Propriétaire | Oui | Oui | Oui | Oui |
| Éditeur | Oui | Oui | Oui | Non |
| Relecteur | Oui | Oui | Non | Non |
| Lecteur | Oui | Non | Non | Non |

**Partage** : invitation par téléphone ou e-mail avec un rôle. Lien public en lecture seule désactivé par défaut, révocable, avec expiration possible.

**Commentaires** : ancrés sur une sélection de texte, avec réponses et résolution. Un commentaire peut contenir une **proposition de remplacement** que le propriétaire ou un éditeur applique en un clic ou refuse.

**Encadrement :**

- **Lien encadreur–étudiant** : dans un Business, l'administrateur affecte les encadreurs, ou l'étudiant invite son enseignant qui accepte. Hors Business, l'étudiant partage son projet en relecteur avec n'importe quel compte.
- **Soumission** : l'étudiant choisit les fichiers, ajoute un message et une date limite facultative ; la plateforme fige une version à l'envoi. Plusieurs relecteurs possibles (co-encadrement).
- **Statuts** : brouillon → soumis → en relecture → retours envoyés → corrigé → validé.
- **Validation** : seul un encadreur valide ; elle verrouille les fichiers soumis, que l'encadreur peut déverrouiller.
- **Comparaison** : « ce qui a changé depuis ma dernière relecture », différences ligne à ligne entre deux soumissions.
- **Tableau de bord d'encadrement (Business)** : une ligne par étudiant suivi, avec projet, soumissions, statut, date limite et dernière activité, triable par urgence.
- **Administrateur Business** : gère groupes (UFR, département, promotion) et affectations, impose les modèles officiels, voit des statistiques d'activité mais jamais le contenu des projets.
- **Fin d'encadrement** : réaffectation par l'administrateur ; l'ancien encadreur perd l'accès, ses commentaires restent. Les accès d'encadrement peuvent expirer à une date fixée par l'organisation.

**Notifications** : dans l'application pour tout ; SMS pour soumission reçue, retours envoyés, chapitre validé et échéance dans 2 jours ; e-mail en option. WhatsApp en V2.

### Décisions issues du design (18 novembre 2026)

- **Plusieurs espaces par personne** : espace personnel et un espace par organisation, avec un rôle (étudiant, enseignant, administrateur). Écran « Choisir son espace » après connexion, sauté s'il n'y en a qu'un ; changement depuis le menu latéral sans reconnexion.
- **Rattachement à confirmer** : dans un Business, un enseignant qui se déclare membre de l'établissement reste en attente jusqu'à la confirmation d'un administrateur. Hors Business, l'enseignant est un compte normal.
- **Import d'utilisateurs** : un Business invite ses membres en masse par fichier CSV (Excel en V2), avec un rapport des lignes en erreur. Chaque ligne importée consomme un siège.
- **Rôle « Encadrant »** : cinquième rôle de projet, qui peut commenter, proposer, valider les soumissions et fixer les échéances. Le Relecteur commente seulement ; le Lecteur lit seulement.
- **Classes et filières** : nom affiché des groupes d'un Business.
- **Hors V1** : SSO d'établissement, import Excel.

### Devoirs et secrétariat (V1, plan Business)

Un enseignant rédige un sujet d'examen en LaTeX et l'envoie au secrétariat pour impression. Le sujet reste confidentiel jusqu'à une date fixée par l'enseignant, et chaque accès est journalisé.

- **Disponibilité** : réservé aux organisations Business. Nouveau profil de membre **Secrétariat**, rattaché à une ou plusieurs classes et filières (UFR, département). Un secrétariat ne voit que les demandes de ses groupes.
- **Devoir** : type de projet à part (« Mes devoirs ») avec trois onglets : sujet, corrigé, barème. Le corrigé et le barème restent dans le projet de l'enseignant et ne sont jamais transmis.
- **Demande d'impression** : le PDF compilé du sujet est figé à l'envoi, avec la classe, le nombre de copies et la réserve, le format (recto, recto-verso, agrafé), la date de mise à disposition et la date de l'épreuve.
- **Statuts** : programmé (verrouillé) → prêt (date atteinte) → ouvert → imprimé (nombre confirmé) → remis (à qui) ; ou annulé.
- **Verrouillage** : le serveur refuse toute ouverture avant la date de mise à disposition, quel que soit l'utilisateur, administrateurs compris.
- **Modification** : avant ouverture, l'enseignant peut modifier ou annuler la demande ; un nouvel envoi remplace l'ancien. Après ouverture, il doit annuler et refaire une demande.
- **Aperçu** : filigrane nominatif (nom du secrétariat, service, date et heure) généré côté serveur.
- **Fichier à imprimer** : sans filigrane, téléchargeable seulement depuis l'écran d'impression, par un lien à usage unique valable 10 minutes.
- **Journal d'accès** : chaque envoi, modification, ouverture, téléchargement, confirmation d'impression et remise est enregistré (qui, quand, adresse IP), sans possibilité de modification. Visible par l'enseignant, le secrétariat concerné et les administrateurs.
- **Stockage** : les sujets sont dans un espace de stockage séparé, accessible uniquement par l'API, jamais par lien public.
- **Notifications** : le secrétariat est averti quand une demande devient prête ; l'enseignant est averti par SMS à l'impression et à la remise.
- **Écrans** : enseignant (mes devoirs, rédiger un devoir, envoyer au secrétariat) ; secrétariat (file d'impression, ouvrir et imprimer, historique, journal d'accès).

## Éditeur et compilation

L'éditeur occupe trois zones redimensionnables (arborescence, code, PDF), plus un panneau de commentaires et de soumissions. La compilation tourne toujours sur les serveurs de compilation, jamais sur le serveur Application.

**Éditeur (V1) :**

- coloration syntaxique, autocomplétion des commandes et des environnements ;
- autocomplétion de `\ref` et `\cite` à partir des étiquettes et du `.bib` du projet ;
- plan du document, repli des sections ;
- recherche et remplacement dans un fichier et dans tout le projet ;
- correcteur orthographique du navigateur ;
- raccourcis : gras, italique, commentaire, compiler (Ctrl+S ou Ctrl+Entrée) ;
- navigation SyncTeX dans les deux sens (double-clic dans le PDF, bouton depuis le code) ;
- visionneuse PDF.js : zoom, pages, téléchargement ; PDF servi par lien signé de 15 minutes, renouvelé automatiquement ;
- sur mobile : lecture du PDF, commentaires, compilation et soumissions complètes ; édition du code possible mais non optimisée.

**Compilation :**

| Paramètre | Règle V1 |
| --- | --- |
| Moteurs | pdfLaTeX (défaut), XeLaTeX, LuaLaTeX, au choix par projet |
| Distribution | TeX Live complet, une version, mise à jour une fois par an |
| Bibliographie | BibTeX et Biber pris en charge automatiquement par latexmk |
| Commandes système | Mode restreint de TeX Live seulement ; shell-escape complet interdit (pas de `minted`) |
| Déclenchement | Manuel ; automatique après 2 s sans frappe pour les plans payants |
| Cache | Fichiers intermédiaires (`.aux`, `.bbl`, `.toc`…) conservés dans MinIO et restaurés |
| File d'attente | Priorité Team et Business, puis Standard, puis Gratuit ; position affichée |
| Limites | Durée max et compilations par heure selon le plan |
| Erreurs | 1 à 3 premières erreurs traduites (dictionnaire d'environ 50 erreurs courantes, en français et en anglais), cliquables vers la ligne ; journal brut accessible |

## Paiement et facturation

Tout paiement passe par la plateforme, via LigdiCash, sur le compte marchand d'Integris Cloud. Aucun virement hors plateforme, aucune activation manuelle : un paiement confirmé active immédiatement l'offre.

- **Entité qui facture** : Integris Cloud, avec ses mentions légales (RCCM, IFU) sur les reçus.
- **Comptes** : séparés du portail Integris en V1 ; liaison en V2.
- **Moyens de paiement** : ceux de LigdiCash, comme sur les autres projets Integris.
- **Devise** : FCFA (XOF) uniquement. Prix affichés TTC.
- **Calcul automatique du prix** : la plateforme calcule tout, pour tous les plans : prix par siège, durée, dégressivité Business au-delà de 100 sièges, prorata, codes promo.
- **Activation** : uniquement après vérification du paiement auprès de l'API LigdiCash, jamais sur la seule notification reçue.
- **Renouvellement** : pas de prélèvement automatique. Rappels par SMS 5 jours et 1 jour avant l'échéance, avec un lien de paiement direct ; 7 jours de grâce ensuite. L'annuel est mis en avant.
- **Plan supérieur** : immédiat, les jours restants de l'ancien plan sont déduits du prix. **Plan inférieur** : à la fin de la période payée.
- **Ajout de sièges** : payé au prorata jusqu'à la prochaine échéance, puis tous les sièges sont renouvelés ensemble.
- **Dépassement de quota** : blocage et proposition de plan supérieur ; recharges en V2.
- **Reçus** : PDF automatique à chaque paiement, envoyé par e-mail uniquement, numérotation continue. Taux de TVA et obligation éventuelle de facture certifiée à confirmer par le comptable d'Integris.
- **Remboursement** : aucun, sauf erreur ou doublon ; les doublons sont détectés et remboursés ou convertis en crédit.
- **Business en libre-service** : formulaire avec nom de l'organisation, IFU facultatif, nombre de sièges, durée et code promo ; prix calculé en direct ; paiement LigdiCash ; activation immédiate.
- **Essais et promotions** : 14 jours de Standard sans paiement ; 30 jours de Business pour une université pilote (activé depuis le back-office) ; codes promo en pourcentage avec date de fin et nombre d'utilisations.

**Back-office Integris (super-administrateur)** : plans, prix et quotas modifiables sans code ; utilisateurs et organisations ; paiements et remboursements ; essais Business ; codes promo ; modèles publics ; statistiques (inscrits, payants, revenus, compilations).

## Technique, sécurité et déploiement

Monorepo TypeScript, quatre serveurs Debian, déploiement Docker. Le code et les commentaires sont en anglais ; l'interface est en français et en anglais dès la V1 (next-intl).

| Élément | Choix |
| --- | --- |
| Monorepo | pnpm + Turborepo : `apps/web` (Next.js), `apps/api` (NestJS), `apps/collab` (Hocuspocus/Yjs), `apps/worker` (compilation), `packages/db` (Prisma), `packages/shared` (types, Zod), `packages/ui` |
| Versions | Node.js 22 LTS ; Next.js, NestJS, Prisma, PostgreSQL et Redis en dernière version stable au démarrage, puis figées |
| Authentification | Sessions côté serveur dans Redis ; cookie `__Host-` (`Secure`, `HttpOnly`, `SameSite=Lax`), jamais sur `.integriscloud.com` |
| API | REST, OpenAPI (Swagger), validation de toutes les entrées |
| Éditeur | CodeMirror 6, Yjs, PDF.js |
| File de compilation | BullMQ sur Redis |
| Stockage | MinIO (compatible S3) |
| E-mails | SMTP d'Integris |
| SMS | API SMS LigdiCash, expéditeur INTEGRIS |
| Déploiement | Docker Compose par serveur ; Nginx et Let's Encrypt sur le serveur Application |
| Code et CI | Dépôt GitHub privé ; GitHub Actions (lint, tests, build) à chaque push ; déploiement par script SSH, déclenché manuellement |
| Environnements | Développement sur latex-dev (Docker Compose), préversion sur test-latex.integriscloud.com, et production |
| Surveillance | Journaux pino, Uptime Kuma avec alerte SMS ; Grafana et GlitchTip en V2 |
| Sauvegardes | `pg_dump` quotidien et miroir MinIO hors site ; 7 quotidiennes, 4 hebdomadaires, 3 mensuelles ; test de restauration mensuel |

| Serveur | IP | Modules |
| --- | --- | --- |
| Application | 102.204.24.220 | web, api, collab, Nginx |
| Données | 102.204.24.221 | PostgreSQL, Redis, MinIO |
| Compilation 1 | 102.204.24.222 | worker + conteneurs TeX Live |
| Compilation 2 | 102.204.24.223 | worker + conteneurs TeX Live |
| Développement (latex-dev) | 102.204.24.224 | toute la plateforme en Docker Compose, préversion test-latex.integriscloud.com |

Attribution des IP de production à confirmer avec l'administrateur Proxmox.

**Serveur de développement latex-dev** : Nginx sur l'hôte publie test-latex.integriscloud.com (protégé par mot de passe, non indexé) et relaie `/` vers `127.0.0.1:3000` (web), `/api/` vers `127.0.0.1:4000` (api) et `/collab` vers `127.0.0.1:1234` (collab, WebSocket). Docker publie tous les ports sur `127.0.0.1` uniquement. gVisor (`runsc`) est installé pour la compilation.

### Réseau et pare-feu

Les serveurs communiquent par leurs IP publiques (option B). Chaque serveur refuse tout par défaut, en entrée comme en sortie, sauf les flux ci-dessous ; tout trafic entre serveurs est chiffré en TLS.

| Source | Destination | Port | Usage |
| --- | --- | --- | --- |
| Internet | Application | 80, 443 | Site, API, WebSocket (80 redirige vers 443) |
| IP d'administration Integris | Les 4 serveurs | 22 | SSH par clé uniquement |
| Application | Données | 5432 | PostgreSQL (TLS, scram-sha-256) |
| Application | Données | 6379 | Redis (TLS, utilisateur `api`) |
| Application | Données | 9000 | MinIO (TLS, clé `api`) |
| Compilation 1 et 2 | Données | 6379 | Redis (TLS, utilisateur `worker` limité aux files de compilation) |
| Compilation 1 et 2 | Données | 9000 | MinIO (TLS, clé `worker` limitée aux buckets de compilation) |
| Application | Internet | 443, 587 | API LigdiCash, API SMS, SMTP Integris |
| Données | Espace de sauvegarde hors site | 22 ou 443 | Sauvegardes quotidiennes |
| Les 4 serveurs | Dépôts Debian, registre Docker | 443 | Mises à jour |

- **Pare-feu** : nftables, politique par défaut « refuser » en entrée sur les 4 serveurs, et en sortie sur Données et Compilation.
- **PostgreSQL** : `pg_hba.conf` n'accepte que `hostssl` depuis l'IP de l'Application.
- **Redis** : port TLS uniquement, port en clair désactivé ; ACL avec un utilisateur `api` et un utilisateur `worker` restreint aux clés des files.
- **MinIO** : TLS ; une clé par service, avec une politique limitée à ses buckets.
- **Certificats internes** : une autorité de certification interne signe les certificats de PostgreSQL, Redis et MinIO ; chaque client vérifie le certificat.
- **SSH** : clés uniquement, root interdit, fail2ban, accès depuis les IP d'administration seulement.
- **Cookies du portail** : vérifier que le portail Integris ne pose pas de cookies sur `.integriscloud.com` ; sinon ils seraient envoyés aux sous-domaines LaTeX.

**Règles de sécurité non négociables :**

- **Compilation isolée** : Docker avec gVisor ; un conteneur jetable par job, sans réseau, système de fichiers en lecture seule sauf le dossier de travail, utilisateur non root, aucune capacité, limites de CPU, mémoire, processus, durée et taille de sortie ; lecture et écriture TeX limitées au projet.
- **Serveurs de compilation** : ne joignent que Redis et MinIO ; aucun secret applicatif sur ces machines.
- **Contenu des utilisateurs** (PDF, images) servi depuis le sous-domaine frère `latex-files.integriscloud.com` (jamais un sous-domaine de `latex.`), par liens signés, sans cookie, avec CSP `sandbox`, `nosniff` et téléchargement forcé pour tout ce qui n'est ni PDF ni image matricielle.
- **Contrôle d'accès** vérifié côté serveur à chaque requête et à chaque connexion WebSocket de collaboration.
- **Paiement** : webhook LigdiCash vérifié, statut revérifié auprès de l'API, traitement idempotent.
- **OTP SMS** : limites par numéro, par IP et par jour ; CAPTCHA après échecs ; indicatifs autorisés configurables.
- **Téléversements** : type réel et taille contrôlés, stockage hors de la racine web.
- **Journal d'audit** des actions sensibles : sièges, rôles, paiements, partages, validations.
- **Tests** : unitaires sur quotas, droits, sièges, prix et prorata ; Playwright sur les parcours clés ; suite de fichiers `.tex` malveillants à chaque version.
- **Légal** : CGU, politique de confidentialité et mentions légales dès la V1 ; déclaration à la CIL par Integris.

## Brief pour le designer

Produit : **Integris LaTeX**, un produit Integris Cloud. Public : étudiants, enseignants et chercheurs d'Afrique de l'Ouest, souvent sur smartphone et avec une connexion lente. L'interface doit être légère, lisible, bilingue (français et anglais), en mode clair et sombre, et cohérente avec l'identité Integris Cloud.

**Contraintes :** chaque écran existe en version ordinateur et mobile ; prévoir les états vide, chargement, erreur, hors connexion et quota atteint ; les montants sont en FCFA ; les textes doivent supporter l'anglais, souvent plus court, et le français, souvent plus long.

| Zone | Écrans | États à prévoir |
| --- | --- | --- |
| Public | Accueil, tarifs, modèles publics, CGU, confidentialité | — |
| Compte | Inscription par téléphone, code OTP, connexion, mot de passe oublié, profil, vérification d'e-mail | Code invalide, trop de tentatives, numéro non autorisé |
| Projets | Liste des projets, nouveau projet (vide, modèle, ZIP), galerie de modèles, corbeille | Aucun projet, limite de 3 projets atteinte (Gratuit) |
| Éditeur | Arborescence, code, PDF, barre de compilation, panneau commentaires et soumissions, historique des versions, partage | Compilation en file (position), en cours, réussie, erreurs, délai dépassé, lecture seule, collaborateurs en ligne |
| Soumissions | Nouvelle soumission (fichiers, message, date limite), fil d'une soumission, comparaison entre versions | Chaque statut, de brouillon à validé ; fichiers verrouillés |
| Encadrement (Business) | Tableau de bord des étudiants suivis | Aucun étudiant, retards, échéances proches |
| Abonnement | Choix du plan, calcul du prix (sièges, durée, code promo), paiement LigdiCash, historique des reçus | Paiement en attente, réussi, échoué ; période de grâce |
| Organisation (Team, Business) | Membres et sièges, invitations, consommation par membre, groupes et affectations (Business), modèles officiels (Business) | Sièges complets, siège en attente de 30 jours, alertes 80 % et 100 % |
| Notifications | Centre de notifications | Aucune notification |
| Back-office Integris | Tableau de bord, plans et prix, utilisateurs, organisations, paiements, codes promo, modèles publics | — |

**Composants récurrents :** bandeau de quota, badge de plan, badge de statut de soumission, sélecteur de rôle, carte de projet, sélecteur de langue.

## Plan de développement avec Claude Code

Quinze étapes, à confier à Claude Code dans cet ordre. Une étape n'est commencée que lorsque la précédente remplit son critère de fin et que `pnpm build` passe. Commit uniquement à la fin d'une étape, sur demande explicite.

| # | Étape | Terminée quand |
| --- | --- | --- |
| 1 | Monorepo, Docker Compose de développement, CI GitHub Actions, `CLAUDE.md`, i18n français et anglais | `pnpm dev` lance web, api, collab et worker ; la CI passe |
| 2 | Schéma Prisma complet, migrations, données initiales (4 plans, modèles de base) | Migration appliquée ; plans visibles en base |
| 3 | Authentification : OTP SMS, sessions Redis, e-mail et mot de passe, limites anti-abus, choix de l'espace | Inscription et connexion de bout en bout ; tests des limites |
| 4 | Projets et fichiers : création (vide, modèle, ZIP), arborescence, MinIO, corbeille | Un projet se crée, s'importe et se supprime |
| 5 | Éditeur : CodeMirror 6, autocomplétion, plan du document, recherche | Un `.tex` s'édite confortablement |
| 6 | Compilation : BullMQ, worker, conteneur gVisor, cache, erreurs traduites, PDF.js, SyncTeX | Un mémoire de 80 pages compile ; la suite malveillante échoue proprement |
| 7 | Collaboration : Hocuspocus, droits à la connexion, curseurs, historique des versions | Deux personnes éditent sans conflit ; restauration d'une version |
| 8 | Partage, rôles (dont Encadrant), liens publics, commentaires avec propositions de remplacement | Les cinq rôles respectent le tableau des droits |
| 9 | Soumissions : version figée, statuts, validation et verrouillage, comparaison | Cycle complet de brouillon à validé |
| 10 | Plans, quotas et consommation : contrôles, blocages, alertes | Chaque quota de la grille est appliqué et testé |
| 11 | Paiement LigdiCash : calcul des prix, prorata, codes promo, webhook, reçus PDF par e-mail, rappels et grâce | Paiement de test qui active un plan ; reçu reçu par e-mail |
| 12 | Team et Business : sièges, invitations, import CSV, rattachements, administrateurs, classes et filières, tableau de bord d'encadrement | Un Business de 10 sièges fonctionne de bout en bout |
| 13 | Devoirs et secrétariat : devoirs (sujet, corrigé, barème), demandes d'impression, verrouillage à date, filigrane, lien à usage unique, journal d'accès | Un sujet reste inaccessible avant sa date ; chaque accès apparaît au journal |
| 14 | Back-office Integris et notifications (application, SMS, e-mail) | Plans, prix et codes promo modifiables sans code |
| 15 | Mise en production : durcissement des 4 serveurs, Nginx, TLS, sauvegardes, Uptime Kuma, pages légales | latex.integriscloud.com en ligne ; restauration testée |

L'intégration des maquettes du designer se fait écran par écran à partir de l'étape 3, dès qu'elles sont prêtes. En attendant, Claude Code utilise des composants neutres de `packages/ui`.

## Points ouverts

- [ ] Liste des IP d'administration autorisées en SSH
- [ ] Confirmer l'attribution des 4 IP aux rôles
- [ ] Paramètres SMTP d'Integris (hôte, port, compte d'envoi, adresse expéditrice)
- [ ] Identifiants LigdiCash du compte marchand Integris (test et production) et expéditeur SMS INTEGRIS
- [ ] Taux de TVA et facture certifiée : avis du comptable d'Integris
- [ ] Portée des cookies du portail Integris (doivent rester limités à leur sous-domaine)
- [ ] Premiers modèles de mémoires (normes de 3 universités)
- [ ] Maquettes du designer : éditeur en priorité
- [ ] RAM de latex-dev à passer de 8 à 16 Go
- [ ] Barème de dégressivité Business au-delà de 100 sièges : taux, périodes concernées (annuel seul ou aussi mensuel), sièges concernés (tous ou seulement au-delà de 100)
