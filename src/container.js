/**
 * Explicit composition root. Disabled features are not constructed.
 */

import { createAuditLogger } from '#logging/logger.js';
import { createDatabase } from '#database';
import { createRedis } from '#integrations/redis.js';
import { createEmailProvider } from '#integrations/email/provider.js';
import {
  createUserRepository,
  createIdentityRepository,
  createLocalCredentialRepository,
  createChallengeRepository,
  createTokenRepository,
  createRbacRepository,
  createAuditRepository,
  createPassRepository,
} from '#repositories/index.js';
import { createRbac } from '#authorization/rbac.js';
import { createTokenService } from '#auth/tokens.js';
import { systemClock } from '#utils/clock.js';
import { createUserService } from '#services/user-service.js';
import { createLocalAuthService } from '#services/local-auth-service.js';
import {
  createFormbarOAuth,
  createFormbarHttpClient,
  createFormbarWsManager,
  createFormbarWsExample,
} from '#integrations/formbar/index.js';
import { createFormbarHttpExample } from '#integrations/formbar/examples/http-example.js';
import { createEntraProvider } from '#integrations/entra/index.js';
import { createPassService } from '#services/pass-service.js';
import { createKioskService } from '#services/kiosk-service.js';

export async function createContainer({ config, logger }) {
  const auditLogger = createAuditLogger(logger);
  const clock = systemClock();
  const db = await createDatabase(config, logger);

  let redis = null;
  if (config.features.redis) {
    redis = await createRedis(config, logger);
  }

  const users = createUserRepository(db);
  const identities = createIdentityRepository(db);
  const credentials = createLocalCredentialRepository(db);
  const challenges = createChallengeRepository(db);
  const providerTokens = createTokenRepository(db);
  const rbacRepository = createRbacRepository(db);
  const auditRepo = createAuditRepository(db);
  const passRepository = createPassRepository(db);
  const rbac = createRbac({ rbacRepository });
  const tokens = createTokenService(challenges, clock);

  const email = config.features.email ? createEmailProvider(config, logger) : null;

  const userService = createUserService({
    db,
    users,
    identities,
    credentials,
    rbacRepository,
    rbac,
    tokens,
    audit: auditRepo,
    managerEmails: config.managers,
  });

  const localAuth = config.features.localAuth
    ? createLocalAuthService({
        config,
        db,
        users,
        identities,
        credentials,
        rbacRepository,
        tokens,
        email,
        audit: auditRepo,
        clock,
      })
    : null;

  let realtime = null;
  const passService = createPassService({
    db,
    passes: passRepository,
    clock,
    onPassRequested({ teacherUserId, passId, originLocationId }) {
      realtime?.to(`teacher:${teacherUserId}`).emit('teacher-pass-requested', {
        passId,
        originLocationId,
      });
    },
    onPassEnded({ teacherUserId, passId, originLocationId }) {
      realtime?.to(`teacher:${teacherUserId}`).emit('teacher-pass-ended', {
        passId,
        originLocationId,
      });
    },
  });
  const kioskService = createKioskService({
    db,
    kiosks: passRepository,
    clock,
    audit: auditRepo,
  });

  const formbarOAuth = config.features.formbarAuth ? createFormbarOAuth({ config, logger }) : null;
  const formbarHttp = config.formbar.baseUrl ? createFormbarHttpClient({ config, logger }) : null;
  const formbarHttpExample =
    config.features.formbarHttpExample && formbarHttp
      ? createFormbarHttpExample({ httpClient: formbarHttp, logger })
      : null;

  let formbarWs = null;
  let formbarWsExampleUnsubscribe = null;
  if (config.features.formbarWsClient) {
    formbarWs = createFormbarWsManager({ config, logger });
    if (config.features.formbarWsExample) {
      formbarWsExampleUnsubscribe = createFormbarWsExample(formbarWs, logger);
    }
  }

  const entraProvider = config.features.entraAuth ? createEntraProvider({ config, logger }) : null;

  return {
    config,
    logger,
    auditLogger,
    clock,
    db,
    redis,
    email,
    users,
    identities,
    credentials,
    challenges,
    providerTokens,
    rbacRepository,
    rbac,
    tokens,
    userService,
    localAuth,
    passRepository,
    passService,
    kioskService,
    formbarOAuth,
    formbarHttp,
    formbarHttpExample,
    formbarWs,
    formbarWsExampleUnsubscribe,
    entraProvider,
    setRealtime(io) {
      realtime = io;
    },
    io: null,
    jobs: null,
    ready: { value: false },
  };
}
