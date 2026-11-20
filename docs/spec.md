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

Stockage en unités binaires : 1 Mo = 1 048 576 octets, 1 Go = 1 073 741 824 octets. Le taux de la dégressivité Business au-delà de 100 sièges reste à fixer (voir Points ouverts) : aucune remise n'est appliquée d'ici là. « Collaborateurs par projet » ne compte ni le propriétaire ni les Encadrants, mais compte les invitations en attente (voir « Partage »).

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
  - *Lecture seule au-delà des limites* (décision étape 10) : au passage à un plan qui limite les projets, les projets les plus récemment actifs restent modifiables dans la limite du plan, les autres passent en lecture seule ; ce choix est fixé (il ne bouge pas avec l'activité). Le propriétaire peut à tout moment échanger un projet modifiable contre un projet en lecture seule, depuis « Ma consommation » ou la page du projet (« Rendre ce projet modifiable », puis choix du projet qui passe en lecture seule). Mettre un projet modifiable à la corbeille libère une place : le projet en lecture seule le plus récemment actif redevient modifiable ; un passage à un plan supérieur rend tout modifiable. Un projet en lecture seule reste consultable, téléchargeable en ZIP, commentable et partageable avec les rôles Lecteur, Relecteur et Encadrant (le rôle Éditeur est refusé ; les rôles déjà donnés ne changent pas) ; personne ne le compile ; ses soumissions en cours peuvent toujours être validées.
  - *Stockage au-delà de la limite* (décision étape 10) : aucun projet ne passe en lecture seule pour cette raison ; tout ajout d'octets est refusé, tandis que réduire un fichier, supprimer des fichiers et vider la corbeille restent permis.
  - *Collaborateurs au-delà de la limite* (décision étape 10) : les accès existants sont gardés ; les nouvelles invitations comptées sont refusées jusqu'au retour sous la limite.
- **Alertes de consommation** (décision étape 10) : à 80 % et à 100 % des projets, du stockage et des compilations par heure, un bandeau dans l'application (liste des projets, éditeur, « Ma consommation ») et une notification dans l'application, une seule fois par seuil, par quota et par mois. SMS et e-mail : étape 14.
- **Ma consommation** (décision étape 10) : page de l'utilisateur avec son offre effective (meilleur quota de ses sièges et abonnements, et leur origine), chaque ligne de la grille avec la consommation et la limite, les compilations et minutes de compilation du mois, et la liste des projets modifiables et en lecture seule.
- **Tableau de bord du titulaire** : sièges achetés, utilisés et libres ; consommation du mois par membre ; alertes à 80 % et 100 % ; date de renouvellement ; ajout ou retrait de sièges.

## Projets, partage et encadrement

Un projet est un dossier LaTeX complet. On le partage en entier (droits au niveau du projet en V1) ; la soumission sert à cibler les fichiers à relire.

**Projets :**

- **Contenu** : dossiers et fichiers ; fichier principal désigné (`main.tex` par défaut). Types acceptés : `.tex`, `.bib`, `.sty`, `.cls`, `.txt`, `.md`, `.png`, `.jpg`, `.jpeg`, `.pdf`, `.eps`, sans distinction de majuscules. 10 Mo maximum par fichier. Le type réel est vérifié (signature des images et PDF, texte en UTF-8).
- **Création** : projet vide, depuis un modèle, import ZIP (couvre les exports Prism et Overleaf), duplication.
- **Import ZIP** : archive de 50 Mo au plus ; chaque fichier extrait est limité à 10 Mo ; les fichiers refusés (type, taille, contenu) sont ignorés et listés dans un rapport ; le total compte dans le quota de stockage. Protections anti-ZIP piégé : taille totale décompressée de 200 Mo au plus et dans la limite du quota restant, 2 000 fichiers au plus, taux de compression de 100:1 au plus par fichier (vérifié à partir de 1 Mo produit), tailles mesurées pendant l'extraction (jamais celles annoncées dans l'archive), refus des chemins absolus, des « .. », des liens symboliques et des ZIP chiffrés ou imbriqués. Toutes ces limites sont réglables en configuration. Les dossiers vides de l'archive sont conservés.
- **Dossiers et déplacements** (décision du 20 novembre 2026) : boutons « Nouveau fichier » et « Nouveau dossier » dans l'arborescence de l'éditeur et sur la page du projet. On saisit un nom (jamais un chemin) et on choisit « Dans le dossier », prérempli avec le dossier courant : le dossier sélectionné, sinon celui du fichier ouvert, sinon la racine du projet. Un nom de fichier sans extension reçoit `.tex` ; un refus donne sa cause précise (extension non acceptée avec la liste des extensions permises, caractère interdit nommé, nom déjà utilisé dans ce dossier, nom ou chemin trop long). Un nouveau fichier texte s'ouvre aussitôt dans l'éditeur. Chaque dossier a un menu « … » (clavier, appui long sur mobile) : nouveau fichier ici, nouveau dossier ici, téléverser ici, renommer, déplacer vers…, supprimer ; chaque fichier : renommer (l'extension actuelle est gardée si on n'en tape pas), déplacer vers…, supprimer. Un dossier vide est conservé ; un dossier ne disparaît que lorsqu'on le supprime, même après la suppression ou le déplacement de son dernier fichier. Les dossiers conservés comptent avec les fichiers dans la limite de fichiers par projet (2 000, réglable). Un fichier ou un dossier se déplace par glisser-déposer dans l'arborescence ou par l'action « Déplacer vers… » (clavier et mobile) ; seuls le propriétaire et les éditeurs déplacent. Le fichier garde son identité : collaboration en cours, commentaires ancrés, historique et soumissions le suivent ; les brouillons de soumission prennent son nouveau chemin. Un fichier verrouillé par une soumission validée, ou un dossier qui en contient un, ne se déplace pas. Chaque déplacement est écrit dans le journal d'audit (ancien et nouveau chemin) et les autres onglets ouverts sur le projet le voient aussitôt.
- **Téléchargement ZIP** (décision du 20 novembre 2026) : « Télécharger le projet (ZIP) » depuis l'éditeur et la page du projet, pour le propriétaire et les éditeurs (projet en lecture seule compris). L'archive contient tous les fichiers et les dossiers vides ; elle n'est jamais refusée pour sa taille (déjà bornée par le stockage du plan). Elle est produite en flux, sans être chargée en mémoire ni écrite sur disque. Si le projet dépasse une limite de l'import ZIP (archive, taille décompressée, nombre de fichiers), l'avertissement « Ce projet est trop volumineux pour être réimporté en une seule fois » est affiché avant le téléchargement, qui reste possible. Limites : 20 téléchargements par heure et par compte (réglable) et un seul téléchargement à la fois par projet. Les fichiers ouverts dans l'éditeur sont enregistrés juste avant. Chaque téléchargement est écrit dans le journal d'audit.
- **Modèles** : modèles publics publiés par Integris ; modèles officiels ajoutés par un Business, visibles de ses seuls membres.
- **Historique** : version automatique après chaque période d'activité de 10 minutes, versions nommées à la demande, restauration de n'importe quelle version (dans la limite de l'historique du plan).
  - *Version automatique* : prise 10 minutes après la première modification qui suit la version précédente (en activité continue, une version toutes les 10 minutes ; aucune sans modification).
  - *Limite du plan* : selon le plan du propriétaire du projet ; les versions plus anciennes sont masquées et non restaurables, mais conservées (elles réapparaissent après un passage à un plan supérieur). L'historique ne compte pas dans le quota de stockage. Les versions figées des soumissions ne sont pas concernées.
  - *Restauration* : du projet entier (fichiers créés depuis supprimés, fichiers supprimés recréés) ou d'un seul fichier ; l'état actuel est d'abord enregistré comme version ; les fichiers verrouillés par une soumission validée ne changent pas.
  - *Fichiers déplacés* (décision du 20 novembre 2026) : les versions suivent chaque fichier par son identité. La restauration du projet entier remet un fichier déplacé à son ancien emplacement, sans le recréer (ses commentaires et sa collaboration restent), ainsi que les dossiers vides de la version ; la restauration d'un seul fichier remet son contenu là où il se trouve maintenant. Les versions antérieures à cette décision sont rapprochées par chemin.
  - *Droits* : tous les rôles consultent l'historique ; seuls le propriétaire et l'éditeur nomment une version et restaurent.
  - *Hors connexion* (décision étape 7) : les modifications restent dans l'onglet ouvert et sont synchronisées au retour du réseau ; rien n'est stocké dans le navigateur (le mode hors ligne complet reste hors V1).
- **Suppression** : corbeille de 30 jours, puis effacement définitif. Le propriétaire peut restaurer un projet ou l'effacer définitivement depuis la corbeille. Les projets en corbeille comptent dans le stockage, pas dans la limite de projets (la restauration revérifie cette limite). L'effacement conserve la trace des validations (voir « Encadrement ») et le journal des demandes d'impression.

| Rôle sur un projet | Lire | Commenter et proposer | Appliquer une proposition | Modifier | Partager, supprimer |
| --- | --- | --- | --- | --- | --- |
| Propriétaire | Oui | Oui | Oui | Oui | Oui |
| Éditeur | Oui | Oui | Oui | Oui | Non |
| Encadrant | Oui | Oui | Non | Non | Non |
| Relecteur | Oui | Oui | Non | Non | Non |
| Lecteur | Oui | Non | Non | Non | Non |

L'Encadrant valide en plus les soumissions et fixe les échéances (étape 9). Le Lecteur lit seulement : ni commentaire, ni réponse, ni proposition.

**Partage** : invitation par téléphone ou e-mail avec un rôle (Éditeur, Encadrant, Relecteur, Lecteur), depuis l'éditeur et la page du projet ; seul le propriétaire partage, change un rôle ou retire un accès.

- *Invitation* (décision étape 8) : toujours une invitation à accepter, y compris pour un compte existant. L'invité reçoit un SMS (numéro) ou un e-mail (adresse) avec un lien valable 14 jours ; le lien crée le compte s'il n'existe pas ; l'accès est donné à l'acceptation. Le propriétaire peut annuler une invitation en attente.
- *Message facultatif* : 280 caractères au plus, affiché dans l'e-mail et sur la page d'invitation, jamais dans le SMS.
- *Limite « Collaborateurs par projet »* (grille des plans) : appliquée selon le plan du propriétaire, lue dans la table des plans. Les invitations en attente comptent ; le propriétaire et les Encadrants ne comptent pas (la soumission à un encadreur est permise dans tous les plans, Gratuit compris). Au-delà : action bloquée avec un message clair et une proposition de plan supérieur.

**Lien public** (décision étape 8) : désactivé par défaut, créé par le propriétaire, sans compte pour le visiteur. Par défaut, il ne donne que le dernier PDF compilé avec succès ; à la création, une case « Inclure les fichiers source (lecture seule) », décochée par défaut, ajoute les sources. Jamais de commentaires, d'historique ni de compilation. Jeton long et aléatoire, expiration facultative, révocation immédiate, pages en `noindex`. Chaque création, ouverture et révocation est écrite dans le journal d'audit.

**Commentaires** : ancrés sur une sélection de texte, avec réponses et résolution ; l'ancrage suit le texte quand il change autour (collaboration en temps réel). Un commentaire peut contenir une **proposition de remplacement** que le propriétaire ou un éditeur applique en un clic ou refuse.

**Encadrement :**

- **Lien encadreur–étudiant** : dans un Business, l'administrateur affecte les encadreurs, ou l'étudiant invite son enseignant qui accepte. Hors Business, l'étudiant partage son projet en relecteur avec n'importe quel compte.
- **Soumission** : l'étudiant choisit les fichiers, ajoute un titre facultatif (120 caractères au plus, par exemple « Chapitre 2 — Méthodologie », affiché dans les listes et le tableau de l'encadrant), un message et une date limite facultative ; la plateforme fige une version à l'envoi. Plusieurs relecteurs possibles (co-encadrement).
  - *Qui* (décision étape 9) : le propriétaire et les éditeurs préparent un brouillon et l'envoient. Les relecteurs sont choisis parmi les membres Encadrant et Relecteur du projet (au moins un, qui a encore accès au projet à l'envoi). Tous les rôles du projet voient ses soumissions.
  - *Version figée et PDF* : à chaque envoi, tout le projet est figé comme version (il faut le fichier principal et les fichiers inclus pour compiler) ; les fichiers choisis sont ceux qu'on relit, qu'on verrouille et dont on garde l'empreinte SHA-256. Cette version est compilée seule (sans le cache du projet) pour produire son propre PDF : l'encadrant relit toujours le PDF de la version soumise, jamais le dernier PDF du projet. La soumission part quand ce PDF est prêt ; sans PDF, l'envoi est refusé et la soumission garde son statut (brouillon, ou retours envoyés) avec les erreurs. Les avertissements et les erreurs TeX non bloquantes qui laissent un PDF sont acceptés.
  - *Limites* : la compilation d'une soumission suit la durée maximale du plan du propriétaire ; elle est décomptée sur le propriétaire (statistiques) mais n'est jamais bloquée par la limite de compilations par heure, pour qu'un étudiant ne soit pas empêché de soumettre avant une date limite. Les envois sont limités à 3 par heure et par projet, et à 10 compilations de soumission par heure et par compte (le propriétaire, sur qui la compilation est décomptée), tous projets confondus ; cette seconde limite est réglable en configuration, et l'envoi refusé l'indique clairement avec le délai d'attente.
  - *Versions successives* : après des retours, l'étudiant envoie une version corrigée de la même soumission (v1, v2…) ; chacune garde sa version figée et son PDF.
