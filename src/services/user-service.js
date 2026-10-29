import { randomUUID } from 'node:crypto';
import { ConflictError, ValidationError } from '#errors';
import { hashIp } from '#utils/net.js';

/**
 * Canonical users plus multi-provider identities.
 * Never link two identities solely because emails match.
 */
export function createUserService({
  db,
  users,
  identities,
  credentials,
  rbacRepository,
  rbac,
  tokens,
  audit,
  managerEmails = [],
}) {
  const normalizedManagerEmails = new Set(
    (managerEmails || []).map((email) => String(email).trim().toLowerCase()).filter(Boolean),
  );

  async function withAuthz(user) {
    if (!user) {
      return null;
    }
    const [roles, permissions] = await Promise.all([
      rbac.getRoles(user.id),
      rbac.getPermissions(user.id),
    ]);
    const email = user.primary_email?.trim().toLowerCase();
    const effectiveRoles = new Set(roles);
    if (email && normalizedManagerEmails.has(email)) {
      effectiveRoles.add('admin');
    }
    return { ...user, roles: [...effectiveRoles], permissions };
  }

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
    findByIdWithAuthz(id) {
      return users.findById(id).then(withAuthz);
    },

    async loginWithExternalIdentity(
      { provider, subject, email, displayName, profile },
      reqLike = {},
    ) {
      const existing = await identities.findByProviderSubject(provider, subject);
      if (existing) {
        let user = await users.findById(existing.user_id);
        if (!user) {
          const userRole = await rbacRepository.findRoleByName('student');
          user = await db.transaction(async (trx) => {
            const repaired = {
              id: existing.user_id,
              display_name: displayName || `${provider} user`,
              primary_email: email || existing.email_at_provider || null,
              email_verified_at: email || existing.email_at_provider ? new Date() : null,
              status: 'active',
            };
            await users.create(repaired, trx);
            if (userRole) {
              await rbacRepository.assignRole(existing.user_id, userRole.id, trx);
            }
            return (await users.findById(existing.user_id, trx)) || repaired;
          });
          await writeAudit('account.create', user.id, reqLike, { provider, repaired: true });
        }
        await writeAudit('login.success', user.id, reqLike, { provider });
        return user;
      }

      const userId = randomUUID();
      const userRole = await rbacRepository.findRoleByName('student');
      const created = {
        id: userId,
        display_name: displayName || `${provider} user`,
        primary_email: email || null,
        email_verified_at: email ? new Date() : null,
        status: 'active',
      };
      const user = await db.transaction(async (trx) => {
        await users.create(created, trx);
        await identities.create(
          {
            id: randomUUID(),
            user_id: userId,
            provider,
            subject: String(subject),
            email_at_provider: email || null,
            profile_json: profile ? JSON.stringify(profile) : null,
          },
          trx,
        );
        if (userRole) {
          await rbacRepository.assignRole(userId, userRole.id, trx);
        }
        return (await users.findById(userId, trx)) || created;
      });
      await writeAudit('account.create', userId, reqLike, { provider });
      await writeAudit('login.success', userId, reqLike, { provider });
      return user;
    },

    async beginLink(userId, provider) {
      return tokens.issue({
        userId,
        purpose: `link:${provider}`,
        ttlMs: 10 * 60 * 1000,
      });
    },

    async completeLink({ userId, provider, subject, email, profile, linkNonce }, reqLike = {}) {
      const consumed = await tokens.consume(linkNonce, `link:${provider}`);
      if (!consumed || consumed.user_id !== userId) {
        throw new ValidationError('Linking request is invalid or has expired');
      }

      const duplicate = await identities.findByProviderSubject(provider, subject);
      if (duplicate && duplicate.user_id !== userId) {
        throw new ConflictError('That identity is already linked to another account');
      }
      if (duplicate && duplicate.user_id === userId) {
        return;
      }

      await identities.create({
        id: randomUUID(),
        user_id: userId,
        provider,
        subject: String(subject),
        email_at_provider: email || null,
        profile_json: profile ? JSON.stringify(profile) : null,
      });
      await writeAudit('identity.link', userId, reqLike, { provider });
    },

    async unlink({ userId, identityId, hasReauthenticated }, reqLike = {}) {
      if (!hasReauthenticated) {
        throw new ValidationError('Reauthentication is required to unlink a sign-in method');
      }
      const list = await identities.listByUser(userId);
      const target = list.find((item) => item.id === identityId);
      if (!target) {
        throw new ValidationError('Identity not found');
      }
      if (list.length <= 1) {
        throw new ValidationError('You cannot unlink your last sign-in method');
      }
      const localCreds = await credentials.findByUserId(userId);
      const remaining = list.filter((item) => item.id !== identityId);
      const stillHasLocal = remaining.some((item) => item.provider === 'local') && localCreds;
      const stillHasExternal = remaining.some((item) => item.provider !== 'local');
      if (!stillHasLocal && !stillHasExternal) {
        throw new ValidationError('You cannot unlink your last sign-in method');
      }
      await identities.deleteById(identityId);
      if (target.provider === 'local') {
        await credentials.deleteByUserId(userId);
      }
      await writeAudit('identity.unlink', userId, reqLike, { provider: target.provider });
    },

    listIdentities(userId) {
      return identities.listByUser(userId);
    },

    async setStaffRole({ userId, roleName }, reqLike = {}) {
      const allowedRoles = ['student', 'teacher', 'manager'];
      if (!allowedRoles.includes(roleName)) {
        throw new ValidationError('Choose a valid staff role');
      }
      const target = await users.findById(userId);
      if (!target) {
        throw new ValidationError('User not found');
      }
      const role = await rbacRepository.findRoleByName(roleName);
      if (!role) {
        throw new ValidationError('Role is not configured');
      }
      await db.transaction(async (trx) => {
        await rbacRepository.removeRoles(userId, allowedRoles, trx);
        await rbacRepository.assignRole(userId, role.id, trx);
      });
      await writeAudit('user.role.update', reqLike.userId, reqLike, { userId, role: roleName });
    },
  };
}
