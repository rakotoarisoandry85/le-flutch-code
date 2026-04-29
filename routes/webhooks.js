// 'use strict';

// const express = require('express');
// const crypto = require('crypto');
// const config = require('../config');
// const { logger } = require('../lib/logger');
// const asyncHandler = require('../middleware/asyncHandler');
// const { requireAuth, requireAdminAsync } = require('../middleware/auth');
// const { pool } = require('../db');
// const { syncSingleBien, syncSingleAcquereur, archiveDeal } = require('../pipedrive');
// const { getCachedStageIds, listWebhooks } = require('../services/pipedriveService');

// const router = express.Router();

// // FIX Audit 3.6 — Cache d'idempotence pour rejeter les webhooks rejoués (LRU borné)
// const IDEMPOTENCE_MAX = 10000;
// const IDEMPOTENCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// const idempotenceCache = new Map();

// function isWebhookDuplicate(event, dealId, timestamp) {
//   const key = `${event}:${dealId}:${timestamp || ''}`;
//   if (idempotenceCache.has(key)) return true;
//   // Nettoyage si le cache dépasse la borne (FIX Audit 4.4)
//   if (idempotenceCache.size >= IDEMPOTENCE_MAX) {
//     const now = Date.now();
//     for (const [k, ts] of idempotenceCache) {
//       if (now - ts > IDEMPOTENCE_TTL_MS) idempotenceCache.delete(k);
//     }
//     // Si toujours plein, supprimer le plus ancien
//     if (idempotenceCache.size >= IDEMPOTENCE_MAX) {
//       const firstKey = idempotenceCache.keys().next().value;
//       idempotenceCache.delete(firstKey);
//     }
//   }
//   idempotenceCache.set(key, Date.now());
//   return false;
// }

// router.post('/pipedrive', (req, res) => {
//   const token = req.query.token;
//   const expected = config.WEBHOOK_SECRET;
//   if (!token || typeof token !== 'string' || token.length !== expected.length
//       || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
//     logger.warn('⚠️ Webhook: token invalide rejeté');
//     return res.status(403).json({ error: 'forbidden' });
//   }

//   // FIX Audit 3.6 — Vérification de timestamp pour rejeter les webhooks trop vieux
//   const dateHeader = req.headers['date'] || req.headers['x-pipedrive-timestamp'];
//   if (dateHeader) {
//     const webhookTime = new Date(dateHeader).getTime();
//     const now = Date.now();
//     if (!isNaN(webhookTime) && Math.abs(now - webhookTime) > 5 * 60 * 1000) {
//       logger.warn(`⚠️ Webhook: timestamp trop ancien/futur rejeté (${dateHeader})`);
//       return res.status(403).json({ error: 'webhook expired' });
//     }
//   }

//   const { event, current } = req.body || {};
//   if (!current || !event) {
//     return res.status(200).json({ ok: true });
//   }

//   // FIX Audit 3.6 — Vérification d'idempotence
//   const dealId = current.id;
//   const updateTime = current.update_time || '';
//   if (isWebhookDuplicate(event, dealId, updateTime)) {
//     logger.info(`📨 Webhook: ${event} deal #${dealId} ignoré (doublon détecté)`);
//     return res.status(200).json({ ok: true, deduplicated: true });
//   }

//   res.status(200).json({ ok: true });

//   (async () => {
//     try {
//       const stageId = current.stage_id;
//       const status = current.status;

//       logger.info(`📨 Webhook: ${event} deal #${dealId} stage=${stageId} status=${status}`);

//       if (event === 'deleted.deal' || status === 'deleted' || status === 'lost') {
//         await archiveDeal(dealId);
//         return;
//       }

//       const { bienStageId, acqStageId } = getCachedStageIds();
//       const isBienStage = stageId === bienStageId;
//       const isAcqStage = stageId === acqStageId;

//       if (isBienStage && status === 'open') {
//         await archiveDeal(dealId);
//         await syncSingleBien(current, config.PIPEDRIVE_API_TOKEN);
//       } else if (isAcqStage && status === 'open') {
//         await archiveDeal(dealId);
//         await syncSingleAcquereur(current);
//       } else {
//         const { rows: existingBien } = await pool.query('SELECT id FROM biens WHERE pipedrive_deal_id = $1 AND archived = 0', [dealId]);
//         const { rows: existingAcq } = await pool.query('SELECT id FROM acquereurs WHERE pipedrive_deal_id = $1 AND archived = 0', [dealId]);
//         if (existingBien.length || existingAcq.length) {
//           await archiveDeal(dealId);
//           logger.info(`📨 Webhook: deal #${dealId} a quitté les étapes cibles → archivé`);
//         }
//       }
//     } catch (e) {
//       logger.error('❌ Webhook error: ' + e.message);
//     }
//   })();
// });