- **Statuts** : brouillon → soumis → en relecture → retours envoyés → corrigé → validé.
  - *Transitions* (décision étape 9) : soumis à l'envoi de v1 ; en relecture à la première ouverture par un relecteur ; retours envoyés par un relecteur (Encadrant ou Relecteur) ; corrigé à l'envoi d'une nouvelle version, puis en relecture à l'ouverture ; validé par un Encadrant relecteur de la soumission. L'encadrant peut fixer ou changer la date limite après l'envoi, jusqu'à la validation. Chaque envoi, changement de statut, validation, déverrouillage et changement de date limite est écrit dans le journal d'audit et forme le fil de la soumission.
- **Validation** : seul un encadreur valide ; elle verrouille les fichiers soumis, que l'encadreur peut déverrouiller.
  - *Fichier déplacé après l'envoi* (décision du 20 novembre 2026) : la soumission suit le fichier par son identité ; à la validation, le contenu validé est remis dans ce fichier, à son nouvel emplacement, qui est verrouillé. La trace de validation garde les chemins et empreintes envoyés.
  - *Version validée* (décision étape 9) : l'Encadrant valide la dernière version, celle qu'il a relue. Si des fichiers soumis ont changé depuis l'envoi, il en est averti (« vous validez la version soumise ») ; à la validation, l'état actuel est enregistré comme version nommée « Avant validation », puis les fichiers soumis sont remis dans leur état validé et verrouillés (aucune modification ni restauration, côté API et côté collaboration), et l'étudiant en est informé.
  - *Projet en lecture seule* (décision étape 9) : la validation reste permise sur un projet en lecture seule (au-delà des limites du plan) ; seul le quota de stockage est vérifié quand des fichiers soumis sont remis en place.
  - *Déverrouillage* : par un Encadrant relecteur de la soumission ; les fichiers redeviennent modifiables, la soumission reste validée et close (plus de nouvelle version), et sa version figée, son PDF et la trace de validation restent intacts.
