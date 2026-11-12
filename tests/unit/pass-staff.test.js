import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : '';
}

describe('staff pass controls', () => {
  let ctx;

  afterEach(async () => {
    if (ctx) {
      await ctx.close();
      ctx = null;
    }
  });

  it('seeds five active odd locations with a kiosk for each', async () => {
    ctx = await createTestApp();
    const knex = ctx.container.db.knex;
    await knex.seed.run();

    const locations = await knex('locations')
      .whereIn('name', [
        'Lost & Found Time Portal',
        'Indoor Recess Weather Station',
        'Library Secret Book Nook',
        'Bathroom of Infinite Echoes',
        'Custodians Mop Closet Museum',
      ])
      .orderBy('name');

    expect(locations).toHaveLength(5);
    expect(locations.every((location) => location.active)).toBe(true);
    expect(Object.fromEntries(locations.map(({ name, type }) => [name, type]))).toEqual({
      'Bathroom of Infinite Echoes': 'bathroom',
      'Custodians Mop Closet Museum': 'one_way',
      'Indoor Recess Weather Station': 'one_way',
      'Library Secret Book Nook': 'round_trip',
      'Lost & Found Time Portal': 'round_trip',
    });

    const kiosks = await knex('kiosks')
      .whereIn(
        'location_id',
        locations.map(({ id }) => id),
      )
      .whereIn('kiosk_code', [
        'lost-found-time-portal',
        'indoor-weather-station',
        'library-book-nook',
        'infinite-echoes-bathroom',
        'mop-closet-museum',
      ]);
    expect(kiosks).toHaveLength(5);
    expect(new Set(kiosks.map(({ location_id }) => location_id)).size).toBe(5);
  });

  it('repairs a legacy locations table missing bathroom/default_location columns', async () => {
    const { buildKnexConfig, createSqlJsKnex } = await import('../../src/database/knex-config.js');
    const legacyDbPath = `${process.cwd()}/data/test-legacy-location-schema.sqlite`;
    const config = buildKnexConfig({ database: { provider: 'sqlite', url: legacyDbPath } }, process.env);
    const knex = await createSqlJsKnex(config);
    try {
      await knex.schema.createTable('locations', (table) => {
        table.uuid('id').primary();
        table.string('name').notNullable();
        table.string('type').notNullable();
        table.uuid('teacher_user_id').nullable();
        table.boolean('active').notNullable().defaultTo(true);
      });

      const { up } = await import('../../src/database/migrations/014_fix_missing_location_columns.js');
      await up(knex);

      await expect(knex.schema.hasColumn('locations', 'bathroom')).resolves.toBe(true);
      await expect(knex.schema.hasColumn('locations', 'default_location')).resolves.toBe(true);
    } finally {
      await knex.destroy();
      await import('node:fs/promises').then(({ rm }) => rm(legacyDbPath, { force: true }));
    }
  });

  it('offers active locations without requiring a destination kiosk', async () => {
    ctx = await createTestApp();
    const knex = ctx.container.db.knex;
    const location = {
      id: randomUUID(),
      name: 'Remote Destination',
      type: 'one_way',
      teacher_user_id: null,
      active: true,
    };
    await knex('locations').insert(location);

    const options = await ctx.container.passService.kioskOptions('main-office');

    expect(options.destinations.map(({ id }) => id)).toContain(location.id);
  });

  it('marks manager-selected default locations in kiosk options', async () => {
    ctx = await createTestApp();
    const bathroom = await ctx.container.passService.createManagerLocation({
      name: 'North Hall Bathroom',
      type: 'bathroom',
      teacherUserId: '',
      defaultLocation: false,
      active: true,
    });
    await ctx.container.db.knex('locations').where({ name: 'Main Office' }).update({
      bathroom: bathroom.id,
    });
    const location = await ctx.container.passService.createManagerLocation({
      name: 'Quick Destination',
      type: 'one_way',
      bathroom: bathroom.id,
      teacherUserId: '',
      active: true,
      defaultLocation: true,
    });

    const options = await ctx.container.passService.kioskOptions('main-office');
    expect(options.destinations.find(({ id }) => id === location.id)).toMatchObject({
      default_location: 1,
      bathroom_name: 'North Hall Bathroom',
    });
    expect(options.destinations[0]).toMatchObject({
      id: bathroom.id,
      name: 'North Hall Bathroom',
      assigned_bathroom: 1,
    });

    await ctx.container.passService.updateManagerLocation({
      id: location.id,
      name: location.name,
      type: location.type,
      teacherUserId: '',
      active: true,
      defaultLocation: false,
    });
    await expect(ctx.container.db.knex('locations').where({ id: location.id }).first()).resolves.toMatchObject({
      default_location: 0,
    });
  });

  it('notifies the origin teacher when a round-trip pass ends', async () => {
    ctx = await createTestApp();
    const knex = ctx.container.db.knex;
    const mainOffice = await knex('locations').where({ name: 'Main Office' }).first();
    const teacherId = randomUUID();
    await knex('users').insert({
      id: teacherId,
      display_name: 'Origin Teacher',
      primary_email: `${teacherId}@example.test`,
      status: 'active',
    });
    await knex('locations').where({ id: mainOffice.id }).update({ teacher_user_id: teacherId });
    mainOffice.teacher_user_id = teacherId;
    const destination = await knex('locations')
      .where({ type: 'round_trip' })
      .whereNot({ id: mainOffice.id })
      .first();
    const student = await knex('students').where({ student_number: '111111' }).first();
    const events = [];
    ctx.container.setRealtime({
      to(room) {
        return {
          emit(event, payload) {
            events.push({ room, event, payload });
          },
        };
      },
    });

    const requested = await ctx.container.passService.requestPass({
      kioskCode: 'main-office',
      studentNumber: student.student_number,
      studentName: student.display_name,
      destinationLocationId: destination.id,
    });
    await ctx.container.passService.approvePass({
      passId: requested.pass.id,
      userId: mainOffice.teacher_user_id,
    });
    const destinationKiosk = await knex('kiosks').where({ location_id: destination.id }).first();

    expect(
      (
        await ctx.container.passService.scanStudent({
          kioskCode: destinationKiosk.kiosk_code,
          studentNumber: student.student_number,
        })
      ).action,
    ).toBe('arrival');
    expect(
      (
        await ctx.container.passService.scanStudent({
          kioskCode: destinationKiosk.kiosk_code,
          studentNumber: student.student_number,
        })
      ).action,
    ).toBe('scan_out');
    const ended = await ctx.container.passService.scanStudent({
      kioskCode: 'main-office',
      studentNumber: student.student_number,
    });

    expect(ended.action).toBe('completed');
    await expect(ctx.container.passService.teacherDashboard(mainOffice.teacher_user_id)).resolves.toMatchObject({
      passes: [expect.objectContaining({ id: requested.pass.id, status: 'completed' })],
    });
    expect(events).toContainEqual({
      room: `teacher:${mainOffice.teacher_user_id}`,
      event: 'teacher-pass-ended',
      payload: { passId: requested.pass.id, originLocationId: mainOffice.id },
    });
  });

  it('notifies the origin teacher when an appointment pass starts', async () => {
    ctx = await createTestApp();
    const knex = ctx.container.db.knex;
    const mainOffice = await knex('locations').where({ name: 'Main Office' }).first();
    const counseling = await knex('locations').where({ name: 'Counseling Office' }).first();
    const teacherId = randomUUID();
    const student = await knex('students').where({ student_number: '200001' }).first();
    await knex('users').insert({
      id: teacherId,
      display_name: 'Appointment Teacher',
      primary_email: `${teacherId}@example.test`,
      status: 'active',
    });
    await knex('locations').where({ id: mainOffice.id }).update({ teacher_user_id: teacherId });
    await knex('appointments').insert({
      id: randomUUID(),
      student_id: student.id,
      origin_location_id: mainOffice.id,
      destination_location_id: counseling.id,
      destination_teacher_id: counseling.teacher_user_id || null,
      created_by: teacherId,
      scheduled_at: new Date(Date.now() - 60 * 1000),
      status: 'scheduled',
    });
    const events = [];
    ctx.container.setRealtime({
      to(room) {
        return {
          emit(event, payload) {
            events.push({ room, event, payload });
          },
        };
      },
    });

    const started = await ctx.container.passService.requestPass({
      kioskCode: 'main-office',
      studentNumber: student.student_number,
      studentName: student.display_name,
      destinationLocationId: counseling.id,
    });

    expect(started.pass.status).toBe('active');
    expect(events).toContainEqual({
      room: `teacher:${teacherId}`,
      event: 'teacher-pass-started',
      payload: { passId: started.pass.id, originLocationId: mainOffice.id },
    });
  });

  it('notifies the destination teacher when the kiosk completes an appointment', async () => {
    ctx = await createTestApp();
    const knex = ctx.container.db.knex;
    const appointmentOrigin = await knex('locations').where({ name: 'APPOINTMENT' }).first();
    const counseling = await knex('locations').where({ name: 'Counseling Office' }).first();
    const teacherId = randomUUID();
    const student = await knex('students').where({ student_number: '200001' }).first();
    await knex('users').insert({
      id: teacherId,
      display_name: 'Appointment Teacher',
      primary_email: `${teacherId}@example.test`,
      status: 'active',
    });
    await knex('locations').where({ id: counseling.id }).update({ teacher_user_id: teacherId });
    const appointmentId = randomUUID();
    await knex('appointments').insert({
      id: appointmentId,
      student_id: student.id,
      origin_location_id: appointmentOrigin.id,
      destination_location_id: counseling.id,
      destination_teacher_id: teacherId,
      created_by: teacherId,
      scheduled_at: new Date(Date.now() + 60 * 1000),
      status: 'scheduled',
    });
    const events = [];
    ctx.container.setRealtime({
      to(room) {
        return {
          emit(event, payload) {
            events.push({ room, event, payload });
          },
        };
      },
    });

    const started = await ctx.container.passService.completeAppointmentForStudent({
      kioskCode: 'main-office',
      studentNumber: student.student_number,
      appointmentId,
    });

    expect(started.pass.status).toBe('active');
    expect(started.pass.journey_type).toBe('one_way');
    expect(started.pass.origin_location_id).toBe(appointmentOrigin.id);
    const completed = await ctx.container.passService.scanStudent({
      kioskCode: 'counseling-main',
      studentNumber: student.student_number,
    });
    expect(completed.action).toBe('completed');
    expect(events).toContainEqual({
      room: `teacher:${teacherId}`,
      event: 'teacher-pass-started',
      payload: { passId: started.pass.id, originLocationId: appointmentOrigin.id },
    });
  });

  it('notifies the origin teacher when a bathroom pass ends', async () => {
    ctx = await createTestApp();
    const knex = ctx.container.db.knex;
    const mainOffice = await knex('locations').where({ name: 'Main Office' }).first();
    const teacherId = randomUUID();
    await knex('users').insert({
      id: teacherId,
      display_name: 'Origin Teacher',
      primary_email: `${teacherId}@example.test`,
      status: 'active',
    });
    await knex('locations').where({ id: mainOffice.id }).update({ teacher_user_id: teacherId });
    mainOffice.teacher_user_id = teacherId;
    const bathroom = await knex('locations').where({ type: 'bathroom' }).first();
    const bathroomKiosk = await knex('kiosks').where({ location_id: bathroom.id }).first();
    const student = await knex('students').where({ student_number: '111111' }).first();
    const events = [];
    ctx.container.setRealtime({
      to(room) {
        return {
          emit(event, payload) {
            events.push({ room, event, payload });
          },
        };
      },
    });

    const requested = await ctx.container.passService.requestPass({
      kioskCode: 'main-office',
      studentNumber: student.student_number,
      studentName: student.display_name,
      destinationLocationId: bathroom.id,
    });
    await ctx.container.passService.approvePass({
      passId: requested.pass.id,
      userId: mainOffice.teacher_user_id,
    });
    const arrived = await ctx.container.passService.scanStudent({
      kioskCode: bathroomKiosk.kiosk_code,
      studentNumber: student.student_number,
    });
    const leaving = await ctx.container.passService.scanStudent({
      kioskCode: bathroomKiosk.kiosk_code,
      studentNumber: student.student_number,
    });
    const ended = await ctx.container.passService.scanStudent({
      kioskCode: 'main-office',
      studentNumber: student.student_number,
    });

    expect(arrived.action).toBe('arrival');
    expect(leaving.action).toBe('scan_out');
    expect(ended.action).toBe('completed');
    await expect(
      ctx.container.passService.approvePass({
        passId: requested.pass.id,
        userId: mainOffice.teacher_user_id,
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(events).toContainEqual({
      room: `teacher:${mainOffice.teacher_user_id}`,
      event: 'teacher-pass-ended',
      payload: { passId: requested.pass.id, originLocationId: mainOffice.id },
    });
  });

  it('limits each bathroom to six students and each classroom to two', async () => {
    ctx = await createTestApp();
    const knex = ctx.container.db.knex;
    const bathroom = await knex('locations').where({ type: 'bathroom' }).first();
    const origins = [];
    const students = [];

    for (let index = 0; index < 4; index += 1) {
      const locationId = randomUUID();
      const kioskCode = `capacity-classroom-${index}`;
      await knex('locations').insert({
        id: locationId,
        name: `Capacity Classroom ${index}`,
        type: 'one_way',
        teacher_user_id: null,
        active: true,
      });
      await knex('kiosks').insert({
        id: randomUUID(),
        location_id: locationId,
        name: `Capacity Classroom ${index} Kiosk`,
        kiosk_code: kioskCode,
        active: true,
      });
      origins.push({ locationId, kioskCode });
    }

    for (let index = 0; index < 8; index += 1) {
      const student = {
        id: randomUUID(),
        student_number: `capacity-${index}`,
        display_name: `Capacity Student ${index}`,
        status: 'active',
      };
      await knex('students').insert(student);
      students.push(student);
    }

    const request = (studentIndex, originIndex) =>
      ctx.container.passService.requestPass({
        kioskCode: origins[originIndex].kioskCode,
        studentNumber: students[studentIndex].student_number,
        studentName: students[studentIndex].display_name,
        destinationLocationId: bathroom.id,
      });

    await request(0, 0);
    await request(1, 0);
    await expect(request(2, 0)).rejects.toMatchObject({
      status: 409,
      message: 'This classroom already has two students out at this bathroom',
    });
    await request(3, 1);
    await request(4, 1);
    await request(5, 2);
    await request(6, 2);
    await expect(request(7, 3)).rejects.toMatchObject({
      status: 409,
      message: 'This bathroom is currently at capacity',
    });
  });

  it('limits pass actions to the origin teacher and supports appointments', async () => {
    ctx = await createTestApp();
    const teacherId = randomUUID();
    const otherUserId = randomUUID();
    const users = [teacherId, otherUserId].map((id, index) => ({
      id,
      display_name: index ? 'Other Teacher' : 'Teacher One',
      primary_email: `${id}@example.test`,
      status: 'active',
    }));
    await ctx.container.db.knex('users').insert(users);
    const mainOffice = await ctx.container.db
      .knex('locations')
      .where({ name: 'Main Office' })
      .first();
    const counseling = await ctx.container.db
      .knex('locations')
      .where({ name: 'Counseling Office' })
      .first();
    await ctx.container.db.knex('locations').where({ id: mainOffice.id }).update({
      teacher_user_id: teacherId,
    });
    await ctx.container.db.knex('locations').where({ id: counseling.id }).update({
      teacher_user_id: otherUserId,
    });

    const unassignedLocation = {
      id: randomUUID(),
      name: 'Unassigned Location',
      type: 'round_trip',
      teacher_user_id: null,
      active: true,
    };
    await ctx.container.db.knex('locations').insert(unassignedLocation);
    await ctx.container.db.knex('kiosks').insert({
      id: randomUUID(),
      location_id: unassignedLocation.id,
      name: 'Unassigned Location kiosk',
      kiosk_code: 'unassigned-location',
      active: true,
    });

    const requested = await ctx.container.passService.requestPass({
      kioskCode: 'main-office',
      studentNumber: '111111',
      studentName: 'Test Student 111111',
      destinationLocationId: counseling.id,
    });
    await expect(
      ctx.container.passService.approvePass({ passId: requested.pass.id, userId: otherUserId }),
    ).rejects.toMatchObject({ status: 404 });

    const unrelatedPass = await ctx.container.passService.requestPass({
      kioskCode: 'unassigned-location',
      studentNumber: '200001',
      studentName: 'Avery Brooks',
      destinationLocationId: counseling.id,
    });
    await expect(
      ctx.container.passService.cancelPass({
        passId: unrelatedPass.pass.id,
        userId: otherUserId,
      }),
    ).rejects.toMatchObject({ status: 404 });

    const approved = await ctx.container.passService.approvePass({
      passId: requested.pass.id,
      userId: teacherId,
    });
    expect(approved.status).toBe('active');
    expect(approved.timeout_at).toBeTruthy();
    await ctx.container.db.knex('students').insert({
      id: randomUUID(),
      student_number: '300001',
      display_name: 'Never Active Student',
      status: 'active',
    });
    const neverActive = await ctx.container.passService.requestPass({
      kioskCode: 'main-office',
      studentNumber: '300001',
      studentName: 'Never Active Student',
      destinationLocationId: counseling.id,
    });
    await ctx.container.passService.cancelPass({ passId: neverActive.pass.id, userId: teacherId });
    const retriedApproval = await ctx.container.passService.approvePass({
      passId: requested.pass.id,
      userId: teacherId,
    });
    expect(retriedApproval.status).toBe('active');
    const approvalEvent = await ctx.container.db
      .knex('pass_events')
      .where({ pass_id: requested.pass.id, event_type: 'approved' })
      .first();
    expect(approvalEvent.location_id).toBe(mainOffice.id);

    const appointment = await ctx.container.passService.createAppointment({
      userId: teacherId,
      studentNumber: '111111',
      studentName: 'Test Student 111111',
      destinationLocationId: mainOffice.id,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      notes: 'Testing appointment',
    });
    expect(appointment.appointment.status).toBe('scheduled');
    const appointmentOrigin = await ctx.container.db.knex('locations')
      .where({ name: 'APPOINTMENT' })
      .first();
    expect(appointment.appointment.origin_location_id).toBe(appointmentOrigin.id);
    const appointmentOptions = await ctx.container.passService.appointmentOptions(teacherId);
    expect(appointmentOptions.locations.map(({ id }) => id)).toEqual([mainOffice.id]);
    await expect(
      ctx.container.passService.createAppointment({
        userId: teacherId,
        studentNumber: '111111',
        studentName: 'Test Student 111111',
        destinationLocationId: counseling.id,
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(ctx.container.passService.findAppointmentStudent('111111')).resolves.toEqual({
      studentNumber: '111111',
      studentName: 'Test Student 111111',
    });
    await ctx.container.db.knex('students').insert({
      id: randomUUID(),
      student_number: '111112',
      display_name: 'Test Student 111111',
      status: 'active',
    });
    await expect(
      ctx.container.passService.findAppointmentStudents('Test Student 111111'),
    ).resolves.toEqual([
      { studentNumber: '111111', studentName: 'Test Student 111111' },
      { studentNumber: '111112', studentName: 'Test Student 111111' },
    ]);
    await expect(ctx.container.passService.findAppointmentStudent('not-a-student')).resolves.toBeNull();
    await ctx.container.db.knex('students').where({ student_number: '111111' }).update({ status: 'inactive' });
    await expect(ctx.container.passService.findAppointmentStudent('111111')).resolves.toBeNull();
    await ctx.container.db.knex('students').where({ student_number: '111111' }).update({ status: 'active' });

    const student = await ctx.container.db
      .knex('students')
      .where({ student_number: '200001' })
      .first();
    const unrelatedAppointmentId = randomUUID();
    await ctx.container.db.knex('appointments').insert({
      id: unrelatedAppointmentId,
      student_id: student.id,
      origin_location_id: unassignedLocation.id,
      destination_location_id: counseling.id,
      destination_teacher_id: null,
      created_by: otherUserId,
      scheduled_at: new Date(Date.now() + 2 * 60 * 60 * 1000),
      status: 'scheduled',
    });

    const dashboard = await ctx.container.passService.teacherDashboard(teacherId);
    const cancelledBeforeApproval = dashboard.passes.find(({ id }) => id === neverActive.pass.id);
    expect(cancelledBeforeApproval.active_duration).toBeNull();
    expect(cancelledBeforeApproval.finished_at).toBeNull();
    expect(dashboard.locations.map(({ id }) => id)).toContain(mainOffice.id);
    expect(dashboard.locations.map(({ id }) => id)).not.toContain(counseling.id);
    expect(dashboard.passes.map(({ id }) => id)).toContain(requested.pass.id);
    expect(dashboard.passes.map(({ id }) => id)).not.toContain(unrelatedPass.pass.id);
    expect(dashboard.appointments.map(({ id }) => id)).toContain(appointment.appointment.id);
    expect(dashboard.appointments.map(({ id }) => id)).not.toContain(unrelatedAppointmentId);

    const destinationTeacherDashboard = await ctx.container.passService.teacherDashboard(otherUserId);
    expect(destinationTeacherDashboard.passes.map(({ id }) => id)).not.toContain(requested.pass.id);
    expect(destinationTeacherDashboard.passes.map(({ id }) => id)).not.toContain(unrelatedPass.pass.id);

    const manager = await ctx.container.passService.managerDashboard({ status: 'active' });
    expect(manager.passes).toHaveLength(1);
    expect(manager.passes[0].id).toBe(requested.pass.id);
    expect(manager.passes[0].active_duration).toMatch(/Active for /);

    const teacherDashboard = await ctx.container.passService.teacherDashboard(teacherId);
    expect(teacherDashboard.passes.find(({ id }) => id === requested.pass.id).active_duration).toMatch(
      /Active for /,
    );

    await ctx.container.db
      .knex('passes')
      .where({ id: requested.pass.id })
      .update({ timeout_at: new Date(Date.now() - 60 * 1000) });
    const timedOut = await ctx.container.passService.managerDashboard({ status: 'timedout' });
    expect(timedOut.passes).toHaveLength(1);
    expect(timedOut.passes[0].id).toBe(requested.pass.id);
    expect(timedOut.passes[0].display_status).toBe('timedout');
    expect(timedOut.passes[0].active_duration).toBeNull();
    expect(timedOut.passes[0].finished_at).toBe(new Date(timedOut.passes[0].timeout_at).toISOString());
    expect(timedOut.recentTimedOutPasses).toHaveLength(1);
    expect(timedOut.recentTimedOutPasses[0].id).toBe(requested.pass.id);
    expect(timedOut.recentTimedOutPasses[0].display_status).toBe('timedout');
    expect(timedOut.timedOutPasses).toHaveLength(1);
    expect(timedOut.timedOutPasses[0].id).toBe(requested.pass.id);
  });

  it('marks old appointments as no_show after 30 minutes', async () => {
    ctx = await createTestApp();
    const teacherId = randomUUID();
    const user = {
      id: teacherId,
      display_name: 'Appointment Teacher',
      primary_email: `${teacherId}@example.test`,
      status: 'active',
    };
    await ctx.container.db.knex('users').insert(user);
    const mainOffice = await ctx.container.db.knex('locations').where({ name: 'Main Office' }).first();
    await ctx.container.db.knex('locations').where({ id: mainOffice.id }).update({ teacher_user_id: teacherId });
    const student = await ctx.container.db.knex('students').where({ student_number: '111111' }).first();

    const appointment = await ctx.container.passService.createAppointment({
      userId: teacherId,
      studentNumber: student.student_number,
      studentName: student.display_name,
      destinationLocationId: mainOffice.id,
      scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      notes: 'Late appointment',
    });
    await ctx.container.db.knex('appointments').where({ id: appointment.appointment.id }).update({
      scheduled_at: new Date(Date.now() - 31 * 60 * 1000),
      updated_at: new Date(Date.now()),
    });

    const dashboard = await ctx.container.passService.teacherDashboard(teacherId);
    expect(dashboard.appointments).toContainEqual(
      expect.objectContaining({ id: appointment.appointment.id, status: 'no_show' }),
    );

    const manager = await ctx.container.passService.managerDashboard({ appointmentStatus: 'no_show' });
    expect(manager.appointments.map(({ id }) => id)).toContain(appointment.appointment.id);
    await expect(
      ctx.container.db.knex('appointments').where({ id: appointment.appointment.id }).first(),
    ).resolves.toMatchObject({ status: 'no_show' });
  });

  it('lets managers create and update students, locations, and kiosks', async () => {
    ctx = await createTestApp();
    const teacherId = randomUUID();
    await ctx.container.db.knex('users').insert({
      id: teacherId,
      display_name: 'Manager Teacher',
      primary_email: `${teacherId}@example.test`,
      status: 'active',
    });
    const teacherRole = await ctx.container.db.knex('roles').where({ name: 'teacher' }).first();
    await ctx.container.db.knex('user_roles').insert({ user_id: teacherId, role_id: teacherRole.id });
    const managerId = randomUUID();
    await ctx.container.db.knex('users').insert({
      id: managerId,
      display_name: 'Location Manager',
      primary_email: `${managerId}@example.test`,
      status: 'active',
    });
    const managerRole = await ctx.container.db.knex('roles').where({ name: 'manager' }).first();
    await ctx.container.db.knex('user_roles').insert({ user_id: managerId, role_id: managerRole.id });

    const student = await ctx.container.passService.createManagerStudent({
      studentNumber: '999999',
      studentName: 'New Student',
      status: 'active',
    });
    await expect(
      ctx.container.passService.createManagerStudent({
        studentNumber: '999999',
        studentName: 'Duplicate Student',
        status: 'active',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await ctx.container.passService.updateManagerStudent({
      id: student.id,
      studentNumber: '999999',
      studentName: 'Updated Student',
      status: 'inactive',
    });

    const bathroom = await ctx.container.passService.createManagerLocation({
      name: 'Bathroom',
      type: 'bathroom',
      active: true,
      defaultLocation: false,
    });

    const location = await ctx.container.passService.createManagerLocation({
      name: 'New Location',
      type: 'one_way',
      bathroom: bathroom.id,
      teacherUserId: teacherId,
      active: true,
      defaultLocation: true,
    });
    const managerLocation = await ctx.container.passService.createManagerLocation({
      name: 'Manager Location',
      type: 'one_way',
      teacherUserId: managerId,
      active: true,
      defaultLocation: false,
    });
    expect(managerLocation.teacher_user_id).toBe(managerId);
    const kiosk = await ctx.container.passService.createManagerKiosk({
      name: 'New Kiosk',
      kioskCode: 'new-kiosk',
      locationId: location.id,
      active: true,
    });
    await ctx.container.passService.updateManagerLocation({
      id: location.id,
      name: 'Updated Location',
      type: 'round_trip',
      bathroom: bathroom.id,
      teacherUserId: '',
      active: false,
      defaultLocation: false,
    });
    await ctx.container.passService.updateManagerKiosk({
      id: kiosk.id,
      name: 'Updated Kiosk',
      kioskCode: 'updated-kiosk',
      locationId: location.id,
      active: false,
    });

    await expect(
      ctx.container.db.knex('students').where({ id: student.id }).first(),
    ).resolves.toMatchObject({
      display_name: 'Updated Student',
      status: 'inactive',
    });
    await expect(
      ctx.container.db.knex('locations').where({ id: location.id }).first(),
    ).resolves.toMatchObject({
      name: 'Updated Location',
      bathroom: bathroom.id,
      active: 0,
      default_location: 0,
    });
    await expect(
      ctx.container.db.knex('kiosks').where({ id: kiosk.id }).first(),
    ).resolves.toMatchObject({
      kiosk_code: 'updated-kiosk',
      active: 0,
    });
  });
});
