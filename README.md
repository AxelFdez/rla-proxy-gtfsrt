# gtfs-rt-filter

Proxy GTFS-RT TripUpdate filtré par ligne. Il télécharge les flux temps réel ZOU de la Région Sud (Express et Proximité), ne garde que les trips des lignes configurées et re-sert un seul `FeedMessage` valide.

Prototype de démonstration, pas une infra de production.

Lignes gardées par défaut :

| route_id | Ligne | Flux |
|---|---|---|
| `CFP:0-1` | Nice - Colomars - Plan-du-Var | Express |
| `CFP:0-2` | Nice - Digne-les-Bains | Express |
| `ZOP:600` | Nice - Monaco - Menton | Proximité |
| `ZOP:602` | Nice - Monaco | Proximité |
| `ZOP:620` | Nice - Cannes | Proximité |
| `ZOP:622` | Nice - Villeneuve-Loubet | Proximité |
| `ZOP:632` | Nice Grand Arénas - Sophia-Antipolis | Proximité |
| `ZOP:637` | Saint-Laurent-du-Var - Sophia - Valbonne | Proximité |
| `ZOP:650` | Nice - Grasse | Proximité |
| `ZOP:670` | Nice - Beuil - Valberg | Proximité |
| `ZOP:671` | Bouyon - Carros | Proximité |
| `ZOP:672` | Nice - Sigale | Proximité |
| `ZOP:675` | Nice - Guillaumes - Entraunes | Proximité |

## Comment le filtre trouve la ligne d'un trip

Dans les flux temps réel ZOU, `trip.route_id` est **toujours vide**. Pour savoir à quelle ligne appartient un trip, le proxy charge le `trips.txt` du GTFS statique de chaque réseau (data.gouv, rechargé toutes les 6 h) et en tire `trip_id → route_id`. Le 06/11/2026, 100 % des trips CFP et ZOP du temps réel s'y retrouvaient.

Si le flux temps réel renseigne un jour `route_id`, c'est cette valeur qui prime. Un trip absent du GTFS statique est écarté, et le compteur `unmapped_entities` des logs le signale : s'il monte sur Proximité, ou sur les trips CFP de l'Express, le GTFS statique est en retard. Sur l'Express, environ 420 trips SNCF sont absents du statique, mais ils ne sont pas filtrés de toute façon.

## Endpoints

| Route | Auth | Réponse |
|---|---|---|
| `GET /gtfs-rt/trip-updates.pb` | clé API | 200 protobuf filtré et fusionné, `cache-control: private, max-age=15`. 401 sans clé valide. 502 (corps vide) si aucune source n'est disponible. |
| `GET /gtfs-rt/cfp.pb` | clé API | ancien nom, même réponse (gardé pour ne rien casser) |
| `GET /healthz` | aucune | 200 `ok`, sans appel amont (utilisé par le `HEALTHCHECK` Docker) |
| autre | | 404 |

En-têtes de réponse utiles :
- `Age` : secondes depuis le dernier contact réussi avec la source la plus ancienne.
- `x-missing-sources` : présent si une source est en panne depuis plus de `MAX_STALE_MS`. Ses trips sont alors retirés du flux plutôt que servis périmés.

Le header du flux fusionné reprend `gtfs_realtime_version` et `incrementality` (FULL_DATASET), avec pour `timestamp` **le plus ancien** des deux sources : le flux ne se présente jamais comme plus frais que sa partie la plus vieille.