- **Trace des validations** : chaque validation laisse une trace conservée même après l'effacement du projet. Elle contient uniquement des métadonnées : qui a validé, quand, quelle soumission, la liste des fichiers soumis avec leur empreinte SHA-256 ; aucun contenu de fichier ni PDF. Elle ne peut pas être modifiée.
- **Comparaison** : « ce qui a changé depuis ma dernière relecture », différences ligne à ligne entre deux versions envoyées d'une soumission (par défaut, la dernière et la précédente), sur les fichiers soumis ; dans une ligne modifiée, les mots changés sont surlignés.
- **Tableau de bord d'encadrement (Business)** : une ligne par étudiant suivi, avec projet, soumissions, statut, date limite et dernière activité, triable par urgence.
- **Administrateur Business** : gère groupes (UFR, département, promotion) et affectations, impose les modèles officiels, voit des statistiques d'activité mais jamais le contenu des projets.
- **Fin d'encadrement** : réaffectation par l'administrateur ; l'ancien encadreur perd l'accès, ses commentaires restent. Les accès d'encadrement peuvent expirer à une date fixée par l'organisation.

**Notifications** : dans l'application pour tout ; SMS pour soumission reçue, retours envoyés, chapitre validé et échéance dans 2 jours ; e-mail en option. WhatsApp en V2.

