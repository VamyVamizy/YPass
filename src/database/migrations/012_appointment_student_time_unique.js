/**
 * Prevent duplicate appointment times for the same student.
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('appointments', (table) => {
    table.unique(['student_id', 'scheduled_at']);
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('appointments', (table) => {
    table.dropUnique(['student_id', 'scheduled_at']);
  });
}
