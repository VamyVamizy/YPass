import { randomUUID } from 'node:crypto';

/**
 * Add a non-selectable location used as the origin for scheduled appointments.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  const existing = await knex('locations').where({ name: 'APPOINTMENT' }).first();
  if (existing) {
    await knex('locations').where({ id: existing.id }).update({
      type: 'one_way',
      teacher_user_id: null,
      active: false,
      updated_at: knex.fn.now(),
    });
    return;
  }

  await knex('locations').insert({
    id: randomUUID(),
    name: 'APPOINTMENT',
    type: 'one_way',
    teacher_user_id: null,
    active: false,
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  const location = await knex('locations').where({ name: 'APPOINTMENT' }).first();
  if (!location) return;

  const [appointmentCount] = await knex('appointments')
    .where({ origin_location_id: location.id })
    .count({ count: '*' });
  const [passCount] = await knex('passes')
    .where({ origin_location_id: location.id })
    .count({ count: '*' });
  if (Number(appointmentCount.count) || Number(passCount.count)) {
    throw new Error('Cannot remove APPOINTMENT while appointments or passes reference it');
  }

  await knex('locations').where({ id: location.id }).delete();
}