### Décisions issues du design (18 novembre 2026)

- **Plusieurs espaces par personne** : espace personnel et un espace par organisation, avec un rôle (étudiant, enseignant, administrateur). Écran « Choisir son espace » après connexion, sauté s'il n'y en a qu'un ; changement depuis le menu latéral sans reconnexion.
- **Rattachement à confirmer** : dans un Business, un enseignant qui se déclare membre de l'établissement reste en attente jusqu'à la confirmation d'un administrateur. Hors Business, l'enseignant est un compte normal.
- **Import d'utilisateurs** : un Business invite ses membres en masse par fichier CSV (Excel en V2), avec un rapport des lignes en erreur. Chaque ligne importée consomme un siège.
- **Rôle « Encadrant »** : cinquième rôle de projet, qui peut commenter, proposer, valider les soumissions et fixer les échéances. Le Relecteur commente et propose des remplacements (décision étape 8) ; le Lecteur lit seulement (la maquette de partage, qui le montre « lit et commente », ne fait pas foi).
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
- arborescence : nouveau fichier, nouveau dossier, déplacement par glisser-déposer ou « Déplacer vers… » (voir « Projets ») ;
- compteur de mots (décision du 20 novembre 2026), dans le menu Réglages de l'éditeur, pour tous les rôles : texte rédigé, titres et légendes entre `\begin{document}` et `\end{document}` du fichier principal, en suivant `\input` et `\include` (chaque fichier lu une fois). Sont exclus les commandes LaTeX et leurs options, les commentaires, le préambule, les formules (comptées à part), les références (`\label`, `\ref`, `\cite`…) et les chemins ; les fichiers inclus introuvables sont signalés. Calculé dans le navigateur à l'ouverture du menu ;
- téléchargement du projet (ZIP), pour le propriétaire et les éditeurs (voir « Projets ») ;
- recherche et remplacement dans un fichier et dans tout le projet ;
- correcteur orthographique du navigateur : dans le code, option « Correcteur orthographique » du menu Réglages de l'éditeur, désactivée par défaut (il soulignerait les commandes LaTeX) et mémorisée sur le compte de l'utilisateur ; toujours actif dans les commentaires et les champs de texte ;
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
| Limites | Durée max et compilations par heure selon le plan ; CPU, mémoire, processus et taille de sortie identiques pour tous les plans, réglables dans la configuration du worker (2 CPU, 2 Gio de mémoire sans swap, 128 processus, dossier de travail de 1 Gio sources comprises, PDF de 200 Mo au plus) |
| Droits | Seuls le propriétaire et l'éditeur lancent une compilation (décomptée sur le propriétaire) ; les autres rôles voient le dernier PDF. Un projet en lecture seule n'est plus compilé, son dernier PDF reste visible |
| PDF servi | Depuis le domaine des fichiers (`latex-files.integriscloud.com`, `test-latex-files.integriscloud.com` sur latex-dev), jamais depuis l'origine de l'application |
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
  - *TVA* (décision étape 11) : taux réglable en configuration (`VAT_RATE_PERCENT`, 0 par défaut). Les prix de la table Plan restent TTC. Chaque reçu affiche toujours le montant HT, une ligne dédiée « TVA (x %) » (« TVA (0 %) : 0 FCFA » tant que le taux est 0) et le total TTC payé ; le taux est conservé avec chaque paiement, de sorte qu'un changement de taux ne demande aucune modification de code et ne modifie pas les reçus déjà émis.
  - *Mentions légales* (décision étape 11) : raison sociale, RCCM, IFU et adresse d'Integris Cloud sont en configuration ; « à compléter » sur les reçus en développement ; l'API refuse de démarrer en production si l'une d'elles est vide (voir Points ouverts).
