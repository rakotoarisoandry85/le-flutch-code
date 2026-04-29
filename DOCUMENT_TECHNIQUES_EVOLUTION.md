# Le Flutch — Documentation Technique des Évolutions

## Sommaire

1. [Défi 1 — Queue asynchrone BullMQ](#défi-1--queue-asynchrone-bullmq)
2. [Défi 2 — DPE (Diagnostic de Performance Énergétique)](#défi-2--dpe)
3. [Défi 3 — Worker Autonome de Relance](#défi-3--worker-autonome-de-relance)

---

## Défi 1 — Queue asynchrone BullMQ

### Analyse des risques (architecture synchrone actuelle)

L'architecture synchrone existante traite chaque webhook Pipedrive en ligne directe dans le thread HTTP. En cas de surcharge PostgreSQL, d'OOM, ou d'erreur transitoire Pipedrive, le handler retourne une erreur 5xx, Pipedrive re-tente immédiatement, et le système entre en cascades de retrys simultanés. Par ailleurs, un traitement long (> 5 s) dépasse le timeout Pipedrive, marquant le webhook comme échoué même si la DB a finalement réussi. L'absence de persistance de la file signifie qu'un redémarrage pendant le traitement perd irrémédiablement l'événement.

### Architecture BullMQ

```
Pipedrive Webhook
       │
       ▼
routes/webhooks.js          ← répond 202 en < 5ms
       │ enqueueWebhook()
       ▼
lib/queue.js (Queue BullMQ) ← stocke le job dans Redis
       │
       ▼ (asynchrone, autre thread)
workers/webhookProcessor.js ← traitement réel (DB, sync Pipedrive)
       │
       ▼
PostgreSQL
```

### Fichiers livrés

| Fichier | Rôle |
|---------|------|
| `lib/queue.js` | Connexion Redis, instance Queue, `enqueueWebhook()`, `closeQueue()` |
| `workers/webhookProcessor.js` | Consumer BullMQ, dispatch par `eventType`, handlers métier |
| `routes/webhooks.js` | Route POST avec vérification HMAC/Basic Auth, réponse 202, persistance audit |
| `server.patch.js` | Diff commenté des modifications à apporter à `server.js` |

### Déploiement

```bash
# Dépendances
npm install bullmq ioredis

# Variables d'environnement
REDIS_URL=redis://127.0.0.1:6379
WEBHOOK_WORKER_CONCURRENCY=4

# Démarrer (le Worker est intégré au démarrage de server.js)
npm start
```

### Paramètres de retry

- **Tentatives** : 5
- **Backoff** : exponentiel, 2s → 4s → 8s → 16s → 32s
- **Erreurs éligibles au retry** : toutes les exceptions (conformément au comportement BullMQ)
- **Rétention** : jobs complétés 24h, jobs échoués 7 jours

### Idempotence

Chaque job a un `jobId` déterministe `pipedrive-{meta.id}`. Si Pipedrive renvoie le même webhook deux fois, BullMQ détecte la collision de `jobId` et ignore le doublon.

---

## Défi 2 — DPE

### Migration base de données

**Fichier** : `migrations/2026_001_add_dpe.sql`

Modifications :

- `biens.dpe_classe CHAR(1)` avec contrainte `CHECK (IN 'A'..'G')`
- `acquereur_criteria.dpe_classes JSONB DEFAULT '[]'` avec contrainte de validité par array
- Index B-tree sur `biens.dpe_classe` (partiel : WHERE IS NOT NULL)
- Index GIN sur `acquereur_criteria.dpe_classes` (pour opérateur `?`)
- Fonction `normalize_dpe_classe(TEXT)` immutable pour usage dans des expressions
- Vue `v_matching_dpe` pour diagnostic et reporting

```bash
# Appliquer la migration
psql $DATABASE_URL -f migrations/2026_001_add_dpe.sql
```

### Intégration CRM (fieldMapping.js)

Le hash Pipedrive du champ DPE est configurable via variable d'environnement :

```bash
# Deals (biens)
PIPEDRIVE_DEAL_FIELD_DPE=<hash_du_champ_custom_pipedrive>

# Persons (acquéreurs)
PIPEDRIVE_PERSON_FIELD_DPE=<hash_du_champ_custom_pipedrive>
```

**Pour trouver les hash** : `GET https://api.pipedrive.com/v1/dealFields?api_token=TOKEN`

### Normalisation DPE (sync.js)

`normalizeDpe(rawValue)` gère les formats Pipedrive courants :

| Entrée Pipedrive | Sortie |
|-----------------|--------|
| `"C"` | `"C"` |
| `"c"` | `"C"` |
| `"Classe C"` | `"C"` |
| `"DPE D"` | `"D"` |
| `null`, `""` | `null` |
| `42` (ID enum) | `null` |

`parseDpeClasses(rawValue)` pour les acquéreurs :

| Entrée Pipedrive | Sortie |
|----------------|--------|
| `'["A","B"]'` | `["A","B"]` |
| `"A,B,C"` | `["A","B","C"]` |
| `["A","b"]` | `["A","B"]` |
| `null` | `[]` |

### Algorithme de matching DPE

**Règle** : critère éliminatoire si l'acquéreur a des préférences DPE ET que le bien a un DPE renseigné.

```sql
-- Clause WHERE dans MATCHING_QUERY (db/matching.js)
AND (
  ac.dpe_classes IS NULL
  OR ac.dpe_classes = '[]'::JSONB
  OR b.dpe_classe IS NULL          -- bien sans DPE = non filtré
  OR ac.dpe_classes ? b.dpe_classe -- opérateur JSONB "contient l'élément"
)
```

**Score DPE** : +1 point si le DPE est renseigné ET compatible (bonus, pas pénalité). Le bien n'est jamais retourné si le DPE est incompatible.

---

## Défi 3 — Worker Autonome de Relance

### Architecture

```
┌─────────────────────────────────────────────────────┐
│              relanceWorker.js                        │
│                                                      │
│  Boucle principale (9h-19h Paris, toutes 30 min)    │
│       │                                              │
│       ├── Contrôle plage horaire                     │
│       ├── Nettoyage état expiré                      │
│       ├── GET /api/todos/dashboard (JWT auto-renew)  │
│       ├── Filtrage : non_traite + non déjà envoyé    │
│       ├── POST /api/email-queue/enqueue              │
│       └── Persistance .state.json (post-succès)     │
└─────────────────────────────────────────────────────┘
```

### Fichier d'état (.state.json)

```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "tokenExpiresAt": 1714300000000,
  "processed": {
    "42": {
      "123": 1714200000000,
      "456": 1714201000000
    }
  }
}
```

### Comportements clés

| Comportement | Implémentation |
|-------------|----------------|
| Plage 9h-19h Paris | `parisHour()` via `TZ_OFFSET_HOURS` (régler à 2 en été) |
| Cycle 30 min | `sleep(CYCLE_INTERVAL_MS)` entre cycles |
| Rate limit 100 req/min | `RateLimiter` (token bucket) avec backoff sur 429 |
| Idempotence 30 jours | Check `alreadySent()` avant POST + `markSent()` post-succès |
| Renewal JWT | `isTokenValid()` avec marge 5 min + re-auth sur 401 |
| Arrêt gracieux | `SIGTERM`/`SIGINT` → `saveState()` + `process.exit(0)` |

### Usage

```bash
# Démarrage normal (boucle)
node workers/relanceWorker.js

# Un seul cycle (pour tests ou cron externe)
WORKER_ONCE=1 node workers/relanceWorker.js

# Debug
DEBUG=1 node workers/relanceWorker.js

# En production (PM2)
pm2 start workers/relanceWorker.js --name relance-worker
```

### Variables d'environnement requises

```bash
WORKER_EMAIL=worker@flutch.internal
WORKER_PASSWORD=strong_password
API_BASE_URL=http://localhost:3000
```

Voir `.env.example` pour la liste complète.

### Compte de service

Créer un compte dédié au worker en base :

```sql
INSERT INTO users (email, password_hash, role, created_at)
VALUES (
  'worker@flutch.internal',
  -- Générer avec : node -e "const c=require('crypto'); const salt=c.randomBytes(16); c.scrypt('MOT_DE_PASSE', salt, 64, (e,k) => console.log(salt.toString('hex')+':'+k.toString('hex')))"
  'salt_hex:hash_hex',
  'worker',
  NOW()
);
```

---

## Tests

```bash
# Tous les tests
npm test

# Tests DPE uniquement
npm run test:dpe

# Avec couverture
npm test -- --coverage
```

Les tests `tests/dpe.test.js` couvrent :
- `normalizeDpe()` : 15 cas dont formats texte libre, casse, valeurs invalides
- `parseDpeClasses()` : JSON, CSV, tableau JS, valeurs invalides
- Logique SQL DPE : simulation en JS des 5 cas de la clause WHERE

---

## Checklist de déploiement

### Défi 1
- [ ] Redis disponible et accessible (`REDIS_URL`)
- [ ] `npm install bullmq ioredis`
- [ ] `server.js`
- [ ] Table `webhook_events`
- [ ] Test : envoyer un webhook mock → vérifier log "[Queue] webhook enqueued"

### Défi 2
- [ ] Migration SQL appliquée : `psql $DATABASE_URL -f migrations/2026_001_add_dpe.sql`
- [ ] Hash Pipedrive DPE récupérés et définis en `PIPEDRIVE_DEAL_FIELD_DPE` / `PIPEDRIVE_PERSON_FIELD_DPE`
- [ ] Sync complète déclenchée : `curl -X POST /api/sync/full`
- [ ] Vérification : `SELECT dpe_classe, COUNT(*) FROM biens GROUP BY 1;`
- [ ] Test matching DPE : créer un acquéreur avec DPE ["A","B"] et vérifier l'exclusion des biens F/G

### Défi 3
- [ ] Compte de service créé (`worker@flutch.internal`)
- [ ] `.state.json` initialisé (peut être vide `{}`)
- [ ] Variables d'environnement configurées
- [ ] Test : `WORKER_ONCE=1 node workers/relanceWorker.js`
- [ ] Vérifier les logs stdout + le contenu de `.state.json` après exécution