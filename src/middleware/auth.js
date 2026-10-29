import { AuthenticationError, AuthorizationError } from '#errors';

export function requireKioskSession(container) {
  return async (req, _res, next) => {
    try {
      const kioskId = req.session?.kioskId;
      if (!kioskId) throw new AuthenticationError('Kiosk session required');
      const kiosk = await container.passRepository.findActiveKioskById(kioskId);
      if (!kiosk) throw new AuthenticationError('Kiosk is disabled or unavailable');
      req.kiosk = kiosk;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Require an authenticated session.
 */
export function requireAuthentication() {
  return (req, res, next) => {
    if (!req.session?.userId) {
      if (wantsJson(req)) {
        next(new AuthenticationError());
        return;
      }
      const nextUrl = encodeURIComponent(req.originalUrl || '/');
      res.redirect(`/auth/login?next=${nextUrl}`);
      return;
    }
    next();
  };
}

/**
 * @param {string} roleName
 */
export function requireRole(roleName) {
  return (req, res, next) => {
    if (!req.session?.userId) {
      next(new AuthenticationError());
      return;
    }
    const roles = req.currentUser?.roles || [];
    if (!roles.includes(roleName)) {
      next(new AuthorizationError());
      return;
    }
    next();
  };
}

/**
 * Require the requested staff level or a higher level.
 * Managers can use teacher workflows; students cannot use staff workflows.
 * @param {'teacher'|'manager'} minimumRole
 */
export function requireStaffRole(minimumRole) {
  return (req, _res, next) => {
    if (!req.session?.userId) {
      next(new AuthenticationError());
      return;
    }
    const roles = req.currentUser?.roles || [];
    const allowed =
      minimumRole === 'teacher' ? ['admin', 'teacher', 'manager'] : ['admin', 'manager'];
    if (!allowed.some((role) => roles.includes(role))) {
      next(new AuthorizationError());
      return;
    }
    next();
  };
}

/**
 * @param {string} permissionName
 */
export function requirePermission(permissionName) {
  return (req, res, next) => {
    if (!req.session?.userId) {
      next(new AuthenticationError());
      return;
    }
    const permissions = req.currentUser?.permissions || [];
    if (!permissions.includes(permissionName)) {
      next(new AuthorizationError());
      return;
    }
    next();
  };
}

/**
 * Restrict a route to the email addresses configured in MANAGERS.
 * An empty allowlist denies access to everyone.
 * @param {string[]} managerEmails
 */
export function requireManager(managerEmails) {
  return (req, res, next) => {
    if (!req.session?.userId) {
      next(new AuthenticationError());
      return;
    }
    const email = req.currentUser?.primary_email?.trim().toLowerCase();
    if (
      !email ||
      (!req.currentUser?.roles?.includes('admin') &&
        !req.currentUser?.roles?.includes('manager') &&
        !managerEmails.includes(email))
    ) {
      next(new AuthorizationError());
      return;
    }
    next();
  };
}

function wantsJson(req) {
  const path = req.originalUrl || req.path || '';
  return (
    path.startsWith('/api/') || req.xhr || /\bapplication\/json\b/i.test(req.get('accept') || '')
  );
}
