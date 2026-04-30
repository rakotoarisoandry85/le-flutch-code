'use strict';

/**
 * lib/queue.js
 * Configuration centrale BullMQ pour le traitement asynchrone des webhooks.
 */

const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const { logger } = require('./logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

/**
 * Retourne la config Redis sous forme d'objet — compatibilité avec les
 * modules qui appellent getRedisConfig() pour instancier leur propre connexion.
 */
function getRedisConfig() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    db:   Number(process.env.REDIS_DB)   || 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...(process.env.REDIS_URL ? { url: process.env.REDIS_URL } : {}),
  };
}

function createRedisConnection(opts = {}) {
  const conn = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
    ...opts,
  });
  conn.on('error',   (err) => logger.error('[Redis] connexion erreur', { err: err.message }));
  conn.on('connect', ()    => logger.info('[Redis] connecté'));
  conn.on('close',   ()    => logger.warn('[Redis] connexion fermée'));
  return conn;
}

const queueConnection  = createRedisConnection({ maxRetriesPerRequest: 3 });
const eventsConnection = createRedisConnection({ maxRetriesPerRequest: 3 });

const QUEUE_NAMES = Object.freeze({ WEBHOOK: 'webhook-events' });

const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 60 * 60 * 24, count: 500 },
  removeOnFail:     { age: 60 * 60 * 24 * 7 },
};

const webhookQueue = new Queue(QUEUE_NAMES.WEBHOOK, {
  connection: queueConnection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});
webhookQueue.on('error', (err) =>
  logger.error('[Queue] erreur interne BullMQ', { queue: QUEUE_NAMES.WEBHOOK, err: err.message })
);

let webhookQueueEvents = null;
function getQueueEvents() {
  if (!webhookQueueEvents) {
    webhookQueueEvents = new QueueEvents(QUEUE_NAMES.WEBHOOK, { connection: eventsConnection });
    webhookQueueEvents.on('completed', ({ jobId })              => logger.debug('[QueueEvents] job complété',        { jobId }));
    webhookQueueEvents.on('failed',    ({ jobId, failedReason })=> logger.error('[QueueEvents] job échoué',         { jobId, failedReason }));
    webhookQueueEvents.on('stalled',   ({ jobId })              => logger.warn('[QueueEvents] job bloqué (stalled)', { jobId }));
  }
  return webhookQueueEvents;
}

async function enqueueWebhook(eventType, payload, opts = {}) {
  let extraJobData = {};
  if (eventType && typeof eventType === 'object') {
    const eventData = eventType;
    eventType = eventData.eventType ?? eventData.event ?? 'unknown';
    payload = eventData.payload ?? eventData.body ?? eventData;
    extraJobData = {
      dealId: eventData.dealId,
      timestamp: eventData.timestamp,
      meta: eventData.meta,
    };
    opts = payload === eventData ? opts : { ...opts, ...eventData.opts };
  }
  const job = await webhookQueue.add(
    eventType ?? 'unknown',
    { eventType, payload, ...extraJobData, receivedAt: Date.now() },
    {
      ...DEFAULT_JOB_OPTIONS,
      ...opts,
      jobId: payload?.meta?.id ? `pipedrive-${payload.meta.id}` : undefined,
    }
  );
  logger.info('[Queue] webhook enqueued', { jobId: job.id, eventType, objectType: payload?.meta?.object });
  return job;
}

async function getQueueStatus() {
  return webhookQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
}

async function closeQueue() {
  logger.info('[Queue] fermeture gracieuse…');
  await webhookQueue.close();
  if (webhookQueueEvents) await webhookQueueEvents.close();
  await queueConnection.quit();
  await eventsConnection.quit();
  logger.info('[Queue] fermeture terminée');
}

// Alias pour compatibilité avec les modules qui importent { gracefulShutdown }
const gracefulShutdown = closeQueue;

module.exports = {
  QUEUE_NAMES,
  webhookQueue,
  enqueueWebhook,
  getQueueStatus,
  getQueueEvents,
  closeQueue,
  gracefulShutdown,
  createRedisConnection,
  getRedisConfig,
};
