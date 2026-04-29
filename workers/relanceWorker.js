#!/usr/bin/env node
'use strict';

/**
 * workers/relanceWorker.js
 * Worker autonome de relance acquéreurs.
 *
 * Responsabilités :
 *   1. S'authentifie via JWT (renouvellement automatique)
 *   2. Récupère le dashboard de todos (acquéreurs + biens matchés non traités)
 *   3. Pour chaque acquéreur (max 20/cycle), envoie jusqu'à 3 biens en email+SMS
 *   4. Maintient un état local (.state.json) pour éviter les doubles envois
 *   5. Tourne en boucle toutes les 30 min entre 9h-19h heure de Paris
 *   6. Respecte le rate-limit API (100 req/min)
 *
 * Usage :
 *   node workers/relanceWorker.js
 *   WORKER_ONCE=1 node workers/relanceWorker.js   ← un seul cycle
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  API_BASE_URL:        process.env.API_BASE_URL        ?? 'http://localhost:3000',
  WORKER_EMAIL:        process.env.WORKER_EMAIL        ?? '',
  WORKER_PASSWORD:     process.env.WORKER_PASSWORD     ?? '',
  STATE_FILE:          process.env.STATE_FILE          ?? path.join(__dirname, '../.state.json'),
  CYCLE_INTERVAL_MS:   Number(process.env.CYCLE_INTERVAL_MS ?? 30 * 60 * 1000),  // 30 min
  MAX_ACQUEREURS:      Number(process.env.MAX_ACQUEREURS     ?? 20),
  MAX_BIENS_PER_ACQ:   Number(process.env.MAX_BIENS_PER_ACQ  ?? 3),
  DEDUP_DAYS:          Number(process.env.DEDUP_DAYS         ?? 30),
  RATE_LIMIT_RPM:      Number(process.env.RATE_LIMIT_RPM     ?? 100),
  TZ_OFFSET_HOURS:     Number(process.env.TZ_OFFSET_HOURS    ?? 1),   // Paris UTC+1 (CET)
  START_HOUR:          Number(process.env.START_HOUR         ?? 9),
  END_HOUR:            Number(process.env.END_HOUR           ?? 19),
  CHANNEL:             process.env.CHANNEL                   ?? 'both',  // 'email'|'sms'|'both'
};

// ─── Logger simple avec timestamps ───────────────────────────────────────────

const log = {
  info:  (...args) => console.log(`[${ts()}] [INFO ]`, ...args),
  warn:  (...args) => console.warn(`[${ts()}] [WARN ]`, ...args),
  error: (...args) => console.error(`[${ts()}] [ERROR]`, ...args),
  debug: (...args) => process.env.DEBUG && console.debug(`[${ts()}] [DEBUG]`, ...args),
};

function ts() { return new Date().toISOString(); }

// ─── Rate limiter ─────────────────────────────────────────────────────────────

class RateLimiter {
  constructor(rpm) {
    this._rpm = rpm;
    this._tokens = rpm;
    this._lastRefill = Date.now();
  }

  async acquire() {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;

    // Refill tokens proportionnellement au temps écoulé
    this._tokens = Math.min(this._rpm, this._tokens + elapsed * (this._rpm / 60));
    this._lastRefill = now;

    if (this._tokens >= 1) {
      this._tokens--;
      return;
    }

    // Attendre jusqu'à avoir 1 token
    const waitMs = Math.ceil((1 - this._tokens) * (60 / this._rpm) * 1000);
    log.debug(`[RateLimit] attente ${waitMs}ms`);
    await sleep(waitMs);
    this._tokens = 0;
  }
}

const rateLimiter = new RateLimiter(CONFIG.RATE_LIMIT_RPM);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Heure courante à Paris (UTC+1/+2 selon DST).
 * Approximation simple via TZ_OFFSET_HOURS (à ajuster en été : +2).
 */
function parisHour() {
  const now = new Date();
  return (now.getUTCHours() + CONFIG.TZ_OFFSET_HOURS) % 24;
}

/** Vérifie si on est dans la plage horaire autorisée (9h-19h Paris). */
function isWithinWorkHours() {
  const hour = parisHour();
  return hour >= CONFIG.START_HOUR && hour < CONFIG.END_HOUR;
}

// ─── HTTP Client ──────────────────────────────────────────────────────────────

