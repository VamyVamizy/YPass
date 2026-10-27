import { randomUUID } from 'node:crypto';
import { AuthenticationError, ConflictError, ValidationError } from '#errors';
import { hashPassword, verifyPassword } from '#auth/password.js';
import { hashIp } from '#utils/net.js';

const GENERIC_LOGIN = 'Invalid username or password';
const GENERIC_RESET = 'If that email is registered, a reset message has been sent.';
const LOCKOUT_AFTER = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Local username/password authentication. Optional via LOCAL_AUTH_ENABLED.
 */
export function createLocalAuthService({
  config,
  db,
  users,
  identities,
  credentials,
  rbacRepository,
  tokens,
  email,
  audit,
  clock,
}) {
  async function writeAudit(eventType, actorUserId, reqLike, metadata) {
    await audit.write({
      id: randomUUID(),
      actor_user_id: actorUserId || null,
      event_type: eventType,
      ip_hash: hashIp(reqLike?.ip),
      request_id: reqLike?.requestId || null,
      metadata_json: metadata ? JSON.stringify(metadata) : null,
    });
  }

  return {
    async register({ username, email, password, displayName }, reqLike = {}) {
      const existingUser = await credentials.findByUsername(username);
      if (existingUser) {
        throw new ConflictError('Unable to create that account');
      }

      const passwordHash = await hashPassword(password, config.env);
      const userId = randomUUID();
      const identityId = randomUUID();
      const userRole = await rbacRepository.findRoleByName('student');

      await db.transaction(async (trx) => {
        await users.create(
          {
            id: userId,
            display_name: displayName,
            primary_email: email.toLowerCase(),
            email_verified_at:
              config.features.localAuthEmailFlow === 'required' ? null : clock.now(),
            status: 'active',
          },
          trx,
        );
        await identities.create(
          {
            id: identityId,
            user_id: userId,
            provider: 'local',
            subject: username.toLowerCase(),
            email_at_provider: email.toLowerCase(),
            profile_json: null,
          },
          trx,
        );
        await credentials.create(
          {
            user_id: userId,
            username: username.toLowerCase(),
            password_hash: passwordHash,
            failed_attempts: 0,
            locked_until: null,
          },
          trx,
        );
        if (userRole) {
          await rbacRepository.assignRole(userId, userRole.id, trx);
        }
      });

      if (config.features.localAuthEmailFlow === 'required' && email) {
        const token = await tokens.issue({ userId, purpose: 'verify-email' });
        await sendEmailSafe(email, 'verify', { token, config });
      }

      await writeAudit('account.create', userId, reqLike, { provider: 'local' });
      return { id: userId, displayName, email };
    },

    async login({ username, password }, reqLike = {}) {
      const creds = await credentials.findByUsername(username);
      if (!creds) {
        await writeAudit('login.failure', null, reqLike, { reason: 'unknown_user' });
        throw new AuthenticationError(GENERIC_LOGIN);
      }

      if (creds.locked_until && new Date(creds.locked_until).getTime() > clock.nowMs()) {
        await writeAudit('login.failure', creds.user_id, reqLike, { reason: 'locked' });
        throw new AuthenticationError(GENERIC_LOGIN);
      }

      const ok = await verifyPassword(creds.password_hash, password);
      if (!ok) {
        const failed = (creds.failed_attempts || 0) + 1;
        const patch = { failed_attempts: failed };
        if (failed >= LOCKOUT_AFTER) {
          patch.locked_until = new Date(clock.nowMs() + LOCKOUT_MS);
        }
        await credentials.update(creds.user_id, patch);
        await writeAudit('login.failure', creds.user_id, reqLike, { reason: 'bad_password' });
        throw new AuthenticationError(GENERIC_LOGIN);
      }

      const user = await users.findById(creds.user_id);
      if (!user || user.status !== 'active') {
        throw new AuthenticationError(GENERIC_LOGIN);
      }

      if (config.features.localAuthEmailFlow === 'required' && !user.email_verified_at) {
        await writeAudit('login.failure', user.id, reqLike, { reason: 'unverified' });
        throw new AuthenticationError('Verify your email before signing in');
      }

      await credentials.update(creds.user_id, { failed_attempts: 0, locked_until: null });
      await writeAudit('login.success', user.id, reqLike, { provider: 'local' });
      return user;
    },

    async requestPasswordReset(email, reqLike = {}) {
      const user = await users.findByEmail(email);
      if (user) {
        const token = await tokens.issue({ userId: user.id, purpose: 'reset-password' });
        await sendEmailSafe(user.primary_email, 'reset', { token, config });
        await writeAudit('password.reset.request', user.id, reqLike, {});
      } else {
        await writeAudit('password.reset.request', null, reqLike, { reason: 'unknown_email' });
      }
      return GENERIC_RESET;
    },

    async resetPassword(token, newPassword, reqLike = {}) {
      const challenge = await tokens.consume(token, 'reset-password');
      if (!challenge) {
        throw new ValidationError('That reset link is invalid or has expired');
      }
      const passwordHash = await hashPassword(newPassword, config.env);
      await credentials.update(challenge.user_id, {
        password_hash: passwordHash,
        password_changed_at: clock.now(),
        failed_attempts: 0,
        locked_until: null,
      });
      await writeAudit('password.reset', challenge.user_id, reqLike, {});
    },

    async verifyEmail(token, reqLike = {}) {
      const challenge = await tokens.consume(token, 'verify-email');
      if (!challenge) {
        throw new ValidationError('That verification link is invalid or has expired');
      }
      await users.update(challenge.user_id, { email_verified_at: clock.now() });
      await writeAudit('email.verified', challenge.user_id, reqLike, {});
    },

    async changePassword(userId, currentPassword, newPassword, reqLike = {}) {
      const creds = await credentials.findByUserId(userId);
      if (!creds) {
        throw new ValidationError('Local password is not set on this account');
      }
      const ok = await verifyPassword(creds.password_hash, currentPassword);
      if (!ok) {
        throw new AuthenticationError('Current password is incorrect');
      }
      await credentials.update(userId, {
        password_hash: await hashPassword(newPassword, config.env),
        password_changed_at: clock.now(),
      });
      await writeAudit('password.change', userId, reqLike, {});
    },

    async reauthenticate(userId, password) {
      const creds = await credentials.findByUserId(userId);
      if (!creds) {
        throw new AuthenticationError('Reauthentication required');
      }
      const ok = await verifyPassword(creds.password_hash, password);
      if (!ok) {
        throw new AuthenticationError('Reauthentication required');
      }
      return true;
    },
  };

  async function sendEmailSafe(to, template, context) {
    if (!email) {
      return;
    }
    try {
      await email.sendTemplate(template, { to, ...context });
    } catch {
      throw new ValidationError('The email could not be sent. Try again later.');
    }
  }
}
