import { randomUUID } from 'node:crypto';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '#errors';
import { sha256 } from '#utils/crypto.js';

function formatActiveDuration(pass, now, endedAt = null) {
  if (endedAt || !['active', 'arrived', 'returning'].includes(pass.status)) return null;
  const activeSince = pass.departed_at || pass.approved_at;
  const startedAt = new Date(activeSince);
  if (!activeSince || Number.isNaN(startedAt.getTime())) return null;

  const end = endedAt ? new Date(endedAt) : now;
  if (Number.isNaN(end.getTime())) return null;
  const totalSeconds = Math.max(0, Math.floor((end.getTime() - startedAt.getTime()) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const label = endedAt ? 'Was active for' : 'Active for';
  return `${label} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatFinishedAt(timestamp) {
  if (!timestamp) return null;
  const finishedAt = new Date(timestamp);
  if (Number.isNaN(finishedAt.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(finishedAt);
}

function formatAppointmentAt(timestamp) {
  const scheduledAt = new Date(timestamp);
  if (Number.isNaN(scheduledAt.getTime())) return timestamp;
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(scheduledAt);
}

function decorateActivePass(pass, now, forcedEndedAt = null) {
  const activeSince = pass.departed_at || pass.approved_at;
  const recordedEndedAt = forcedEndedAt || pass.ended_at || null;
  const timeoutAt = pass.timeout_at ? new Date(pass.timeout_at) : null;
  const recordedEnd = recordedEndedAt ? new Date(recordedEndedAt) : null;
  const endedAt =
    timeoutAt && recordedEnd && timeoutAt < recordedEnd ? pass.timeout_at : recordedEndedAt;
  const activeLive = !endedAt && ['active', 'arrived', 'returning'].includes(pass.status);
  const activeDuration = activeLive ? formatActiveDuration(pass, now) : null;
  return {
    ...pass,
    active_duration: activeDuration,
    active_duration_label: 'Active for',
    active_live: activeLive,
    active_since: activeSince ? new Date(activeSince).toISOString() : null,
    finished_at: activeSince && endedAt ? new Date(endedAt).toISOString() : null,
    finished_at_display: activeSince && endedAt ? formatFinishedAt(endedAt) : null,
  };
}

export function createPassService({
  db,
  passes,
  clock,
  onPassRequested = () => {},
  onPassStarted = () => {},
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

  async function listUpcomingAppointments(studentNumber, now = clock.now()) {
    const student = await passes.findStudentByNumber(studentNumber);
    if (!student) {
      return [];
    }
    await passes.expireAppointmentNoShows(now);
    return passes.listUpcomingAppointmentsForStudent(student.id, now, 12);
  }

  async function scanStudent({ kioskCode, studentNumber, studentName, actorUserId }) {
    const now = clock.now();
    const result = await db.transaction(async (trx) => {
      await passes.expireAppointmentNoShows(now, trx);
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
      const upcomingAppointments = await passes.listUpcomingAppointmentsForStudent(
        student.id,
        now,
        12,
        trx,
      );
      if (!currentPass) {
        return {
          action: 'create',
          kiosk,
          destinations,
          student,
          appointmentPrompt: upcomingAppointments.length > 0,
          appointments: upcomingAppointments,
        };
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
    if (
      result.action === 'completed' &&
      (result.pass.journey_type === 'round_trip' || result.kiosk.location_type === 'bathroom')
    ) {
      onPassEnded({
        teacherUserId: result.pass.origin_teacher_id,
        passId: result.pass.id,
        originLocationId: result.pass.origin_location_id,
      });
    }
    return result;
  }

  async function completeAppointmentForStudent({
    kioskCode,
    studentNumber,
    appointmentId,
    actorUserId,
  }) {
    const now = clock.now();
    const result = await db.transaction(async (trx) => {
      const { kiosk } = await kioskOptions(kioskCode, trx);
      const student = await passes.findStudentByNumber(studentNumber, trx);
      if (!student) {
        throw new ValidationError('Student ID was not found');
      }
      const appointment = await passes.findUpcomingAppointmentForStudent(
        student.id,
        appointmentId,
        now,
        12,
        trx,
      );
      if (!appointment) {
        throw new NotFoundError('No matching appointment is available for this student in the next 12 hours');
      }
      const currentPass = await passes.findCurrentPassForStudent(student.id, trx);
      if (currentPass) {
        throw new ConflictError('This student already has an active or pending pass');
      }
      const destination = await passes.findLocationPair(
        appointment.origin_location_id,
        appointment.destination_location_id,
        trx,
      );
      const pass = {
        id: randomUUID(),
        student_id: student.id,
        origin_location_id: appointment.origin_location_id,
        origin_kiosk_id: kiosk.id,
        destination_location_id: appointment.destination_location_id,
        destination_teacher_id: appointment.destination_teacher_id || null,
        journey_type: destination.destination?.type === 'round_trip' ? 'round_trip' : 'one_way',
        status: 'active',
        appointment_id: appointment.id,
        created_by: actorUserId || null,
        requested_at: now,
        approved_by: actorUserId || null,
        approved_at: now,
        departed_at: now,
        timeout_at: new Date(now.getTime() + 30 * 60 * 1000),
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
          metadata_json: JSON.stringify({ student_number: student.student_number, appointment_id: appointment.id }),
        },
        trx,
      );
      await passes.addEvent(
        {
          id: randomUUID(),
          pass_id: pass.id,
          event_type: 'approved',
          kiosk_id: kiosk.id,
          location_id: kiosk.location_id,
          actor_user_id: actorUserId || null,
          occurred_at: now,
          metadata_json: JSON.stringify({ appointment_id: appointment.id, automatic: true }),
        },
        trx,
      );
      await passes.completeAppointment(appointment.id, now, trx);
      return {
        pass,
        student,
        kiosk,
        origin: destination.origin,
        appointment: { ...appointment, status: 'completed', used_at: now },
        destination: destination.destination,
      };
    });
    if (result.origin.teacher_user_id) {
      onPassStarted({
        teacherUserId: result.origin.teacher_user_id,
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
      await ensureBathroomCapacity(kiosk.location_id, destination, trx);

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
        journey_type:
          destination.type === 'round_trip' || destination.type === 'bathroom'
            ? 'round_trip'
            : 'one_way',
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
    if (result.autoApproved && result.kiosk.location_teacher_id) {
      onPassStarted({
        teacherUserId: result.kiosk.location_teacher_id,
        passId: result.pass.id,
        originLocationId: result.pass.origin_location_id,
      });
    }
    return result;
  }

  async function teacherDashboard(userId) {
    const now = clock.now();
    await passesRepository.expireAppointmentNoShows(now);
    const [locations, passes, appointments] = await Promise.all([
      passesRepository.listTeacherLocations(userId),
      passesRepository.listTeacherPasses(userId),
      passesRepository.listAppointmentsForTeacher(userId),
    ]);
    return {
      locations,
      passes: passes.map((pass) => decorateActivePass(pass, now)),
      appointments: appointments.map((appointment) => ({
        ...appointment,
        scheduled_at_display: formatAppointmentAt(appointment.scheduled_at),
      })),
    };
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
      if (action === 'approve' && pass.status === 'completed') return pass;
      if (action === 'cancel' && pass.status === 'cancelled') return pass;
      if (action === 'approve' && pass.status !== 'pending_approval')
        throw new ConflictError('Only pending passes can be approved');
      if (action === 'cancel' && ['completed', 'cancelled', 'expired'].includes(pass.status))
        throw new ConflictError('This pass is already closed');
      if (action === 'approve') {
        const destination = await passesRepository.findLocationById(pass.destination_location_id, trx);
        await ensureBathroomCapacity(pass.origin_location_id, destination, trx, pass.id);
      }
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

  async function findAppointmentStudent(studentNumber) {
    const student = await passesRepository.findStudentByNumber(studentNumber);
    return student ? { studentNumber: student.student_number, studentName: student.display_name } : null;
  }

  async function findAppointmentStudents(studentName) {
    const students = await passesRepository.findStudentsByName(studentName);
    return students.map((student) => ({
      studentNumber: student.student_number,
      studentName: student.display_name,
    }));
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
    if (when <= clock.now()) throw new ValidationError('Appointment time must be in the future');
    return db.transaction(async (trx) => {
      const student = await passesRepository.findStudentByNumber(studentNumber, trx);
      if (!student) throw new ValidationError('Student ID was not found');
      if (student.display_name.trim().toLowerCase() !== studentName.trim().toLowerCase())
        throw new ValidationError('Student name does not match that student ID');
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
    await passesRepository.expireAppointmentNoShows(now);
    const [passRows, appointmentRows, students, locations, kiosks, users] = await Promise.all([
      passesRepository.listManagerPasses({ ...filters, now }),
      passesRepository.listManagerAppointments(filters),
      passesRepository.listManagerStudents(),
      passesRepository.listManagerLocations(),
      passesRepository.listManagerKiosks(),
      passesRepository.listManagerUsers(),
    ]);

    let filteredUsers = users
    if (filters.role){
      filteredUsers = users.filter((user) => user.roles.includes(filters.role))
    }

    const bathrooms = locations.filter(
    (location) => location.type === 'bathroom'
    );
    const bathroomsById = new Map(
    bathrooms.map((bathroom) => [bathroom.id, bathroom])
    );
    const locationsWithBathrooms = locations.map((location) => ({
      ...location,
      bathroom_name: bathroomsById.get(location.bathroom)?.name || null,
    }));

    const passesWithTimeoutStatus = passRows.map((pass) => {
      const timedOut = isTimedOut(pass, now);
      return {
        ...decorateActivePass(
          {
            ...pass,
            status: timedOut ? 'timedout' : pass.status,
          },
          now,
          timedOut ? pass.timeout_at : null,
        ),
        display_status: timedOut ? 'timedout' : pass.status,
      };
    });
    const timedOutPasses = passRows
      .filter((pass) => isTimedOut(pass, now))
      .map((pass) => ({
        ...decorateActivePass(
          {
            ...pass,
            status: 'timedout',
          },
          now,
          pass.timeout_at,
        ),
        display_status: 'timedout',
      }));
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
      appointments: appointmentRows.map((appointment) => ({
        ...appointment,
        scheduled_at_display: formatAppointmentAt(appointment.scheduled_at),
      })),
      filters,
      students,
      locations: locationsWithBathrooms,
      bathrooms,
      kiosks: kiosksWithStatus,
      users,
      locationAssignees: users.filter((user) =>
        user.roles.some((role) => role === 'teacher' || role === 'manager'),
      ),
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
  async function deleteManagerStudent({ id, studentNumber}) {
    const student = await passesRepository.findStudentById(id);
    if (!student) throw new NotFoundError('Student not found');
    const existing = await passesRepository.findStudentByNumber(studentNumber);
    if (existing && existing.id !== id)
      throw new ConflictError('A student with that ID already exists');
    await passesRepository.deleteStudent(id);
  }

  async function createManagerLocation({
    name,
    type,
    bathroom,
    teacherUserId,
    defaultLocation,
    active,
  }) {
    if (await passesRepository.findLocationByName(name))
      throw new ConflictError('A location with that name already exists');
    await validateLocationAssignee(teacherUserId);
    return passesRepository.createLocation({
      id: randomUUID(),
      name,
      type,
      bathroom: bathroom || null,
      teacher_user_id: teacherUserId || null,
      default_location: defaultLocation,
      active,
    });
  }

  async function updateManagerLocation({
    id,
    name,
    type,
    bathroom,
    teacherUserId,
    defaultLocation,
    active,
  }) {
    if (!(await passesRepository.findLocationById(id)))
      throw new NotFoundError('Location not found');
    const existing = await passesRepository.findLocationByName(name);
    if (existing && existing.id !== id)
      throw new ConflictError('A location with that name already exists');
    await validateLocationAssignee(teacherUserId);
    await passesRepository.updateLocation(id, {
      name,
      type,
      bathroom: bathroom || null,
      teacher_user_id: teacherUserId || null,
      default_location: defaultLocation,
      active,
    });
  }

  async function deleteManagerLocation({ id }) {
    await db.transaction(async (trx) => {
      if (!(await passesRepository.findLocationById(id, trx)))
        throw new NotFoundError('Location not found');
      await passesRepository.unassignLocationReferences(id, clock.now(), trx);
      await passesRepository.deleteLocation(id, trx);
    });
  }

  async function validateLocationAssignee(userId) {
    if (!userId) return;
    const user = await passesRepository.findManagerUserById(userId);
    if (!user || !user.roles.some((role) => role === 'teacher' || role === 'manager'))
      throw new ValidationError('Choose an active teacher or manager');
  }

  async function ensureBathroomCapacity(originLocationId, destination, trx, excludePassId = null) {
    if (!destination || !isBathroom(destination)) return;
    const bathroomCount = await passesRepository.countCurrentPasses(
      { destinationLocationId: destination.id, excludePassId },
      trx,
    );
    if (bathroomCount >= 6) {
      throw new ConflictError('This bathroom is currently at capacity');
    }
    const classroomCount = await passesRepository.countCurrentPasses(
      { destinationLocationId: destination.id, originLocationId, excludePassId },
      trx,
    );
    if (classroomCount >= 2) {
      throw new ConflictError('This classroom already has two students out at this bathroom');
    }
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
    if (!locationId && active) throw new ValidationError('Choose a location for an active kiosk');
    if (locationId && !(await passesRepository.findLocationById(locationId)))
      throw new ValidationError('Choose a valid location');
    const existing = await passesRepository.findKioskByKioskCode(kioskCode);
    if (existing && existing.id !== id)
      throw new ConflictError('A kiosk with that code already exists');
    await passesRepository.updateKiosk(id, {
      name,
      kiosk_code: kioskCode,
      location_id: locationId || null,
      ...(kioskSecret ? { secret_hash: sha256(kioskSecret) } : {}),
      active,
    });
  }

  async function deleteManagerKiosk({ id }) {
    await db.transaction(async (trx) => {
      if (!(await passesRepository.findKioskById(id, trx)))
        throw new NotFoundError('Kiosk not found');
      await passesRepository.unassignKioskReferences(id, clock.now(), trx);
      await passesRepository.deleteKiosk(id, trx);
    });
  }

  const passesRepository = passes;
  return {
    kioskOptions,
    kioskPendingPass,
    scanStudent,
    listUpcomingAppointments,
    completeAppointmentForStudent,
    requestPass,
    teacherDashboard,
    approvePass,
    cancelPass,
    appointmentOptions,
    findAppointmentStudent,
    findAppointmentStudents,
    createAppointment,
    managerDashboard,
    createManagerStudent,
    updateManagerStudent,
    deleteManagerStudent,
    createManagerLocation,
    updateManagerLocation,
    deleteManagerLocation,
    createManagerKiosk,
    updateManagerKiosk,
    deleteManagerKiosk,
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
