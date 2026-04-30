'use strict';

const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { logger } = require('../lib/logger');
const { pool } = require('../db');
const { QUEUE_NAMES, getRedisConfig } = require('../lib/queue');
const { syncWebhookToDb } = require('../pipedrive/webhookSync');

/**
 * Worker autonome qui consomme les webhooks Pipedrive depuis la queue
 * - Transactions PostgreSQL pour garantir l'atomicité
 * - Retry automatique en cas d'erreur
 * - Logging détaillé
 */
class WebhookWorker {
  constructor() {
    this.redisConnection = new Redis(getRedisConfig());
    this.worker = null;
  }

  /**
   * Initialiser et démarrer le worker
   */
  async start(concurrency = 5) {
    logger.info(`🚀 Démarrage webhook worker (concurrency: ${concurrency})`);

    this.worker = new Worker(QUEUE_NAMES.WEBHOOK, this.jobHandler.bind(this), {
      connection: this.redisConnection,
      concurrency,
      settings: {
        lockDuration: 30000, // Lock 30s pour éviter processus concurrents sur même job
        lockRenewTime: 15000,
      },
    });

    this.worker.on('completed', (job) => {
      logger.info(`✅ Job #${job.id} completed (${job.data.eventType})`);
    });

    this.worker.on('failed', (job, err) => {
      logger.error(`❌ Job #${job.id} failed: ${err.message} (attempt ${job.attemptsMade}/3)`);
    });

    this.worker.on('error', (err) => {
      logger.error('❌ Worker error:', err);
    });

    logger.info('✅ Webhook worker started');
  }

  /**
   * Traiter un job webhook
   * @param {Job} job - BullMQ job
   */
  async jobHandler(job) {
    const { eventType, dealId, payload, timestamp } = job.data;
    
    logger.info(`📨 Processing webhook: ${eventType} deal #${dealId}`);

    // Client PostgreSQL pour la transaction
    const client = await pool.connect();

    try {
      // 1. Vérifier idempotence : ce webhook a-t-il déjà été traité ?
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      const { rows: existing } = await client.query(
        `SELECT id FROM webhook_events 
         WHERE event_type = $1 AND deal_id = $2 AND event_timestamp = $3`,
        [eventType, dealId, timestamp]
      );

      if (existing.length > 0) {
        logger.info(`📨 Webhook ${eventType} deal #${dealId} already processed (idempotent)`);
        await client.query('COMMIT');
        return { status: 'deduplicated' };
      }

      // 2. Enregistrer l'événement (avant traitement)
      await client.query(
        `INSERT INTO webhook_events (event_type, deal_id, event_timestamp, payload, processed_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [eventType, dealId, timestamp, JSON.stringify(payload)]
      );

      // 3. Synchroniser vers la DB
      await syncWebhookToDb(eventType, payload, client);

      // 4. Commit la transaction
      await client.query('COMMIT');
      logger.info(`✅ Webhook ${eventType} deal #${dealId} synced`);
      return { status: 'success', dealId };

    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('❌ Rollback error:', rollbackErr);
      }

      logger.error(`❌ Error processing webhook: ${error.message}`);
      // Re-throw pour que BullMQ fasse un retry
      throw error;

    } finally {
      client.release();
    }
  }

  /**
   * Arrêter le worker proprement
   */
  async stop() {
    logger.info('🛑 Stopping webhook worker...');
    if (this.worker) {
      await this.worker.close();
    }
    await this.redisConnection.quit();
    logger.info('✅ Worker stopped');
  }
}

/**
 * Exporter singleton + fonction de démarrage
 */
let instance = null;

async function startWebhookWorker(concurrency = 5) {
  if (instance) {
    logger.warn('⚠️ Webhook worker already running');
    return instance;
  }
  instance = new WebhookWorker();
  await instance.start(concurrency);
  return instance;
}

async function stopWebhookWorker() {
  if (instance) {
    await instance.stop();
    instance = null;
  }
}

module.exports = {
  WebhookWorker,
  startWebhookWorker,
  stopWebhookWorker,
};
