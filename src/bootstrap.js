/**
 * HTTP listen, optional Socket.IO, Formbar WS, jobs, and graceful shutdown.
 */

import http from 'node:http';
import { createHttpTerminator } from 'http-terminator';
import { createContainer } from './container.js';
import { createApp } from './app.js';
import { createRealtime } from '#realtime/index.js';
import { createJobs } from '#jobs/index.js';
import { startPassExpiry } from './pulse/passExpiry.js';

export async function startServer({ config, logger }) {
  const container = await createContainer({ config, logger });

  if (config.database.migrateOnStart) {
    logger.warn('running migrations on start is intended for development only');
    await container.db.knex.migrate.latest();
    await container.db.knex.seed.run();
  }

  const dbHealth = await container.db.health();
  if (!dbHealth.ok) {
    logger.fatal('database is required and is not reachable');
    throw new Error('Database unavailable');
  }

  if (config.features.redis) {
    const redisHealth = await container.redis.health();
    if (!redisHealth.ok) {
      logger.fatal('redis is required by configuration and is not reachable');
      throw new Error('Redis unavailable');
    }
  }

  const { app, sessionMiddleware } = createApp(container);
  const server = http.createServer(app);
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;

  const io = await createRealtime(server, {
    config,
    logger,
    redis: container.redis,
    sessionMiddleware,
  });
  container.io = io;
  container.setRealtime(io);

  container.jobs = await createJobs(config, logger, {
    challengeRepository: container.challenges,
    clock: container.clock,
  });

  if (container.formbarWs) {
    container.formbarWs.start();
  }

  const terminator = createHttpTerminator({ server });

  await new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  container.ready.value = true;
  logger.info({ host: config.host, port: config.port }, 'listening');

  if (typeof process.send === 'function') {
    process.send('ready');
  }

  async function shutdown(signal) {
    if (!container.ready.value && signal !== 'startup-failure') {
      return;
    }
    logger.info({ signal }, 'shutting down');
    container.ready.value = false;
    try {
      await terminator.terminate();
    } catch (error) {
      logger.warn({ err: error }, 'http terminate');
    }
    if (io) {
      io.close();
      if (io._redisSub) {
        await io._redisSub.quit();
      }
    }
    if (container.formbarWs) {
      await container.formbarWs.stop();
    }
    if (container.jobs) {
      await container.jobs.close();
    }
    await container.db.destroy();
    if (container.redis) {
      await container.redis.quit();
    }
    process.exit(0);
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
    process.on(signal, () => {
      shutdown(signal).catch((error) => {
        logger.fatal({ err: error }, 'shutdown failed');
        process.exit(1);
      });
    });
  }


  const passExpiry = startPassExpiry({
    passService: container.passService
  })
  passExpiry.start()

  return { server, container, shutdown };
}