/**
 * Requête HTTP/HTTPS simple sans dépendance externe.
 *
 * @param {string} method
 * @param {string} urlPath   - Chemin relatif (ex: '/api/login')
 * @param {object|null} body
 * @param {string|null} token - Bearer token JWT
 * @returns {Promise<{ status: number, body: any }>}
 */
async function apiRequest(method, urlPath, body = null, token = null) {
  await rateLimiter.acquire();

  const fullUrl = new URL(urlPath, CONFIG.API_BASE_URL);
  const isHttps = fullUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  const bodyStr = body ? JSON.stringify(body) : null;

  const options = {
    hostname: fullUrl.hostname,
    port: fullUrl.port || (isHttps ? 443 : 80),
    path: fullUrl.pathname + fullUrl.search,
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error('Request timeout'));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Gestion d'état local ─────────────────────────────────────────────────────

/**
 * Structure du fichier .state.json :
 * {
 *   "token": "eyJ...",
 *   "tokenExpiresAt": 1700000000000,
 *   "processed": {
 *     "42": {                    ← acquereur_id
 *       "123": 1700000000000,   ← bien_id: timestamp d'envoi
 *       "456": 1700100000000
 *     }
 *   }
 * }
 */

/** @type {{ token: string|null, tokenExpiresAt: number, processed: Record<string, Record<string, number>> }} */
let state = {
  token: null,
  tokenExpiresAt: 0,
  processed: {},
};

function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      const raw = fs.readFileSync(CONFIG.STATE_FILE, 'utf-8');
      state = { ...state, ...JSON.parse(raw) };
      log.info(`[State] chargé depuis ${CONFIG.STATE_FILE}`, {
        acquereurs: Object.keys(state.processed).length,
      });
    }
  } catch (err) {
    log.warn('[State] impossible de lire .state.json, démarrage à vide', { err: err.message });
  }
}

function saveState() {
  try {
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    log.debug('[State] sauvegardé');
  } catch (err) {
    log.error('[State] échec sauvegarde', { err: err.message });
  }
}

/**
 * Purge les entrées processed > DEDUP_DAYS pour éviter un fichier infini.
 */
function cleanOldProcessed() {
  const cutoff = Date.now() - CONFIG.DEDUP_DAYS * 24 * 60 * 60 * 1000;
  let purged = 0;

  for (const acqId of Object.keys(state.processed)) {
    for (const bienId of Object.keys(state.processed[acqId])) {
      if (state.processed[acqId][bienId] < cutoff) {
        delete state.processed[acqId][bienId];
        purged++;
      }
    }
    if (Object.keys(state.processed[acqId]).length === 0) {
      delete state.processed[acqId];
    }
  }

  if (purged > 0) log.info(`[State] ${purged} entrée(s) expirée(s) purgée(s)`);
}

/**
 * Vérifie si un bien a déjà été envoyé à un acquéreur dans les DEDUP_DAYS derniers jours.
 */
function alreadySent(acquereurId, bienId) {
  const acqKey = String(acquereurId);
  const bienKey = String(bienId);
  const sentAt = state.processed[acqKey]?.[bienKey];
  if (!sentAt) return false;

  const cutoff = Date.now() - CONFIG.DEDUP_DAYS * 24 * 60 * 60 * 1000;
  return sentAt > cutoff;
}

/**
 * Marque un bien comme envoyé (APRÈS succès API).
 */
function markSent(acquereurId, bienId) {
  const acqKey = String(acquereurId);
  const bienKey = String(bienId);

  if (!state.processed[acqKey]) state.processed[acqKey] = {};
  state.processed[acqKey][bienKey] = Date.now();
}

// ─── Authentification JWT ─────────────────────────────────────────────────────

/** Vérifie si le token est valide (avec 5 min de marge). */
function isTokenValid() {
  return state.token && state.tokenExpiresAt > Date.now() + 5 * 60 * 1000;
}

/**
 * Authentifie le worker et stocke le token JWT.
 * Durée de vie supposée : 7 jours (selon spécification défi).
 */