Taille indicative : environ 470 entités pour 950 Ko. Les trips ZOP sont longs (beaucoup d'arrêts) : 400 trips Proximité représentent environ 900 Ko, et les 74 trips CFP environ 50 Ko.

### Clé API

Le flux est accessible à tout consommateur qui a une clé (enRoute/Ara ou autre). La clé se passe de l'une de ces trois façons :

```sh
curl -H "x-api-key: $KEY" $BASE_URL/gtfs-rt/trip-updates.pb
curl -H "Authorization: Bearer $KEY" $BASE_URL/gtfs-rt/trip-updates.pb
curl "$BASE_URL/gtfs-rt/trip-updates.pb?api_key=$KEY"   # pour les consommateurs qui ne prennent qu'une URL
```

`API_KEYS` accepte plusieurs clés séparées par des virgules. Donnez **une clé par consommateur** : on en révoque une (en la retirant puis en redéployant) sans toucher aux autres. Pour changer de clé sans coupure, on déploie `ancienne,nouvelle`, on bascule le consommateur, puis on retire l'ancienne. Générer une clé : `openssl rand -hex 24`. Les clés vivent uniquement dans les variables d'environnement Dokploy (pas de base de données).

Une clé passée dans l'URL peut se retrouver dans les logs d'accès (Traefik, consommateur). Préférez l'en-tête quand le client le permet.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `API_KEYS` | *(obligatoire)* | clés acceptées, séparées par des virgules ; le serveur refuse de démarrer sans |
| `ROUTE_IDS` | les 13 lignes ci-dessus | `route_id` gardés, séparés par des virgules (ex. `CFP:0-1,CFP:0-2,ZOP:600`) |
| `SOURCES` | Express + Proximité | paires `<url GTFS-RT>\|<url zip GTFS statique>`, séparées par des virgules |
| `PORT` | `3000` | port d'écoute |
| `CACHE_TTL_MS` | `15000` | durée avant un nouveau fetch temps réel |
| `MAX_STALE_MS` | `120000` | âge max du cache d'une source servi quand elle échoue |
| `GTFS_REFRESH_MS` | `21600000` (6 h) | intervalle de rechargement des GTFS statiques |

`SOURCES` par défaut :
```
https://proxy-data.zou.maregionsud.fr/GTFS-RT/GTFS-RT_trips_ZOU_express.pb|https://www.data.gouv.fr/api/1/datasets/r/1164d75b-4a9f-4c5a-b765-31d861b34fda,
https://proxy-data.zou.maregionsud.fr/GTFS-RT/GTFS-RT_trips_ZOU_proximite.pb|https://www.data.gouv.fr/api/1/datasets/r/9c8116cb-2f1a-4045-b149-c5bf6cae6bef
```
(sur une seule ligne, sans espace). Pour ajouter une ligne d'un réseau déjà présent, il suffit de compléter `ROUTE_IDS`. Pour une ligne d'un autre réseau ZOU (Scolaire, Trains…), il faut aussi ajouter sa source à `SOURCES`.

## Fonctionnement

- Au démarrage, le proxy télécharge les GTFS statiques (environ 8 Mo chacun). Seul `trips.txt` est lu, avec un lecteur zip/CSV en Node pur, sans dépendance. En cas d'échec, il réessaie toutes les minutes. En cas d'échec d'un rechargement ultérieur, il garde l'ancienne table.
- Le refresh temps réel se fait à la demande, source par source. Les requêtes concurrentes pendant un refresh partagent un seul fetch par source.
- Le fetch temps réel a un timeout de 8 s et utilise un GET conditionnel (`If-None-Match`) : sur un 304, seul l'horodatage du cache est rafraîchi.
- Si une source échoue (erreur réseau, timeout, HTTP ≠ 200, **corps vide**), son cache reste servi tant qu'il a moins de `MAX_STALE_MS`. Passé ce délai, ses trips sont retirés et l'en-tête `x-missing-sources` le signale. Si plus aucune source n'est disponible, la route renvoie 502. Les deux flux renvoient parfois un 200 de 0 octet pendant ~30 s (blob capturé en pleine réécriture puis mis en cache par Front Door) ; c'est traité comme un échec.
- Les deux flux sont régénérés toutes les 30 s environ. Front Door les garde en cache 30 s.
- Le ré-encodage via `gtfs-realtime-bindings` est octet pour octet identique à la source (vérifié sur le flux réel) : le filtre ne transforme pas les entités.
- Logs : une ligne JSON par refresh et par source sur stdout, `{ts, source, upstream_bytes, upstream_entities, kept_entities, output_bytes, upstream_last_modified, status}`.
  - `status` vaut `ok`, `not_modified` ou `error`. Sur erreur s'ajoutent `error`, `cache_age_ms` et `serving` (`stale_cache` / `dropped`).
  - `unmapped_entities` : trips absents du GTFS statique.
  - `warning` : présent quand aucune entité ne correspond.
  - `kept_start_dates` : nombre de trips gardés par `start_date`, pour suivre les trips datés de la veille. On le loggue, on ne le corrige pas.
  - Le chargement des GTFS statiques loggue `gtfs_loaded` (avec `trips` et `wanted_trips`) ou `gtfs_error`.
  - Pas de log par requête cliente.

## Développement

```sh
npm install
npm test                                   # node:test, sans réseau
API_KEYS=dev npm start
curl -s -H 'x-api-key: dev' localhost:3000/gtfs-rt/trip-updates.pb | wc -c
```

## Docker

```sh
docker build -t gtfs-rt-filter .
docker run --rm -p 3000:3000 -e API_KEYS=dev gtfs-rt-filter
```

L'image est basée sur `node:22-alpine`, tourne en utilisateur `node` et a un `HEALTHCHECK` sur `/healthz`.

## Déploiement (Dokploy sur VPS OVH)

On utilise le domaine généré par Dokploy (`*.sslip.io`), servi en HTTPS avec un certificat Let's Encrypt, sans domaine personnel ni DNS à configurer.

1. **Application** : dans Dokploy, *Create Application*, source *Git* (ce dépôt, branche `master`), build type *Dockerfile*.
2. **Variables d'environnement** (onglet *Environment*) : `API_KEYS=<clé générée>`, et `ROUTE_IDS` pour changer la liste de lignes. La clé ne va jamais dans le dépôt.
3. **Domaine** (onglet *Domains*) : *Generate Domain*, container port `3000`, HTTPS.
4. **Deploy**, puis vérifier (`$BASE_URL` = `https://<domaine affiché par Dokploy>`, sans `/` final) :
   ```sh
   curl -s $BASE_URL/healthz
   curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H "x-api-key: $KEY" $BASE_URL/gtfs-rt/trip-updates.pb
   ```
   Le premier appel après un démarrage peut prendre quelques secondes, le temps de charger les GTFS statiques.

URL à transmettre au consommateur : `$BASE_URL/gtfs-rt/trip-updates.pb` (avec la clé, en en-tête ou en `?api_key=`).

## Licence

Les jeux de données ZOU (Express et Proximité) sont publiés sur transport.data.gouv.fr sous **Licence Ouverte v2.0** (Etalab), qui autorise la réutilisation et la republication d'un dérivé, avec mention de la source.

## Questions ouvertes

- Mention de la source ZOU / Région Sud à prévoir côté consommateurs, comme l'exige la Licence Ouverte.
- enRoute/Ara : comment Ara passe-t-il la clé (en-tête ou `?api_key=`) ?
