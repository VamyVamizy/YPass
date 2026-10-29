import { randomUUID } from 'node:crypto';

const ROLES = [
  { name: 'admin', description: 'Application administrator' },
  { name: 'user', description: 'Standard authenticated user' },
  { name: 'student', description: 'Standard student account' },
  { name: 'teacher', description: 'Teacher account' },
  { name: 'manager', description: 'Manager account' },
];

const PERMISSIONS = [
  { name: 'account.self', description: 'Manage own account' },
  { name: 'users.read', description: 'Read user directory' },
  { name: 'users.manage', description: 'Manage users and roles' },
  { name: 'admin.health', description: 'View detailed health information' },
];

const ADMIN_PERMS = ['account.self', 'users.read', 'users.manage', 'admin.health'];
const USER_PERMS = ['account.self'];
const STAFF_PERMS = ['account.self'];
const MANAGER_PERMS = ['account.self', 'users.read', 'users.manage'];

/**
 * @param {import('knex').Knex} knex
 */
export async function seed(knex) {
  const existingRoles = await knex('roles').select('id', 'name');
  const existingPermissions = await knex('permissions').select('id', 'name');
  const roleByName = Object.fromEntries(existingRoles.map((row) => [row.name, row.id]));
  const permByName = Object.fromEntries(existingPermissions.map((row) => [row.name, row.id]));
  const missingRoles = ROLES.filter(({ name }) => !roleByName[name]).map((role) => ({
    id: randomUUID(),
    ...role,
  }));
  const missingPermissions = PERMISSIONS.filter(({ name }) => !permByName[name]).map(
    (permission) => ({ id: randomUUID(), ...permission }),
  );
  if (missingRoles.length) await knex('roles').insert(missingRoles);
  if (missingPermissions.length) await knex('permissions').insert(missingPermissions);
  for (const role of missingRoles) roleByName[role.name] = role.id;
  for (const permission of missingPermissions) permByName[permission.name] = permission.id;

  const rolePermissions = [
    ...ADMIN_PERMS.map((name) => ({
      role_id: roleByName.admin,
      permission_id: permByName[name],
    })),
    ...USER_PERMS.map((name) => ({
      role_id: roleByName.user,
      permission_id: permByName[name],
    })),
    ...STAFF_PERMS.map((name) => ({
      role_id: roleByName.student,
      permission_id: permByName[name],
    })),
    ...STAFF_PERMS.map((name) => ({
      role_id: roleByName.teacher,
      permission_id: permByName[name],
    })),
    ...MANAGER_PERMS.map((name) => ({
      role_id: roleByName.manager,
      permission_id: permByName[name],
    })),
  ];

  await knex('role_permissions').insert(rolePermissions).onConflict(['role_id', 'permission_id']).ignore();
}