async function authenticate() {
  log.info('[Auth] tentative d\'authentification…');

  const res = await apiRequest('POST', '/api/login', {
    email:    CONFIG.WORKER_EMAIL,
    password: CONFIG.WORKER_PASSWORD,
  });

  if (res.status !== 200 || !res.body?.token) {
    throw new Error(`[Auth] échec authentification — HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  state.token = res.body.token;
  // Durée du token : lue depuis la réponse ou 7 jours par défaut
  const expiresIn = res.body.expiresIn ?? 7 * 24 * 60 * 60;   // secondes
  state.tokenExpiresAt = Date.now() + expiresIn * 1000;

  log.info('[Auth] authentifié', { expiresAt: new Date(state.tokenExpiresAt).toISOString() });

  // Sauvegarder le token
  saveState();
}

/**
 * Retourne un token valide, re-authentifie si nécessaire.
 */
async function getToken() {
  if (!isTokenValid()) {
    await authenticate();
  }
  return state.token;
}

// ─── API métier ───────────────────────────────────────────────────────────────

/**
 * Récupère le dashboard de todos :
 * acquéreurs avec leurs biens matchés en statut 'non_traite'.
 *
 * @returns {Promise<Array<{ acquereur: object, biens: object[] }>>}
 */
async function fetchTodosDashboard() {
  const token = await getToken();
  const res = await apiRequest('GET', '/api/todos/dashboard', null, token);

  if (res.status === 401) {
    log.warn('[API] 401 reçu sur dashboard — renouvellement token…');
    state.token = null;
    const freshToken = await getToken();
    const retry = await apiRequest('GET', '/api/todos/dashboard', null, freshToken);

    if (retry.status !== 200) {
      throw new Error(`[API] dashboard inaccessible après renouvellement — HTTP ${retry.status}`);
    }
    return retry.body?.data ?? [];
  }

  if (res.status !== 200) {
    throw new Error(`[API] dashboard — HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  return res.body?.data ?? [];
}

/**
 * Envoie une notification (email + SMS) pour un bien et un acquéreur.
 *
 * @param {number} acquereurId
 * @param {number} bienId
 * @returns {Promise<boolean>}  true si succès
 */
async function enqueueNotification(acquereurId, bienId) {
  const token = await getToken();

  const res = await apiRequest(
    'POST',
    '/api/email-queue/enqueue',
    {
      acquereur_id: acquereurId,
      bien_id:      bienId,
      channel:      CONFIG.CHANNEL,
    },
    token
  );

  if (res.status === 429) {
    const retryAfter = Number(res.body?.retryAfter ?? 60);
    log.warn(`[API] 429 rate-limit — attente ${retryAfter}s`);
    await sleep(retryAfter * 1000);

    // Retry une fois
    const retry = await apiRequest('POST', '/api/email-queue/enqueue', {
      acquereur_id: acquereurId,
      bien_id:      bienId,
      channel:      CONFIG.CHANNEL,
    }, token);

    if (retry.status >= 200 && retry.status < 300) return true;

    log.error('[API] enqueue échoué après retry 429', { status: retry.status, acquereurId, bienId });
    return false;
  }

  if (res.status >= 200 && res.status < 300) return true;

  log.error('[API] enqueue échoué', { status: res.status, acquereurId, bienId, body: res.body });
  return false;
}

// ─── Cycle de travail ─────────────────────────────────────────────────────────

/**
 * Exécute un cycle complet de relance.
 */
async function runCycle() {
  log.info('═══ Début de cycle ═══');

  // 1. Nettoyage des anciennes entrées
  cleanOldProcessed();

  // 2. Récupération du dashboard
  let todos;
  try {
    todos = await fetchTodosDashboard();
  } catch (err) {
    log.error('[Cycle] échec récupération dashboard', { err: err.message });
    return;
  }

  log.info(`[Cycle] ${todos.length} acquéreur(s) dans le dashboard`);

  // 3. Limiter à MAX_ACQUEREURS par cycle
  const toProcess = todos.slice(0, CONFIG.MAX_ACQUEREURS);

  let totalSent = 0;
  let totalSkipped = 0;

  for (const entry of toProcess) {
    const acquereur = entry.acquereur ?? entry;
    const biens     = (entry.biens ?? entry.matched_biens ?? [])
      .filter((b) => b.statut === 'non_traite' || b.statut === undefined);

    const acqId  = acquereur.id;
    const acqNom = acquereur.nom ?? acquereur.name ?? `#${acqId}`;

    if (!acqId) {
      log.warn('[Cycle] acquéreur sans id, ignoré', { acquereur });
      continue;
    }

    if (biens.length === 0) {
      log.debug(`[Cycle] ${acqNom} — aucun bien non traité`);
      continue;
    }

    // Filtrer les biens déjà envoyés dans les DEDUP_DAYS derniers jours
    const biensNonEnvoyes = biens.filter((b) => !alreadySent(acqId, b.id));
    const biensAEnvoyer   = biensNonEnvoyes.slice(0, CONFIG.MAX_BIENS_PER_ACQ);

    if (biensAEnvoyer.length === 0) {
      log.debug(`[Cycle] ${acqNom} — tous les biens déjà envoyés récemment`);
      totalSkipped += biens.length;
      continue;
    }

    log.info(`[Cycle] ${acqNom} — envoi de ${biensAEnvoyer.length}/${biens.length} bien(s)`);

    for (const bien of biensAEnvoyer) {
      // Vérification idempotence juste avant envoi
      if (alreadySent(acqId, bien.id)) {
        log.debug(`[Cycle] bien #${bien.id} déjà envoyé à ${acqNom}, skip`);
        totalSkipped++;
        continue;
      }

      try {
        const success = await enqueueNotification(acqId, bien.id);

        if (success) {
          // Écrire l'état APRÈS succès API (pas avant)
          markSent(acqId, bien.id);
          saveState();
          totalSent++;

          log.info(`[Cycle] ✓ envoyé — acq:${acqId} bien:${bien.id} (${bien.titre ?? ''})`);
        }
      } catch (err) {
        log.error('[Cycle] erreur envoi notification', {
          acqId,
          bienId: bien.id,
          err: err.message,
        });
        // Continuer avec les autres biens
      }
    }
  }

  log.info(`═══ Fin de cycle — envoyés: ${totalSent} | ignorés: ${totalSkipped} ═══`);
}

// ─── Boucle principale ────────────────────────────────────────────────────────

async function main() {
  log.info('╔══════════════════════════════════════╗');
  log.info('║   relanceWorker — démarrage          ║');
  log.info(`║   BASE_URL: ${CONFIG.API_BASE_URL.padEnd(26)}║`);
  log.info(`║   Cycle: ${String(CONFIG.CYCLE_INTERVAL_MS / 60000 + 'min').padEnd(29)}║`);
  log.info(`║   Plage: ${CONFIG.START_HOUR}h-${CONFIG.END_HOUR}h Paris${' '.repeat(21)}║`);
  log.info('╚══════════════════════════════════════╝');

  if (!CONFIG.WORKER_EMAIL || !CONFIG.WORKER_PASSWORD) {
    log.error('WORKER_EMAIL et WORKER_PASSWORD sont requis');
    process.exit(1);
  }

  // Chargement de l'état persisté
  loadState();

  // Mode "une seule exécution" (utile pour tests/cron externe)
  if (process.env.WORKER_ONCE === '1') {
    log.info('[Main] mode WORKER_ONCE — un seul cycle');
    if (!isWithinWorkHours()) {
      log.warn('[Main] hors plage horaire, cycle forcé (mode WORKER_ONCE)');
    }
    await runCycle();
    log.info('[Main] terminé (WORKER_ONCE)');
    process.exit(0);
  }

  // Boucle continue
  while (true) {
    if (!isWithinWorkHours()) {
      const hour = parisHour();
      log.info(`[Main] hors plage horaire (${hour}h Paris) — attente…`);
      // Attente jusqu'à la prochaine heure paire (check toutes les 15 min)
      await sleep(15 * 60 * 1000);
      continue;
    }

    try {
      await runCycle();
    } catch (err) {
      log.error('[Main] erreur non rattrapée dans le cycle', { err: err.message, stack: err.stack });
    }

    log.info(`[Main] prochain cycle dans ${CONFIG.CYCLE_INTERVAL_MS / 60000} min`);
    await sleep(CONFIG.CYCLE_INTERVAL_MS);
  }
}

// ─── Signaux ──────────────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  log.info('[Main] SIGTERM reçu — arrêt propre');
  saveState();
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('[Main] SIGINT reçu — arrêt propre');
  saveState();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log.error('[Main] exception non rattrapée', { err: err.message, stack: err.stack });
  saveState();
  process.exit(1);
});

// ─── Lancement ────────────────────────────────────────────────────────────────

main().catch((err) => {
  log.error('[Main] erreur fatale au démarrage', { err: err.message });
  process.exit(1);
});