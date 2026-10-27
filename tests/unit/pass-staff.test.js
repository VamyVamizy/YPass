import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';

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
      originLocationId: mainOffice.id,
      destinationLocationId: counseling.id,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      notes: 'Testing appointment',
    });
    expect(appointment.appointment.status).toBe('scheduled');

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

    await ctx.container.db
      .knex('passes')
      .where({ id: requested.pass.id })
      .update({ timeout_at: new Date(Date.now() - 60 * 1000) });
    const timedOut = await ctx.container.passService.managerDashboard({ status: 'timedout' });
    expect(timedOut.passes).toHaveLength(1);
    expect(timedOut.passes[0].id).toBe(requested.pass.id);
    expect(timedOut.passes[0].display_status).toBe('timedout');
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

    const location = await ctx.container.passService.createManagerLocation({
      name: 'New Location',
      type: 'one_way',
      teacherUserId: teacherId,
      active: true,
    });
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
      teacherUserId: '',
      active: false,
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
      active: 0,
    });
    await expect(
      ctx.container.db.knex('kiosks').where({ id: kiosk.id }).first(),
    ).resolves.toMatchObject({
      kiosk_code: 'updated-kiosk',
      active: 0,
    });
  });

  it('replaces the staff role instead of accumulating lower roles', async () => {
    ctx = await createTestApp();
    const userId = randomUUID();
    await ctx.container.db.knex('users').insert({
      id: userId,
      display_name: 'Role Test User',
      primary_email: `${userId}@example.test`,
      status: 'active',
    });

    await ctx.container.userService.setStaffRole({ userId, roleName: 'teacher' });
    await ctx.container.userService.setStaffRole({ userId, roleName: 'manager' });

    const roles = await ctx.container.rbac.getRoles(userId);
    expect(roles).toContain('manager');
    expect(roles).not.toContain('teacher');
    expect(roles).not.toContain('student');
  });
});
