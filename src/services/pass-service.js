import { randomUUID } from 'node:crypto';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '#errors';
import { sha256 } from '#utils/crypto.js';

export function createPassService({
  db,
  passes,
  clock,
  onPassRequested = () => {},
  onPassEnded = () => {},
}) {
  async function kioskOptions(kioskCode, trx) {
    const kiosk = await passes.findKioskByCode(kioskCode, trx);
    if (!kiosk) {
      throw new NotFoundError('Kiosk not found or inactive');
    }
    const destinations = await passes.listDestinations(kiosk.location_id, trx);
    return { kiosk, destinations };
  }

  async function kioskPendingPass({ kioskCode, studentNumber, passId }) {
    return db.transaction(async (trx) => {
      const { kiosk, destinations } = await kioskOptions(kioskCode, trx);
      const student = await passes.findStudentByNumber(studentNumber, trx);
      if (!student) return null;
      const currentPass = await passes.findCurrentPassForStudent(student.id, trx);
      if (!currentPass || (passId && currentPass.id !== passId)) return null;
      if (currentPass.status !== 'pending_approval') return null;
      const destination = destinations.find(
        (item) => item.id === currentPass.destination_location_id,
      );
      return { kiosk, destinations, student, destination, pass: currentPass };
    });
  }

  async function scanStudent({ kioskCode, studentNumber, studentName, actorUserId }) {
    const now = clock.now();
    const result = await db.transaction(async (trx) => {
      const { kiosk, destinations } = await kioskOptions(kioskCode, trx);
      const student = await passes.findStudentByNumber(studentNumber, trx);
      if (!student) {
        throw new ValidationError('Student ID was not found');
      }
      if (
        studentName &&
        student.display_name.trim().toLowerCase() !== studentName.trim().toLowerCase()
      ) {
        throw new ValidationError('Student name does not match that student ID');
      }

      const currentPass = await passes.findCurrentPassForStudent(student.id, trx);
      if (!currentPass) {
        return { action: 'create', kiosk, destinations, student };
      }
      if (currentPass.status === 'pending_approval') {
        return { action: 'pending', kiosk, destinations, student, pass: currentPass };
      }
      if (currentPass.timeout_at && new Date(currentPass.timeout_at) <= now) {
        const patch = {
          status: 'expired',
          ended_at: now,
          ended_location_id: currentPass.origin_location_id,
          updated_at: now,
        };
        await passes.updatePass(currentPass.id, patch, trx);
        await passes.addEvent(
          {
            id: randomUUID(),
            pass_id: currentPass.id,
            event_type: 'expired',
            kiosk_id: kiosk.id,
            location_id: kiosk.location_id,
            actor_user_id: actorUserId || null,
            occurred_at: now,
            metadata_json: JSON.stringify({ reason: 'timeout' }),
          },
          trx,
        );
        return {
          action: 'expired',
          kiosk,
          destinations,
          student,
          pass: { ...currentPass, ...patch },
        };
      }

      const eventType = transitionForScan(currentPass, kiosk.location_id);
      const completed = eventType === 'completed';
      const arrived = eventType === 'arrival';
      const leaving = eventType === 'scan_out';
      const patch = {
        updated_at: now,
        ...(completed
          ? {
            status: eventType === 'ended' ? 'cancelled' : 'completed',
            ended_at: now,
            ended_location_id: kiosk.location_id,
            ended_kiosk_id: kiosk.id,
            ended_teacher_id: kiosk.location_teacher_id || null,
          }
          : {}),
        ...(arrived ? { status: 'arrived', arrived_at: now } : {}),
        ...(leaving ? { status: 'returning' } : {}),
      };
      await passes.updatePass(currentPass.id, patch, trx);
      await passes.addEvent(
        {
          id: randomUUID(),
          pass_id: currentPass.id,
          event_type: eventType,
          kiosk_id: kiosk.id,
          location_id: kiosk.location_id,
          actor_user_id: actorUserId || null,
          occurred_at: now,
          metadata_json: JSON.stringify({ student_number: student.student_number }),
        },
        trx,
      );
      return {
        action: eventType,
        kiosk,
        destinations,
        student,
        pass: { ...currentPass, ...patch },
      };
    });
    if (result.action === 'completed' && result.pass.journey_type === 'round_trip') {
      onPassEnded({
        teacherUserId: result.kiosk.location_teacher_id,
        passId: result.pass.id,
        originLocationId: result.pass.origin_location_id,
      });
    }
    return result;
  }

  async function requestPass({
    kioskCode,
    studentNumber,
    studentName,
    destinationLocationId,
    actorUserId,
  }) {
    const now = clock.now();
    const result = await db.transaction(async (trx) => {
      const { kiosk, destinations } = await kioskOptions(kioskCode, trx);
      const student = await passes.findStudentByNumber(studentNumber, trx);
      if (!student) {
        throw new ValidationError('Student ID was not found');
      }
      if (student.display_name.trim().toLowerCase() !== studentName.trim().toLowerCase()) {
        throw new ValidationError('Student name does not match that student ID');
      }
      const destination = destinations.find((item) => item.id === destinationLocationId);
      if (!destination) {
        throw new ValidationError('Choose a valid destination');
      }
      if (await passes.findCurrentPassForStudent(student.id, trx)) {
        throw new ConflictError('This student already has a current pass');
      }

      const appointment = await passes.findEligibleAppointment(
        student.id,
        kiosk.location_id,
        destination.id,
        now,
        trx,
      );
      const autoApproved = Boolean(appointment);
      const pass = {
        id: randomUUID(),
        student_id: student.id,
        origin_location_id: kiosk.location_id,
        origin_kiosk_id: kiosk.id,
        destination_location_id: destination.id,
        destination_teacher_id: destination.teacher_user_id || null,
        journey_type: destination.type === 'round_trip' ? 'round_trip' : 'one_way',
        status: autoApproved ? 'active' : 'pending_approval',
        appointment_id: appointment?.id || null,
        created_by: actorUserId || null,
        requested_at: now,
        approved_by: null,
        approved_at: autoApproved ? now : null,
        departed_at: autoApproved ? now : null,
        timeout_at: autoApproved ? new Date(now.getTime() + 30 * 60 * 1000) : null,
      };
      await passes.createPass(
        pass,
        {
          id: randomUUID(),
          pass_id: pass.id,
          event_type: 'created',
          kiosk_id: kiosk.id,
          location_id: kiosk.location_id,
          actor_user_id: actorUserId || null,
          occurred_at: now,
          metadata_json: JSON.stringify({ student_number: student.student_number }),
        },
        trx,
      );
      if (appointment) {
        await passes.markAppointmentUsed(appointment.id, now, trx);
        await passes.addEvent(
          {
            id: randomUUID(),
            pass_id: pass.id,
            event_type: 'approved',
            kiosk_id: kiosk.id,
            location_id: kiosk.location_id,
            actor_user_id: null,
            occurred_at: now,
            metadata_json: JSON.stringify({ appointment_id: appointment.id, automatic: true }),
          },
          trx,
        );
      }
      return { pass, student, destination, kiosk, destinations, autoApproved };
    });
    if (result.pass.status === 'pending_approval' && result.kiosk.location_teacher_id) {
      onPassRequested({
        teacherUserId: result.kiosk.location_teacher_id,
        passId: result.pass.id,
        originLocationId: result.pass.origin_location_id,
      });
    }
    return result;
  }

  async function teacherDashboard(userId) {
    const [locations, passes, appointments] = await Promise.all([
      passesRepository.listTeacherLocations(userId),
      passesRepository.listTeacherPasses(userId),
      passesRepository.listAppointmentsForTeacher(userId),
    ]);
    return { locations, passes, appointments };
  }

  async function approvePass({ passId, userId }) {
    return changeTeacherPass({ passId, userId, action: 'approve' });
  }

  async function cancelPass({ passId, userId }) {
    return changeTeacherPass({ passId, userId, action: 'cancel' });
  }

  async function changeTeacherPass({ passId, userId, action }) {
    const now = clock.now();
    return db.transaction(async (trx) => {
      const pass = await passesRepository.findPassForTeacher(passId, userId, trx);
      if (!pass) throw new NotFoundError('Pass not found or outside your locations');
      if (action === 'approve' && pass.status === 'active') return pass;
      if (action === 'cancel' && pass.status === 'cancelled') return pass;
      if (action === 'approve' && pass.status !== 'pending_approval')
        throw new ConflictError('Only pending passes can be approved');
      if (action === 'cancel' && ['completed', 'cancelled', 'expired'].includes(pass.status))
        throw new ConflictError('This pass is already closed');
      const patch =
        action === 'approve'
          ? {
            status: 'active',
            approved_by: userId,
            approved_at: now,
            departed_at: now,
            timeout_at: new Date(now.getTime() + 30 * 60 * 1000),
            updated_at: now,
          }
          : { status: 'cancelled', ended_at: now, ended_teacher_id: userId, updated_at: now };
      await passesRepository.updatePass(passId, patch, trx);
      await passesRepository.addEvent(
        {
          id: randomUUID(),
          pass_id: passId,
          event_type: action === 'approve' ? 'approved' : 'cancelled',
          kiosk_id: null,
          location_id: pass.origin_location_id,
          actor_user_id: userId,
          occurred_at: now,
          metadata_json: null,
        },
        trx,
      );
      return { ...pass, ...patch };
    });
  }

  async function appointmentOptions(userId) {
    const locations = await passesRepository.listLocations();
    const teacherLocations = locations.filter((location) => location.teacher_user_id === userId);
    return { locations, teacherLocations };
  }

  async function createAppointment({
    userId,
    studentNumber,
    studentName,
    originLocationId,
    destinationLocationId,
    scheduledAt,
    notes,
  }) {
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) throw new ValidationError('Choose a valid appointment time');
    return db.transaction(async (trx) => {
      const student = await passesRepository.findStudentByNumber(studentNumber, trx);
      if (!student) throw new ValidationError('Student ID was not found');
      if (student.display_name.trim().toLowerCase() !== studentName.trim().toLowerCase())
        throw new ValidationError('Student name does not match that student ID');
      if (when <= clock.now()) throw new ValidationError('Appointment time must be in the future');
      const existingAppointment = await passesRepository.findAppointmentForStudentAtTime(
        student.id,
        when,
        trx,
      );
      if (existingAppointment) {
        throw new ConflictError('This student already has an appointment at that time');
      }
      const { origin, destination } = await passesRepository.findLocationPair(
        originLocationId,
        destinationLocationId,
        trx,
      );
      if (!origin || !destination || origin.id === destination.id)
        throw new ValidationError('Choose two different locations');
      if (isBathroom(origin) || isBathroom(destination))
        throw new ValidationError('Bathrooms cannot be used for appointments');
      if (origin.teacher_user_id !== userId && destination.teacher_user_id !== userId)
        throw new AuthorizationError('One appointment location must be yours');
      const appointment = {
        id: randomUUID(),
        student_id: student.id,
        origin_location_id: origin.id,
        destination_location_id: destination.id,
        destination_teacher_id: destination.teacher_user_id || null,
        created_by: userId,
        scheduled_at: when,
        status: 'scheduled',
        notes: notes?.trim() || null,
      };
      await passesRepository.createAppointment(appointment, trx);
      return { appointment, student, origin, destination };
    });
  }

  async function managerDashboard(filters = {}) {
    const now = clock.now();
    const [passRows, timedOutRows, appointmentRows, students, locations, kiosks, users] = await Promise.all([
      passesRepository.listManagerPasses({ ...filters, now }),
      passesRepository.listManagerPasses({ status: 'timedout', now }),
      passesRepository.listManagerAppointments(filters),
      passesRepository.listManagerStudents(),
      passesRepository.listManagerLocations(),
      passesRepository.listManagerKiosks(),
      passesRepository.listManagerUsers(),
    ]);
    const withTimeoutStatus = (pass) => ({
      ...pass,
      display_status: isTimedOut(pass, now) ? 'timedout' : pass.status,
    });
    const passesWithTimeoutStatus = passRows.map(withTimeoutStatus);
    const timedOutPasses = timedOutRows.map(withTimeoutStatus);
    const kiosksWithStatus = kiosks.map((kiosk) => ({
      ...kiosk,
      display_status:
        kiosk.active &&
          kiosk.last_seen_at &&
          now.getTime() - new Date(kiosk.last_seen_at).getTime() < 60 * 1000
          ? 'online'
          : 'offline',
    }));
    return {
      passes: passesWithTimeoutStatus,
      recentTimedOutPasses: timedOutPasses.slice(0, 5),
      timedOutPasses,
      appointments: appointmentRows,
      filters,
      students,
      locations,
      kiosks: kiosksWithStatus,
      users,
    };
  }

  async function createManagerStudent({ studentNumber, studentName, status }) {
    if (await passesRepository.findStudentByNumber(studentNumber))
      throw new ConflictError('A student with that ID already exists');
    return passesRepository.createStudent({
      id: randomUUID(),
      student_number: studentNumber,
      display_name: studentName,
      status,
    });
  }

  async function updateManagerStudent({ id, studentNumber, studentName, status }) {
    const student = await passesRepository.findStudentById(id);
    if (!student) throw new NotFoundError('Student not found');
    const existing = await passesRepository.findStudentByNumber(studentNumber);
    if (existing && existing.id !== id)
      throw new ConflictError('A student with that ID already exists');
    await passesRepository.updateStudent(id, {
      student_number: studentNumber,
      display_name: studentName,
      status,
    });
  }

  async function createManagerLocation({ name, type, teacherUserId, active }) {
    if (await passesRepository.findLocationByName(name))
      throw new ConflictError('A location with that name already exists');
    return passesRepository.createLocation({
      id: randomUUID(),
      name,
      type,
      teacher_user_id: teacherUserId || null,
      active,
    });
  }

  async function updateManagerLocation({ id, name, type, teacherUserId, active }) {
    if (!(await passesRepository.findLocationById(id)))
      throw new NotFoundError('Location not found');
    const existing = await passesRepository.findLocationByName(name);
    if (existing && existing.id !== id)
      throw new ConflictError('A location with that name already exists');
    await passesRepository.updateLocation(id, {
      name,
      type,
      teacher_user_id: teacherUserId || null,
      active,
    });
  }

  async function createManagerKiosk({ name, kioskCode, kioskSecret, locationId, active }) {
    if (!(await passesRepository.findLocationById(locationId)))
      throw new ValidationError('Choose a valid location');
    if (await passesRepository.findKioskByKioskCode(kioskCode))
      throw new ConflictError('A kiosk with that code already exists');
    return passesRepository.createKiosk({
      id: randomUUID(),
      name,
      kiosk_code: kioskCode,
      location_id: locationId,
      secret_hash: kioskSecret ? sha256(kioskSecret) : null,
      active,
    });
  }

  async function updateManagerKiosk({ name, kioskCode, kioskSecret, locationId, active, id }) {
    if (!(await passesRepository.findKioskById(id))) throw new NotFoundError('Kiosk not found');
    if (!(await passesRepository.findLocationById(locationId)))
      throw new ValidationError('Choose a valid location');
    const existing = await passesRepository.findKioskByKioskCode(kioskCode);
    if (existing && existing.id !== id)
      throw new ConflictError('A kiosk with that code already exists');
    await passesRepository.updateKiosk(id, {
      name,
      kiosk_code: kioskCode,
      location_id: locationId,
      ...(kioskSecret ? { secret_hash: sha256(kioskSecret) } : {}),
      active,
    });
  }

  async function endExpiredPasses() {
  return db.transaction(async (trx) => {
    const allPasses = await passes.listPasses(trx);
    const now = clock.now();
    const expiredPasses = [];

    for (const pass of allPasses) {
      if (
        ['active', 'arrived', 'returning'].includes(pass.status) &&
        pass.timeout_at &&
        new Date(pass.timeout_at) <= now
      ) {
        expiredPasses.push(pass);
      }
    }

    for (const pass of expiredPasses) {
      const patch = {
        status: 'expired',
        ended_at: now,
        updated_at: now,
      };

      await passes.updatePass(pass.id, patch, trx);
      await passes.addEvent(
        {
          id: randomUUID(),
          pass_id: pass.id,
          event_type: 'expired',
          actor_user_id: null,
          occurred_at: now,
          metadata_json: JSON.stringify({ reason: 'timeout' }),
        },
        trx,
      );
    }

    return {
      expiredCount: expiredPasses.length,
      passes: expiredPasses.map((pass) => ({ ...pass, status: 'expired', ended_at: now })),
    };
  });
}

  const passesRepository = passes;
  return {
    kioskOptions,
    kioskPendingPass,
    scanStudent,
    requestPass,
    teacherDashboard,
    approvePass,
    cancelPass,
    appointmentOptions,
    createAppointment,
    managerDashboard,
    createManagerStudent,
    updateManagerStudent,
    createManagerLocation,
    updateManagerLocation,
    createManagerKiosk,
    updateManagerKiosk,
    endExpiredPasses,
  };
}

function isBathroom(location) {
  return location.type === 'bathroom' || /bathroom|restroom|toilet/i.test(location.name);
}

function isTimedOut(pass, now) {
  return (
    ['active', 'arrived', 'returning'].includes(pass.status) &&
    pass.timeout_at &&
    new Date(pass.timeout_at) <= now
  );
}

function transitionForScan(pass, kioskLocationId) {
  if (pass.journey_type !== 'round_trip') {
    return kioskLocationId === pass.destination_location_id ? 'completed' : 'ended';
  }
  if (pass.status === 'active' && kioskLocationId === pass.destination_location_id) {
    return 'arrival';
  }
  if (pass.status === 'arrived' && kioskLocationId === pass.destination_location_id) {
    return 'scan_out';
  }
  if (pass.status === 'returning' && kioskLocationId === pass.origin_location_id) {
    return 'completed';
  }
  if (pass.status === 'active' && kioskLocationId === pass.origin_location_id) {
    return 'completed';
  }
  return 'ended';
}

