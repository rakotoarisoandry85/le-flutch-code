// workers/pipedriveWebhookWorker.js
const { Worker } = require("bullmq");
const { logger } = require("../lib/logger");
const { queue, redisConnection } = require("../lib/queue");

// Exemple de ton module pipedrive (à adapter avec ton fichier)
const { syncWebhookToDb } = require("../pipedrive/webhookSync");

const worker = new Worker(
  "pipedrive-webhook",
  async (job) => {
    const { eventType, meta, payload, timestamp } = job.data;

    logger.info(
      `Processing pipedrive webhook (event=${eventType}, meta=${meta})`
    );

    try {
      // 1. Ici, ton logique actuelle de webhookSync.js
      await syncWebhookToDb(eventType, payload);

      logger.info(
        `✅ Webhook ${eventType} (meta=${meta}) synced to DB`
      );
    } catch (error) {
      logger.error(
        `❌ Failed to sync webhook ${eventType} (meta=${meta}):`,
        error
      );
      // Bull re‑essaie automatiquement jusqu’à attempts
      throw error;
    }
  },
  { connection: redisConnection }
);

worker.on("completed", (job) => {
  logger.info(`Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  logger.error(`Job ${job.id} failed:`, err);
});