import { randomUUID } from 'node:crypto';

const STAFF_ROLES = [
  ['student', 'Standard student account'],
  ['teacher', 'Teacher account'],
  ['manager', 'Manager account'],
];

export async function up(knex) {
  const existingRoles = await knex('roles').select('name');
  const existingNames = new Set(existingRoles.map(({ name }) => name));
  const newRoles = STAFF_ROLES.filter(([name]) => !existingNames.has(name)).map(([name, description]) => ({
    id: randomUUID(),
    name,
    description,
  }));
  if (newRoles.length) await knex('roles').insert(newRoles);

  const accountSelf = await knex('permissions').where({ name: 'account.self' }).first();
  const staffRoles = await knex('roles').whereIn('name', STAFF_ROLES.map(([name]) => name));
  if (accountSelf) {
    await knex('role_permissions')
      .insert(staffRoles.map((role) => ({ role_id: role.id, permission_id: accountSelf.id })))
      .onConflict(['role_id', 'permission_id'])
      .ignore();
  }
  const manager = staffRoles.find(({ name }) => name === 'manager');
  const managerPermissions = await knex('permissions').whereIn('name', ['users.read', 'users.manage']);
  if (manager && managerPermissions.length) {
    await knex('role_permissions')
      .insert(managerPermissions.map((permission) => ({ role_id: manager.id, permission_id: permission.id })))
      .onConflict(['role_id', 'permission_id'])
      .ignore();
  }
  const users = await knex('users').select('id');
  const student = staffRoles.find(({ name }) => name === 'student');
  if (student && users.length) {
    const assigned = await knex('user_roles')
      .join('roles', 'user_roles.role_id', 'roles.id')
      .whereIn('roles.name', STAFF_ROLES.map(([name]) => name))
      .select('user_roles.user_id');
    const assignedIds = new Set(assigned.map(({ user_id }) => user_id));
    const rows = users
      .filter(({ id }) => !assignedIds.has(id))
      .map(({ id }) => ({ user_id: id, role_id: student.id }));
    if (rows.length) await knex('user_roles').insert(rows).onConflict(['user_id', 'role_id']).ignore();
  }
}

export async function down(knex) {
  const names = STAFF_ROLES.map(([name]) => name);
  const roles = await knex('roles').whereIn('name', names).select('id');
  if (roles.length) {
    const roleIds = roles.map(({ id }) => id);
    await knex('user_roles').whereIn('role_id', roleIds).delete();
    await knex('role_permissions').whereIn('role_id', roleIds).delete();
  }
  await knex('roles').whereIn('name', names).delete();
}