- **Remboursement** : aucun, sauf erreur ou doublon ; les doublons sont détectés et remboursés ou convertis en crédit.
- **Business en libre-service** : formulaire avec nom de l'organisation, IFU facultatif, nombre de sièges, durée et code promo ; prix calculé en direct ; paiement LigdiCash ; activation immédiate.
- **Essais et promotions** : 14 jours de Standard sans paiement ; 30 jours de Business pour une université pilote (activé depuis le back-office) ; codes promo en pourcentage avec date de fin et nombre d'utilisations.
  - *Essai Standard* (décision étape 11) : une seule fois par compte, jamais après un Standard payé. Pas de grâce : à la fin de l'essai, retour direct en Gratuit, avec un rappel 3 jours avant. Payer pendant l'essai fait commencer la période payée à la fin de l'essai.
  - *Codes promo* (décision étape 11) : sur un nouvel abonnement ou un passage à un plan supérieur seulement (pas sur les renouvellements ni les sièges ajoutés), un même code une seule fois par compte.
- **Standard et siège Team ou Business** (décision étape 11) : le Standard payé est mis en pause et prolongé d'autant, sans crédit. Le prorata ne joue qu'à l'intérieur d'un même abonnement (mensuel vers annuel, Team vers Business, sièges ajoutés).
- **Doublons** (décision étape 11) : un paiement vérifié en double (même commande, ou changement déjà appliqué) est marqué « crédité », a son reçu, et son montant s'ajoute au solde de crédit du payeur, déduit automatiquement de son paiement suivant. Le payeur est prévenu aussitôt (application et e-mail) du montant crédité et du moyen d'obtenir un remboursement (adresse e-mail de facturation, en citant le numéro du reçu). Le solde de crédit est visible dans « Ma consommation » et sur la page de paiement. Chaque crédit est journalisé. Le remboursement se décide au back-office (étape 14).
- **Montant nul ou faible** (décision étape 11) : si le crédit ou un code promo couvre tout le prix, l'offre est activée aussitôt sans LigdiCash, avec un paiement de 0 FCFA, son reçu et son journal. Un montant minimum de transaction LigdiCash est réglable (100 FCFA par défaut) : si le reste à payer est inférieur à ce minimum, le minimum est payé et la différence s'ajoute au solde de crédit, avec une explication sur la page de paiement et sur le reçu.
- **Choix de l'étape 11** (confirmés le 20 novembre 2026) : renouvellement payé pendant la grâce à partir de l'ancienne échéance (après retour en Gratuit, nouvel abonnement au paiement) ; prorata au jour près, crédit arrondi au FCFA supérieur et prix des sièges ajoutés au FCFA inférieur ; plan inférieur choisi au renouvellement et appliqué à l'échéance ; rappels par SMS et dans l'application.

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
| Navigateurs | Cible commune dans `.browserslistrc` : Chrome, Chrome Android et WebView Android, Samsung Internet, Firefox (ordinateur et Android) sortis depuis 3 ans (au 19 novembre 2026 : Chrome 120+, Samsung Internet 24+ et Firefox 120+), Safari iOS 15+. Le code exécuté par le navigateur (pages et workers, dépendances comprises, dont PDF.js) n'utilise que ce que ces versions connaissent, ou un polyfill chargé avant l'usage ; pas d'expression régulière avec lookbehind (refusée avant Safari 16.4). Contrôle du build en CI et test de bout en bout dans Chromium 120. Un navigateur plus ancien que la cible, ou trop limité (Opera Mini, UC Browser), voit sur chaque page un bandeau en français ou en anglais qui conseille une version à jour de Chrome ou de Firefox ; le bandeau ne bloque aucune page |
| File de compilation | BullMQ sur Redis |
| Stockage | MinIO (compatible S3) |
| E-mails | SMTP d'Integris |
| SMS | API SMS LigdiCash, expéditeur INTEGRIS |
| Déploiement | Docker Compose par serveur ; Nginx et Let's Encrypt sur le serveur Application |
| Code et CI | Dépôt GitHub privé ; GitHub Actions (lint, tests, build, compatibilité navigateurs du build) à chaque push ; déploiement par script SSH, déclenché manuellement |
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
| Application | Données | 6379 | Redis (TLS, utilisateur `api` ; utilisateur `collab` du serveur de collaboration, limité à l'abonnement au canal `collab:events`) |
| Application | Données | 9000 | MinIO (TLS, clé `api`) |
| Compilation 1 et 2 | Données | 6379 | Redis (TLS, utilisateur `worker` limité aux files de compilation) |
| Compilation 1 et 2 | Données | 9000 | MinIO (TLS, clé `worker` limitée aux buckets de compilation ; sources du projet lues par URL présignées fournies par l'API) |
| Application | Internet | 443, 587 | API LigdiCash, API SMS, SMTP Integris |
| Données | Espace de sauvegarde hors site | 22 ou 443 | Sauvegardes quotidiennes |
| Les 4 serveurs | Dépôts Debian, registre Docker | 443 | Mises à jour |

- **Pare-feu** : nftables, politique par défaut « refuser » en entrée sur les 4 serveurs, et en sortie sur Données et Compilation.
- **PostgreSQL** : `pg_hba.conf` n'accepte que `hostssl` depuis l'IP de l'Application.
- **Redis** : port TLS uniquement, port en clair désactivé ; ACL avec un utilisateur `api`, un utilisateur `worker` restreint aux clés des files et un utilisateur `collab` (serveur de collaboration) sans accès aux clés, limité à `SUBSCRIBE`, `UNSUBSCRIBE`, `PING` et `QUIT` sur le seul canal `collab:events`, où l'API publie les événements de collaboration (fichier remplacé ou supprimé, droits modifiés). Règle ACL : `user collab on >… resetkeys resetchannels &collab:events -@all +subscribe +unsubscribe +ping +quit`.
- **MinIO** : TLS ; une clé par service, avec une politique limitée à ses buckets. La clé `worker` n'a **aucun** droit sur le bucket `projects` : elle a seulement lecture et écriture sur `compile-output` et `compile-cache`, où chaque objet est rangé sous le préfixe de son projet.
- **Sources d'une compilation** : pour chaque job, l'API génère une URL présignée MinIO en lecture (GET), une par fichier du projet, valable 5 minutes, et la place dans les données du job. Le worker télécharge les fichiers par ces URL, vérifie la taille et le chemin de chaque fichier, et n'écrit que dans son dossier de travail.
- **Certificats internes** : une autorité de certification interne signe les certificats de PostgreSQL, Redis et MinIO ; chaque client vérifie le certificat.
- **SSH** : clés uniquement, root interdit, fail2ban, accès depuis les IP d'administration seulement.
- **Cookies du portail** : vérifier que le portail Integris ne pose pas de cookies sur `.integriscloud.com` ; sinon ils seraient envoyés aux sous-domaines LaTeX.

**Règles de sécurité non négociables :**

- **Compilation isolée** : Docker avec gVisor ; un conteneur jetable par job, sans réseau, système de fichiers en lecture seule sauf le dossier de travail, utilisateur non root, aucune capacité, limites de CPU, mémoire, processus, durée et taille de sortie ; lecture et écriture TeX limitées au projet.
- **Serveurs de compilation** : ne joignent que Redis et MinIO ; aucun secret applicatif sur ces machines. Ils ne lisent les sources d'un projet que par les URL présignées (GET, 5 minutes, une par fichier) placées par l'API dans le job ; leur clé MinIO n'a aucun droit sur le bucket `projects`.
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
| 4 bis | Compléments aux fichiers (décision du 20 novembre 2026, après l'étape 9) : dossiers vides, déplacement par glisser-déposer et « Déplacer vers… », téléchargement ZIP, compteur de mots | Un dossier vide se crée ; un fichier déplacé garde collaboration, commentaires, historique et verrous ; le ZIP téléchargé se réimporte |
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
- [ ] Taux de TVA et facture certifiée : avis du comptable d'Integris (le taux se règle par `VAT_RATE_PERCENT`, 0 en attendant)
- [ ] **Bloquant pour la mise en production** : raison sociale, RCCM, IFU et adresse d'Integris Cloud pour les reçus (`BILLING_COMPANY_NAME`, `BILLING_RCCM`, `BILLING_IFU`, `BILLING_ADDRESS`) ; l'API refuse de démarrer en production tant que l'une d'elles est vide
- [ ] Portée des cookies du portail Integris (doivent rester limités à leur sous-domaine)
- [ ] Premiers modèles de mémoires (normes de 3 universités)
- [ ] Maquettes du designer : éditeur en priorité
- [ ] RAM de latex-dev à passer de 8 à 16 Go
- [ ] Barème de dégressivité Business au-delà de 100 sièges : taux, périodes concernées (annuel seul ou aussi mensuel), sièges concernés (tous ou seulement au-delà de 100)
