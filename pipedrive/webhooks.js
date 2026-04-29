'use strict';

/**
 * routes/webhooks.js
 * Endpoint Pipedrive webhook — répond 202 immédiatement
 * et délègue le traitement au Worker BullMQ asynchrone.
 *
 * Sécurité :
 *   - Vérification HMAC / token secret avant tout traitement
 *   - Payload sauvegardé en DB (webhook_events) pour audit/replay
 *   - Déduplication via jobId déterministe (payload.meta.id)
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const logger = require('../lib/logger');
const { enqueueWebhook } = require('../lib/queue');
const db = require('../db');

// ─── Constantes ───────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';
const MAX_PAYLOAD_BYTES = 1024 * 512; // 512 KB

// ─── Middleware de vérification signature ─────────────────────────────────────

/**
 * Vérifie le token WEBHOOK_SECRET envoyé en Basic Auth par Pipedrive.
 * Pipedrive envoie : Authorization: Basic base64(user:WEBHOOK_SECRET)
 * Alternative : header X-Pipedrive-Token si configuré côté Pipedrive.
 */
function verifyWebhookSecret(req, res, next) {
  // Mode développement sans secret configuré
  if (!WEBHOOK_SECRET) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('[webhook] WEBHOOK_SECRET non configuré — vérification ignorée (dev)');
      return next();
    }
    return res.status(500).json({ error: 'Webhook secret non configuré' });
  }

  // Méthode 1 : Basic Auth (recommandé Pipedrive)
  const authHeader = req.headers.authorization ?? '';
  if (authHeader.startsWith('Basic ')) {
    const b64 = authHeader.slice(6);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const password = decoded.split(':').slice(1).join(':');
    const valid = crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(WEBHOOK_SECRET)
    );
    if (valid) return next();
  }

  // Méthode 2 : Header X-Pipedrive-Signature (fallback)
  const sigHeader = req.headers['x-pipedrive-signature'] ?? '';
  if (sigHeader) {
    const rawBody = req.rawBody ?? JSON.stringify(req.body);
    const expectedSig = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    const valid = crypto.timingSafeEqual(
      Buffer.from(sigHeader),
      Buffer.from(expectedSig)
    );
    if (valid) return next();
  }

  logger.warn('[webhook] signature invalide', {
    ip: req.ip,
    hasAuth: !!authHeader,
    hasSig: !!sigHeader,
  });

  return res.status(401).json({ error: 'Signature invalide' });
}

// ─── Sauvegarde audit en DB ───────────────────────────────────────────────────

/**
 * Persiste l'événement brut dans webhook_events pour audit/replay.
 * Non-bloquant : les erreurs DB ne doivent pas empêcher la réponse 202.
 *
 * @param {string} eventType
 * @param {object} payload
 * @param {string|null} jobId
 */
async function persistWebhookEvent(eventType, payload, jobId) {
  try {
    await db.query(
      `INSERT INTO webhook_events (event_type, payload, job_id, received_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (job_id) DO NOTHING`,
      [eventType, JSON.stringify(payload), jobId]
    );
  } catch (err) {
    logger.error('[webhook] échec persistance event', { eventType, jobId, err: err.message });
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────

/**
 * POST /api/webhook/pipedrive
 *
 * Réponse immédiate 202 Accepted.
 * Traitement réel délégué au Worker via BullMQ.
 */
async function handlePipedriveWebhook(req, res) {
  // Validation basique du payload
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Payload invalide' });
  }

  // Construction du type d'événement (ex: 'updated.deal')
  const eventAction = payload?.meta?.action;
  const eventObject = payload?.meta?.object;

  if (!eventAction || !eventObject) {
    logger.warn('[webhook] meta.action ou meta.object manquant', { payload });
    return res.status(400).json({ error: 'Champs meta.action / meta.object requis' });
  }

  const eventType = `${eventAction}.${eventObject}`;
  const pipedriveMeta = payload?.meta ?? {};

  // Répondre 202 immédiatement AVANT tout traitement
  res.status(202).json({
    accepted: true,
    eventType,
    timestamp: new Date().toISOString(),
  });

  // --- Traitement asynchrone (non bloquant pour la réponse HTTP) ---
  setImmediate(async () => {
    let jobId = null;
    try {
      const job = await enqueueWebhook(eventType, payload, {
        // Priorité haute pour suppressions (évite d'envoyer des mails sur biens supprimés)
        priority: eventAction === 'deleted' ? 1 : 10,
      });
      jobId = job.id;

      logger.info('[webhook] événement enqueued', {
        eventType,
        jobId,
        objectId: pipedriveMeta.id,
      });

      // Persistance audit (best-effort)
      await persistWebhookEvent(eventType, payload, jobId);

    } catch (err) {
      logger.error('[webhook] échec enqueue', {
        eventType,
        objectId: pipedriveMeta.id,
        err: err.message,
        stack: err.stack,
      });

      // Fallback : tenter de sauvegarder pour replay manuel
      await persistWebhookEvent(eventType, payload, jobId).catch(() => {});
    }
  });
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post(
  '/pipedrive',
  // Limite taille payload avant parsing JSON
  express.json({ limit: MAX_PAYLOAD_BYTES }),
  verifyWebhookSecret,
  handlePipedriveWebhook
);

/**
 * GET /api/webhook/health
 * Vérifie que la queue Redis est accessible.
 */
router.get('/health', async (req, res) => {
  try {
    const { webhookQueue } = require('../lib/queue');
    const counts = await webhookQueue.getJobCounts('waiting', 'active', 'failed', 'delayed');
    res.json({ status: 'ok', queue: counts });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

module.exports = router;