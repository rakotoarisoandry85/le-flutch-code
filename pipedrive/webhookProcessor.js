'use strict';

/**
 * workers/webhookProcessor.js
 * Worker BullMQ — consomme la queue « webhook-events » et dispatche
 * vers les handlers métier (sync Pipedrive, mise à jour DB…).
 *
 * Cycle de vie :
 *   server.js (startup) → startWebhookWorker()
 *   SIGTERM             → worker.close() (graceful drain)
 */

const { Worker } = require('bullmq');
const { QUEUE_NAMES, createRedisConnection } = require('../lib/queue');
const logger = require('../lib/logger');
const db = require('../db');

// ─── Handlers par type d'événement ───────────────────────────────────────────
// Chaque handler reçoit (payload, job) et doit être idempotent.

const handlers = {
  // ── Biens (deals Pipedrive) ─────────────────────────────────────────────

  'added.deal':   handleBienUpsert,
  'updated.deal': handleBienUpsert,
  'deleted.deal': handleBienDeleted,

  // ── Acquéreurs (persons Pipedrive) ──────────────────────────────────────

  'added.person':   handleAcquereurUpsert,
  'updated.person': handleAcquereurUpsert,
  'deleted.person': handleAcquereurDeleted,

  // ── Activités (notes, appels…) ──────────────────────────────────────────

  'added.activity':   handleActivity,
  'updated.activity': handleActivity,
};

// ─── Implémentations handlers ─────────────────────────────────────────────────

/**
 * Upsert d'un bien depuis un événement deal Pipedrive.
 * @param {object} payload   Corps brut du webhook Pipedrive
 * @param {import('bullmq').Job} job
 */
async function handleBienUpsert(payload, job) {
  const { pipedrive } = require('../pipedrive');    // lazy require – évite circular dep
  const deal = payload?.current ?? payload?.data;

  if (!deal?.id) {
    logger.warn('[webhookProcessor] deal sans id, ignoré', { jobId: job.id });
    return;
  }

  logger.info('[webhookProcessor] sync bien depuis webhook', { dealId: deal.id, jobId: job.id });
  await pipedrive.syncSingleDeal(deal.id);
}

/**
 * Suppression logique d'un bien.
 */
async function handleBienDeleted(payload, job) {
  const deal = payload?.previous ?? payload?.data;
  if (!deal?.id) return;

  logger.info('[webhookProcessor] suppression bien', { dealId: deal.id, jobId: job.id });

  await db.query(
    `UPDATE biens SET statut = 'archive', updated_at = NOW() WHERE pipedrive_id = $1`,
    [String(deal.id)]
  );
}

/**
 * Upsert d'un acquéreur depuis un événement person Pipedrive.
 */
async function handleAcquereurUpsert(payload, job) {
  const { pipedrive } = require('../pipedrive');
  const person = payload?.current ?? payload?.data;

  if (!person?.id) {
    logger.warn('[webhookProcessor] person sans id, ignoré', { jobId: job.id });
    return;
  }

  logger.info('[webhookProcessor] sync acquéreur depuis webhook', { personId: person.id, jobId: job.id });
  await pipedrive.syncSinglePerson(person.id);
}

/**
 * Suppression logique d'un acquéreur.
 */
async function handleAcquereurDeleted(payload, job) {
  const person = payload?.previous ?? payload?.data;
  if (!person?.id) return;

  logger.info('[webhookProcessor] suppression acquéreur', { personId: person.id, jobId: job.id });

  await db.query(
    `UPDATE acquereurs SET actif = FALSE, updated_at = NOW() WHERE pipedrive_id = $1`,
    [String(person.id)]
  );
}

/**
 * Log d'activité Pipedrive (note, appel…) — peut déclencher un re-matching.
 */