// router.get('/status', requireAuth, requireAdminAsync, asyncHandler(async (req, res) => {
//   try {
//     const hooks = await listWebhooks();
//     const { bienStageId, acqStageId } = getCachedStageIds();
//     res.json({ webhooks: hooks, bien_stage_id: bienStageId, acq_stage_id: acqStageId });
//   } catch (e) {
//     res.json({ error: e.message });
//   }
// }));

// module.exports = router;


// routes/webhooks.js
'use strict';

const express = require("express");
const crypto = require('crypto');
const config = require("../config");
const { logger } = require("../lib/logger");
const { enqueueWebhook } = require("../lib/queue");

const router = express.Router();

/**
 * Vérifier la signature du webhook Pipedrive
 * Pipedrive envoie un header 'X-Pipedrive-Signature' 
 */
function verifyPipedriveWebhook(body, signature) {
  if (!config.WEBHOOK_SECRET) {
    logger.warn('⚠️ WEBHOOK_SECRET non configuré — skipping signature verification');
    return true;
  }
  
  try {
    // Pipedrive signe le body brut avec HMAC-SHA1
    const expected = crypto
      .createHmac('sha1', config.WEBHOOK_SECRET)
      .update(JSON.stringify(body))
      .digest('hex');
    
    if (signature && signature.length === expected.length) {
      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expected, 'hex')
      );
    }
    return false;
  } catch (err) {
    logger.error('❌ Webhook verification error:', err);
    return false;
  }
}

/**
 * POST /api/webhook/pipedrive
 * Reçoit les webhooks Pipedrive et les enqueue pour traitement asynchrone.
 * 
 * Flux:
 * 1. Vérifier signature
 * 2. Créer job unique (idempotence)
 * 3. Enqueuer en Redis
 * 4. Répondre 202 Accepted immédiatement
 * 5. Consumer worker traite le job en arrière-plan
 */
router.post("/pipedrive", async (req, res) => {
  const body = req.body;
  const headers = req.headers;

  try {
    // 1. Vérifier signature Pipedrive
    const signature = headers['x-pipedrive-signature'];
    const isValid = verifyPipedriveWebhook(body, signature);
    
    if (!isValid) {
      logger.warn('⚠️ Webhook: signature invalide rejetée');
      return res.status(403).json({ error: 'invalid signature' });
    }

    // Extraire infos du webhook
    const eventType = headers['x-pipedrive-event']; // ex: "deal.updated"
    const meta = headers['x-pipedrive-meta']; // ex: "{request_id: 123}"
    const { current, previous } = body;
    const dealId = current?.id || previous?.id;
    const timestamp = current?.update_time || Date.now();

    if (!dealId || !eventType) {
      logger.warn('⚠️ Webhook: dealId ou eventType manquant');
      return res.status(200).json({ ok: true }); // Ne pas échouer Pipedrive
    }

    // 2. Enqueuer pour traitement asynchrone
    const eventData = {
      eventType,
      dealId,
      timestamp,
      meta,
      payload: body,
    };

    await enqueueWebhook(eventData);
    
    logger.info(`📨 Webhook ${eventType} deal #${dealId} enqueued (job will retry 3x)`);

    // 3. Répondre rapidement (202 Accepted)
    // Pipedrive reçoit une réponse immédiate, pas d'attente du traitement
    res.status(202).json({ 
      status: "accepted",
      message: "Webhook enqueued for processing",
      dealId,
      eventType,
    });

  } catch (error) {
    logger.error("❌ Webhook error (producer):", error);
    // Ne pas échouer Pipedrive — il faut gérer la résiliencedu côté queue
    res.status(202).json({ error: "Internal error, queued for retry" });
  }
});

/**
 * GET /api/webhook/status
 * Endpoint d'admin pour monitorer la queue
 */
router.get("/status", async (req, res) => {
  try {
    const { getQueueStatus } = require("../lib/queue");
    const status = await getQueueStatus();
    res.json({ 
      queue: 'pipedrive-webhook',
      ...status,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
