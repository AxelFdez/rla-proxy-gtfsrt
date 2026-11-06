# gtfs-rt-filter

Proxy GTFS-RT TripUpdate filtré par opérateur. Il télécharge le flux ZOU Express de la Région Sud (~1 Mo, 4 opérateurs), ne garde que les entités dont `trip_update.trip.trip_id` commence par un préfixe configuré (`CFP:` par défaut) et re-sert un `FeedMessage` valide, avec le header d'origine inchangé (version, incrementality, timestamp).

Prototype de démonstration, pas une infra de production.

Pourquoi un préfixe de `trip_id` : dans ce flux, `route_id` est toujours vide, et `CFP:0-1` / `CFP:0-2` sont des `stop_id`, pas des lignes. Le préfixe de `trip_id` est donc le seul discriminant fiable.

## Endpoints

| Route | Auth | Réponse |
|---|---|---|
| `GET /gtfs-rt/cfp.pb` | clé API | 200 protobuf filtré, `cache-control: private, max-age=15`, en-tête `Age` = secondes depuis le dernier contact réussi avec l'amont. 401 sans clé valide. 502 (corps vide) si l'amont est en échec depuis plus de `MAX_STALE_MS`. |
| `GET /healthz` | aucune | 200 `ok`, sans appel amont (utilisé par le `HEALTHCHECK` Docker) |
| autre | | 404 |

### Clé API

Le flux est accessible à tout consommateur qui a une clé (enRoute/Ara ou autre). La clé se passe de l'une de ces trois façons :

```sh
curl -H "x-api-key: $KEY" $BASE_URL/gtfs-rt/cfp.pb
curl -H "Authorization: Bearer $KEY" $BASE_URL/gtfs-rt/cfp.pb
curl "$BASE_URL/gtfs-rt/cfp.pb?api_key=$KEY"   # pour les consommateurs qui ne prennent qu'une URL
```

`API_KEYS` accepte plusieurs clés séparées par des virgules. Donnez **une clé par consommateur** : on en révoque une (en la retirant puis en redéployant) sans toucher aux autres. Pour changer de clé sans coupure, on déploie `ancienne,nouvelle`, on bascule le consommateur, puis on retire l'ancienne. Générer une clé : `openssl rand -hex 24`. Les clés vivent uniquement dans les variables d'environnement Dokploy (pas de base de données).

Une clé passée dans l'URL peut se retrouver dans les logs d'accès (Traefik, consommateur). Préférez l'en-tête quand le client le permet.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `API_KEYS` | *(obligatoire)* | clés acceptées, séparées par des virgules ; le serveur refuse de démarrer sans |
| `SRC_URL` | `https://proxy-data.zou.maregionsud.fr/GTFS-RT/GTFS-RT_trips_ZOU_express.pb` | flux amont |
| `TRIP_PREFIXES` | `CFP:` | préfixes de `trip_id` gardés, séparés par des virgules |
| `PORT` | `3000` | port d'écoute |
| `CACHE_TTL_MS` | `15000` | durée avant un nouveau fetch amont |
| `MAX_STALE_MS` | `120000` | âge max du cache servi quand l'amont échoue |

## Fonctionnement

- Le refresh se fait à la demande. Les requêtes concurrentes pendant un refresh partagent un seul fetch amont.
- Le fetch amont a un timeout de 8 s et utilise un GET conditionnel (`If-None-Match`) : sur un 304, seul l'horodatage du cache est rafraîchi.
- Si l'amont échoue (erreur réseau, timeout, HTTP ≠ 200, **corps vide**), le cache reste servi tant qu'il a moins de `MAX_STALE_MS`, puis la route renvoie 502. L'amont renvoie parfois un 200 de 0 octet pendant ~30 s (blob capturé en pleine réécriture puis mis en cache par Front Door) ; c'est traité comme un échec.
- Le ré-encodage via `gtfs-realtime-bindings` est octet pour octet identique à la source (vérifié sur le flux réel), donc rien n'est perdu.
- Logs : une ligne JSON par refresh sur stdout, `{ts, upstream_bytes, upstream_entities, kept_entities, output_bytes, upstream_last_modified, status}`. `status` vaut `ok`, `not_modified` ou `error` ; sur erreur s'ajoutent `error`, `cache_age_ms` et `serving` (`stale_cache` / `502`). Il y a un `warning` quand aucune entité ne correspond, et `kept_start_dates` compte les trips gardés par `start_date` (pour suivre le décalage d'un jour observé sur les trips CFP ; on le loggue, on ne le corrige pas). Pas de log par requête cliente.

## Développement

```sh
npm install
npm test                                   # node:test, sans réseau
API_KEYS=dev npm start
curl -s -H 'x-api-key: dev' localhost:3000/gtfs-rt/cfp.pb | wc -c
```

## Docker

```sh
docker build -t gtfs-rt-filter .
docker run --rm -p 3000:3000 -e API_KEYS=dev gtfs-rt-filter
```

L'image est basée sur `node:22-alpine`, tourne en utilisateur `node` et a un `HEALTHCHECK` sur `/healthz`.

## Déploiement (Dokploy sur VPS OVH)

On utilise le domaine généré par Dokploy, sans domaine personnel ni DNS à configurer.

1. **Application** : dans Dokploy, *Create Application*, source *Git* (ce dépôt, branche `master`), build type *Dockerfile*.
2. **Variables d'environnement** (onglet *Environment*) : `API_KEYS=<clé générée>`, plus les autres variables si on veut s'écarter des défauts. La clé ne va jamais dans le dépôt.
3. **Domaine** (onglet *Domains*) : *Generate Domain* (domaine `*.traefik.me` qui pointe vers l'IP du VPS), container port `3000`.
4. **Deploy**, puis vérifier, en remplaçant `$BASE_URL` par le domaine affiché par Dokploy :
   ```sh
   curl -s $BASE_URL/healthz
   curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H "x-api-key: $KEY" $BASE_URL/gtfs-rt/cfp.pb
   ```

URL à transmettre au consommateur : `$BASE_URL/gtfs-rt/cfp.pb` (avec la clé, en en-tête ou en `?api_key=`).

**HTTPS** : vérifier si le domaine généré est servi en `https://`. S'il ne l'est qu'en `http://`, la clé API circule en clair sur le réseau. C'est acceptable pour une démo, pas au-delà : dans ce cas, passer à un domaine personnel avec certificat Let's Encrypt (onglet *Domains*, HTTPS activé), ce qui ne demande aucun changement de code.

## Questions ouvertes

- Licence de réutilisation du flux ZOU (republication d'un dérivé sous un domaine que je contrôle) : à vérifier sur la fiche data.gouv.
- enRoute attend-il un filtre par opérateur, ou des `route_id` issus d'un GTFS statique ?