async function handleActivity(payload, job) {
  const activity = payload?.current ?? payload?.data;
  if (!activity?.id) return;

  logger.info('[webhookProcessor] activité reçue', { activityId: activity.id, type: activity.type, jobId: job.id });

  // Logguer l'activité en base pour audit
  await db.query(
    `INSERT INTO action_logs (source, reference_id, action, metadata, created_at)
     VALUES ('webhook', $1, 'activity_received', $2, NOW())
     ON CONFLICT DO NOTHING`,
    [String(activity.id), JSON.stringify({ type: activity.type, subject: activity.subject })]
  ).catch((err) => logger.warn('[webhookProcessor] échec log activité', { err: err.message }));
}

// ─── Processeur principal ─────────────────────────────────────────────────────

/**
 * Fonction appelée par BullMQ pour chaque job.
 * Doit être idempotente (un même jobId peut être traité plusieurs fois en cas de crash).
 *
 * @param {import('bullmq').Job} job
 */
async function processJob(job) {
  const { eventType, payload, receivedAt } = job.data;
  const lag = Date.now() - (receivedAt ?? Date.now());

  logger.info('[webhookProcessor] traitement job', {
    jobId: job.id,
    name: job.name,
    eventType,
    attempt: job.attemptsMade + 1,
    lagMs: lag,
  });

  const handler = handlers[eventType];

  if (!handler) {
    logger.warn('[webhookProcessor] type d\'événement non géré', { eventType, jobId: job.id });
    return { skipped: true, eventType };
  }

  try {
    const result = await handler(payload, job);
    logger.info('[webhookProcessor] job terminé avec succès', { jobId: job.id, eventType });
    return result ?? { ok: true };
  } catch (err) {
    // BullMQ re-lancera automatiquement selon la politique backoff/attempts
    logger.error('[webhookProcessor] échec handler', {
      jobId: job.id,
      eventType,
      attempt: job.attemptsMade + 1,
      err: err.message,
      stack: err.stack,
    });
    throw err;   // propagation obligatoire pour que BullMQ gère le retry
  }
}

// ─── Démarrage / arrêt ────────────────────────────────────────────────────────

/** @type {import('bullmq').Worker | null} */
let workerInstance = null;

/**
 * Démarre le Worker BullMQ.
 * Idempotent : un deuxième appel retourne l'instance existante.
 *
 * @param {{ concurrency?: number }} [opts]
 * @returns {import('bullmq').Worker}
 */
function startWebhookWorker(opts = {}) {
  if (workerInstance) return workerInstance;

  const concurrency = opts.concurrency ?? Number(process.env.WEBHOOK_WORKER_CONCURRENCY ?? 4);

  // Chaque Worker DOIT avoir sa propre connexion Redis (maxRetriesPerRequest=null)
  const workerConnection = createRedisConnection();

  workerInstance = new Worker(QUEUE_NAMES.WEBHOOK, processJob, {
    connection: workerConnection,
    concurrency,
    lockDuration: 30_000,      // 30 s max par job avant stall
    stalledInterval: 15_000,   // vérification des jobs bloqués toutes les 15 s
  });

  workerInstance.on('completed', (job) =>
    logger.info('[Worker] job completed', { jobId: job.id, name: job.name })
  );

  workerInstance.on('failed', (job, err) =>
    logger.error('[Worker] job failed', {
      jobId: job?.id,
      name: job?.name,
      attempts: job?.attemptsMade,
      err: err.message,
    })
  );

  workerInstance.on('error', (err) =>
    logger.error('[Worker] erreur interne', { err: err.message })
  );

  workerInstance.on('stalled', (jobId) =>
    logger.warn('[Worker] job stalled détecté', { jobId })
  );

  logger.info('[Worker] webhookProcessor démarré', {
    queue: QUEUE_NAMES.WEBHOOK,
    concurrency,
  });

  return workerInstance;
}

/**
 * Arrête le Worker proprement (draine les jobs en cours).
 * @param {{ force?: boolean }} [opts]
 */
async function stopWebhookWorker(opts = {}) {
  if (!workerInstance) return;

  logger.info('[Worker] arrêt gracieux en cours…');
  await workerInstance.close(opts.force ?? false);
  workerInstance = null;
  logger.info('[Worker] arrêt terminé');
}

module.exports = {
  startWebhookWorker,
  stopWebhookWorker,
};