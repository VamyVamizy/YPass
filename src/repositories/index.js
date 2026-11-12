/**
 * User persistence. Keep SQL inside this module.
 */
import { randomUUID } from 'node:crypto';

export function createUserRepository(db) {
  const knex = db.knex;

  return {
    async create(user, trx = knex) {
      await trx('users').insert(user);
      return user;
    },
    async findById(id, trx = knex) {
      return trx('users').where({ id }).first();
    },
    async findByEmail(email, trx = knex) {
      if (!email) {
        return null;
      }
      return trx('users').whereRaw('lower(primary_email) = ?', [email.toLowerCase()]).first();
    },
    async update(id, patch, trx = knex) {
      await trx('users')
        .where({ id })
        .update({ ...patch, updated_at: trx.fn.now() });
    },
  };
}

export function createIdentityRepository(db) {
  const knex = db.knex;
  return {
    async create(identity, trx = knex) {
      await trx('auth_identities').insert(identity);
      return identity;
    },
    async findByProviderSubject(provider, subject, trx = knex) {
      return trx('auth_identities').where({ provider, subject }).first();
    },
    async listByUser(userId, trx = knex) {
      return trx('auth_identities').where({ user_id: userId }).orderBy('created_at');
    },
    async deleteById(id, trx = knex) {
      await trx('auth_identities').where({ id }).delete();
    },
  };
}

export function createLocalCredentialRepository(db) {
  const knex = db.knex;
  return {
    async create(row, trx = knex) {
      await trx('local_credentials').insert(row);
    },
    async findByUsername(username, trx = knex) {
      return trx('local_credentials')
        .whereRaw('lower(username) = ?', [username.toLowerCase()])
        .first();
    },
    async findByUserId(userId, trx = knex) {
      return trx('local_credentials').where({ user_id: userId }).first();
    },
    async update(userId, patch, trx = knex) {
      await trx('local_credentials').where({ user_id: userId }).update(patch);
    },
    async deleteByUserId(userId, trx = knex) {
      await trx('local_credentials').where({ user_id: userId }).delete();
    },
  };
}

export function createChallengeRepository(db) {
  const knex = db.knex;
  return {
    async create(row, trx = knex) {
      await trx('auth_challenges').insert(row);
    },
    async findByHash(tokenHash, trx = knex) {
      return trx('auth_challenges').where({ token_hash: tokenHash }).first();
    },
    async markUsed(id, trx = knex) {
      await trx('auth_challenges').where({ id }).update({ used_at: trx.fn.now() });
    },
    async deleteExpired(now, trx = knex) {
      return trx('auth_challenges').where('expires_at', '<', now).delete();
    },
  };
}

export function createTokenRepository(db) {
  const knex = db.knex;
  return {
    async upsert(row, trx = knex) {
      const existing = await trx('provider_tokens').where({ identity_id: row.identity_id }).first();
      if (existing) {
        await trx('provider_tokens').where({ identity_id: row.identity_id }).update(row);
        return;
      }
      await trx('provider_tokens').insert(row);
    },
    async findByIdentity(identityId, trx = knex) {
      return trx('provider_tokens').where({ identity_id: identityId }).first();
    },
    async deleteByIdentity(identityId, trx = knex) {
      await trx('provider_tokens').where({ identity_id: identityId }).delete();
    },
  };
}

export function createRbacRepository(db) {
  const knex = db.knex;
  return {
    async findRoleByName(name, trx = knex) {
      return trx('roles').where({ name }).first();
    },
    async assignRole(userId, roleId, trx = knex) {
      await trx('user_roles')
        .insert({ user_id: userId, role_id: roleId })
        .onConflict(['user_id', 'role_id'])
        .ignore();
    },
    async replaceRoles(userId, roleId, trx = knex) {
      await trx('user_roles').where({ user_id: userId }).delete();
      await this.assignRole(userId, roleId, trx);
    },
    async listRolesForUser(userId, trx = knex) {
      return trx('roles')
        .join('user_roles', 'roles.id', 'user_roles.role_id')
        .where('user_roles.user_id', userId)
        .select('roles.*');
    },
    async listPermissionsForUser(userId, trx = knex) {
      return trx('permissions')
        .join('role_permissions', 'permissions.id', 'role_permissions.permission_id')
        .join('user_roles', 'role_permissions.role_id', 'user_roles.role_id')
        .where('user_roles.user_id', userId)
        .distinct('permissions.name');
    },
  };
}

export function createAuditRepository(db) {
  const knex = db.knex;
  return {
    async write(row) {
      await knex('audit_events').insert(row);
    },
  };
}

export function createPassRepository(db) {
  const knex = db.knex;

  return {
    async findKioskByCode(kioskCode, trx = knex) {
      return trx('kiosks')
        .join('locations', 'kiosks.location_id', 'locations.id')
        .where({ kiosk_code: kioskCode, 'kiosks.active': true, 'locations.active': true })
        .select(
          'kiosks.*',
          'locations.name as location_name',
          'locations.type as location_type',
          'locations.teacher_user_id as location_teacher_id',
        )
        .first();
    },
    async findAuthenticatedKiosk(kioskCode, secretHash, trx = knex) {
      return trx('kiosks')
        .join('locations', 'kiosks.location_id', 'locations.id')
        .where({
          kiosk_code: kioskCode,
          secret_hash: secretHash,
          'kiosks.active': true,
          'locations.active': true,
        })
        .select(
          'kiosks.*',
          'locations.name as location_name',
          'locations.type as location_type',
          'locations.teacher_user_id as location_teacher_id',
        )
        .first();
    },
    async touchKiosk(id, patch, trx = knex) {
      await trx('kiosks').where({ id }).update(patch);
    },
    async createEnrollmentCode(row, trx = knex) {
      await trx('kiosk_enrollment_codes').insert(row);
      return row;
    },
    async findEnrollmentCode(codeHash, trx = knex) {
      return trx('kiosk_enrollment_codes').where({ code_hash: codeHash }).first();
    },
    async claimEnrollmentCode(id, now, trx = knex) {
      return trx('kiosk_enrollment_codes')
        .where({ id })
        .whereNull('used_at')
        .where('expires_at', '>', now)
        .update({ used_at: now });
    },
    async nextKioskCode(trx = knex) {
      const rows = await trx('kiosks').select('kiosk_code');
      const current = rows.reduce((highest, row) => {
        const match = /^KIOSK-(\d+)$/i.exec(String(row.kiosk_code || ''));
        return match ? Math.max(highest, Number(match[1])) : highest;
      }, 0);
      return `KIOSK-${String(current + 1).padStart(3, '0')}`;
    },
    async listEnrollmentCodes(trx = knex) {
      return trx('kiosk_enrollment_codes').orderBy('created_at', 'desc');
    },
    async findEnrollmentCodeById(id, trx = knex) {
      return trx('kiosk_enrollment_codes').where({ id }).first();
    },
    async listDestinations(originLocationId, trx = knex) {
      return trx('locations')
        .leftJoin('users', 'locations.teacher_user_id', 'users.id')
        .leftJoin('locations as bathroom', 'locations.bathroom', 'bathroom.id')
        .where('locations.active', true)
        .where((query) =>
          query
            .whereNot('locations.id', originLocationId)
            .orWhereIn(
              'locations.id',
              trx('locations').select('bathroom').where('id', originLocationId),
            ),
        )
        .select(
          'locations.id',
          'locations.name',
          'locations.type',
          'locations.default_location',
          'locations.teacher_user_id',
          'users.display_name as teacher_name',
          'bathroom.name as bathroom_name',
          trx.raw(
            'case when locations.id = (select bathroom from locations as origin_location where origin_location.id = ?) then 1 else 0 end as assigned_bathroom',
            [originLocationId],
          ),
        )
        .orderBy('assigned_bathroom', 'desc')
        .orderBy('locations.default_location', 'desc')
        .orderBy('locations.name');
    },
    async findStudentByNumber(studentNumber, trx = knex) {
      return trx('students').where({ student_number: studentNumber, status: 'active' }).first();
    },
    async findStudentsByName(studentName, trx = knex) {
      return trx('students')
        .where({ status: 'active' })
        .whereRaw('lower(display_name) = lower(?)', [studentName.trim()])
        .orderBy('student_number');
    },
    async findCurrentPassForStudent(studentId, trx = knex) {
      return trx('passes')
        .join('locations as origin', 'passes.origin_location_id', 'origin.id')
        .where({ student_id: studentId })
        .whereIn('status', ['pending_approval', 'active', 'arrived', 'returning'])
        .select('passes.*', 'origin.teacher_user_id as origin_teacher_id')
        .orderBy('requested_at', 'desc')
        .first();
    },
    async countCurrentPasses(
      { destinationLocationId, originLocationId = null, excludePassId = null },
      trx = knex,
    ) {
      const query = trx('passes')
        .where({ destination_location_id: destinationLocationId })
        .whereIn('status', ['pending_approval', 'active', 'arrived', 'returning']);
      if (originLocationId) query.where({ origin_location_id: originLocationId });
      if (excludePassId) query.whereNot({ id: excludePassId });
      const result = await query.count('* as count').first();
      return Number(result?.count || 0);
    },
    async findEligibleAppointment(
      studentId,
      originLocationId,
      destinationLocationId,
      now,
      trx = knex,
    ) {
      const windowStart = new Date(now.getTime() - 5 * 60 * 1000);
      return trx('appointments')
        .where({
          student_id: studentId,
          origin_location_id: originLocationId,
          destination_location_id: destinationLocationId,
          status: 'scheduled',
        })
        .whereBetween('scheduled_at', [windowStart, now])
        .orderBy('scheduled_at')
        .first();
    },
    async listUpcomingAppointmentsForStudent(studentId, now, windowHours = 12, trx = knex) {
      const start = new Date(now);
      const end = new Date(start.getTime() + windowHours * 60 * 60 * 1000);
      return trx('appointments')
        .join('locations as origin', 'appointments.origin_location_id', 'origin.id')
        .join('locations as destination', 'appointments.destination_location_id', 'destination.id')
        .leftJoin('users as destination_teacher', 'appointments.destination_teacher_id', 'destination_teacher.id')
        .where({ 'appointments.student_id': studentId, 'appointments.status': 'scheduled' })
        .where('appointments.scheduled_at', '>=', start)
        .where('appointments.scheduled_at', '<=', end)
        .select(
          'appointments.*',
          'origin.name as origin_name',
          'destination.name as destination_name',
          'destination_teacher.display_name as destination_teacher_name',
        )
        .orderBy('appointments.scheduled_at');
    },
    async findUpcomingAppointmentForStudent(studentId, appointmentId, now, windowHours = 12, trx = knex) {
      const start = new Date(now);
      const end = new Date(start.getTime() + windowHours * 60 * 60 * 1000);
      return trx('appointments')
        .join('locations as origin', 'appointments.origin_location_id', 'origin.id')
        .join('locations as destination', 'appointments.destination_location_id', 'destination.id')
        .leftJoin('users as destination_teacher', 'appointments.destination_teacher_id', 'destination_teacher.id')
        .where({
          'appointments.id': appointmentId,
          'appointments.student_id': studentId,
          'appointments.status': 'scheduled',
        })
        .where('appointments.scheduled_at', '>=', start)
        .where('appointments.scheduled_at', '<=', end)
        .select(
          'appointments.*',
          'origin.name as origin_name',
          'destination.name as destination_name',
          'destination_teacher.display_name as destination_teacher_name',
        )
        .first();
    },
    async markAppointmentUsed(id, usedAt, trx = knex) {
      await trx('appointments')
        .where({ id, status: 'scheduled' })
        .update({ status: 'used', used_at: usedAt, updated_at: trx.fn.now() });
    },
    async completeAppointment(id, completedAt, trx = knex) {
      await trx('appointments')
        .where({ id, status: 'scheduled' })
        .update({ status: 'completed', used_at: completedAt, updated_at: trx.fn.now() });
    },
    async expireAppointmentNoShows(now, trx = knex) {
      const cutoff = new Date(now.getTime() - 30 * 60 * 1000);
      await trx('appointments')
        .where({ status: 'scheduled' })
        .where('scheduled_at', '<=', cutoff)
        .update({ status: 'no_show', updated_at: trx.fn.now() });
    },
    async createPass(pass, event, trx = knex) {
      await trx('passes').insert(pass);
      await trx('pass_events').insert(event);
      return pass;
    },
    async updatePass(id, patch, trx = knex) {
      await trx('passes').where({ id }).update(patch);
    },
    async addEvent(event, trx = knex) {
      await trx('pass_events').insert(event);
    },
    async listTeacherLocations(userId, trx = knex) {
      return trx('locations').where({ teacher_user_id: userId, active: true }).orderBy('name');
    },
    async listTeacherPasses(userId, trx = knex) {
      return trx('passes')
        .join('students', 'passes.student_id', 'students.id')
        .join('locations as origin', 'passes.origin_location_id', 'origin.id')
        .join('locations as destination', 'passes.destination_location_id', 'destination.id')
        .leftJoin(
          'users as destination_teacher',
          'passes.destination_teacher_id',
          'destination_teacher.id',
        )
        .where('origin.teacher_user_id', userId)
        .select(
          'passes.*',
          'students.student_number',
          'students.display_name as student_name',
          'origin.name as origin_name',
          'destination.name as destination_name',
          'destination_teacher.display_name as destination_teacher_name',
        )
        .orderBy('passes.requested_at', 'desc');
    },
    async findPassForTeacher(passId, userId, trx = knex) {
      return trx('passes')
        .join('locations as origin', 'passes.origin_location_id', 'origin.id')
        .join('locations as destination', 'passes.destination_location_id', 'destination.id')
        .where('passes.id', passId)
        .where('origin.teacher_user_id', userId)
        .select(
          'passes.*',
          'origin.teacher_user_id as origin_teacher_id',
          'destination.teacher_user_id as destination_teacher_id',
        )
        .first();
    },
    async listLocations(trx = knex) {
      return trx('locations').where({ active: true }).orderBy('name');
    },
    async findLocationPair(originId, destinationId, trx = knex) {
      const rows = await trx('locations').whereIn('id', [originId, destinationId]);
      return {
        origin: rows.find((row) => row.id === originId),
        destination: rows.find((row) => row.id === destinationId),
      };
    },
    async createAppointment(appointment, trx = knex) {
      await trx('appointments').insert(appointment);
      return appointment;
    },
    async listAppointmentsForTeacher(userId, trx = knex) {
      return trx('appointments')
        .join('students', 'appointments.student_id', 'students.id')
        .leftJoin('locations as origin', 'appointments.origin_location_id', 'origin.id')
        .leftJoin(
          'locations as destination',
          'appointments.destination_location_id',
          'destination.id',
        )
        .where((query) =>
          query
            .where('appointments.created_by', userId)
            .orWhere('origin.teacher_user_id', userId)
            .orWhere('destination.teacher_user_id', userId),
        )
        .select(
          'appointments.*',
          'students.student_number',
          'students.display_name as student_name',
          'origin.name as origin_name',
          'destination.name as destination_name',
        )
        .orderBy('appointments.scheduled_at');
    },
    async listManagerPasses(filters = {}, trx = knex) {
      const query = trx('passes')
        .join('students', 'passes.student_id', 'students.id')
        .leftJoin('locations as origin', 'passes.origin_location_id', 'origin.id')
        .leftJoin('locations as destination', 'passes.destination_location_id', 'destination.id')
        .leftJoin('appointments', 'passes.appointment_id', 'appointments.id')
        .select(
          'passes.*',
          'students.student_number',
          'students.display_name as student_name',
          'origin.name as origin_name',
          'destination.name as destination_name',
          'appointments.scheduled_at as appointment_scheduled_at',
        );
      if (filters.status === 'timedout') {
        query
          .whereIn('passes.status', ['active', 'arrived'])
          .whereNotNull('passes.timeout_at')
          .where('passes.timeout_at', '<=', filters.now);
      } else if (filters.status) {
        query.where('passes.status', filters.status);
      }
      if (filters.studentNumber) query.where('students.student_number', filters.studentNumber);
      return query.orderBy('passes.requested_at', 'desc');
    },
    async listManagerAppointments(filters = {}, trx = knex) {
      const query = trx('appointments')
        .join('students', 'appointments.student_id', 'students.id')
        .leftJoin('locations as origin', 'appointments.origin_location_id', 'origin.id')
        .leftJoin(
          'locations as destination',
          'appointments.destination_location_id',
          'destination.id',
        )
        .select(
          'appointments.*',
          'students.student_number',
          'students.display_name as student_name',
          'origin.name as origin_name',
          'destination.name as destination_name',
        );
      if (filters.appointmentStatus) query.where('appointments.status', filters.appointmentStatus);
      if (filters.studentNumber) query.where('students.student_number', filters.studentNumber);
      return query.orderBy('appointments.scheduled_at', 'desc');
    },
    async listManagerStudents(trx = knex) {
      return trx('students').orderBy('display_name');
    },
    async findStudentById(id, trx = knex) {
      return trx('students').where({ id }).first();
    },
    async createStudent(student, trx = knex) {
      await trx('students').insert(student);
      return student;
    },
    async updateStudent(id, patch, trx = knex) {
      await trx('students')
        .where({ id })
        .update({ ...patch, updated_at: trx.fn.now() });
    },
    async deleteStudent(id, trx = knex) {
      await trx('students')
        .where({ id })
        .delete();
    },
    async listManagerLocations(trx = knex) {
      return trx('locations')
        .whereNot('locations.name', 'APPOINTMENT')
        .leftJoin('users', 'locations.teacher_user_id', 'users.id')
        .select('locations.*', 'users.display_name as teacher_name')
        .orderBy('locations.name');
    },
    async findLocationById(id, trx = knex) {
      return trx('locations').where({ id }).first();
    },
    async findLocationByName(name, trx = knex) {
      return trx('locations').whereRaw('lower(name) = ?', [name.toLowerCase()]).first();
    },
    async createLocation(location, trx = knex) {
      await trx('locations').insert(location);
      return location;
    },
    async updateLocation(id, patch, trx = knex) {
      await trx('locations')
        .where({ id })
        .update({ ...patch, updated_at: trx.fn.now() });
    },
    async unassignLocationReferences(id, now, trx = knex) {
      await trx('passes')
        .whereIn('status', ['pending_approval', 'active', 'arrived', 'returning'])
        .where((query) =>
          query.where('origin_location_id', id).orWhere('destination_location_id', id),
        )
        .update({ status: 'cancelled', ended_at: now, updated_at: now });
      await trx('appointments')
        .where({ status: 'scheduled' })
        .where((query) =>
          query.where('origin_location_id', id).orWhere('destination_location_id', id),
        )
        .update({ status: 'cancelled', cancelled_at: now, updated_at: now });
      await trx('kiosks')
        .where({ location_id: id })
        .update({ location_id: null, active: false, updated_at: now });
      await trx('kiosk_enrollment_codes').where({ location_id: id }).update({ location_id: null });
      await trx('locations').where({ bathroom: id }).update({ bathroom: null });
      await trx('passes').where({ origin_location_id: id }).update({ origin_location_id: null });
      await trx('passes')
        .where({ destination_location_id: id })
        .update({ destination_location_id: null });
      await trx('passes').where({ ended_location_id: id }).update({ ended_location_id: null });
      await trx('appointments')
        .where({ origin_location_id: id })
        .update({ origin_location_id: null });
      await trx('appointments')
        .where({ destination_location_id: id })
        .update({ destination_location_id: null });
    },
    async deleteLocation(id, trx = knex) {
      await trx('locations').where({ id }).delete();
    },
    async listManagerKiosks(trx = knex) {
      return trx('kiosks')
        .leftJoin('locations', 'kiosks.location_id', 'locations.id')
        .select('kiosks.*', 'locations.name as location_name')
        .orderBy('kiosks.name');
    },
    async findKioskById(id, trx = knex) {
      return trx('kiosks').where({ id }).first();
    },
    async findKioskByNameAtLocation(name, locationId, trx = knex) {
      return trx('kiosks').where({ name, location_id: locationId }).first();
    },
    async findActiveKioskById(id, trx = knex) {
      return trx('kiosks')
        .join('locations', 'kiosks.location_id', 'locations.id')
        .where({ 'kiosks.id': id, 'kiosks.active': true, 'locations.active': true })
        .select(
          'kiosks.*',
          'locations.name as location_name',
          'locations.type as location_type',
          'locations.teacher_user_id as location_teacher_id',
        )
        .first();
    },
    async findKioskByKioskCode(kioskCode, trx = knex) {
      return trx('kiosks').where({ kiosk_code: kioskCode }).first();
    },
    async createKiosk(kiosk, trx = knex) {
      await trx('kiosks').insert(kiosk);
      return kiosk;
    },
    async updateKiosk(id, patch, trx = knex) {
      await trx('kiosks')
        .where({ id })
        .update({ ...patch, updated_at: trx.fn.now() });
    },
    async unassignKioskReferences(id, now, trx = knex) {
      await trx('passes')
        .where({ origin_kiosk_id: id })
        .whereIn('status', ['pending_approval', 'active', 'arrived', 'returning'])
        .update({ status: 'cancelled', ended_at: now, updated_at: now });
      await trx('passes').where({ origin_kiosk_id: id }).update({ origin_kiosk_id: null });
      await trx('kiosk_enrollment_codes').where({ kiosk_id: id }).update({ kiosk_id: null });
    },
    async deleteKiosk(id, trx = knex) {
      await trx('kiosks').where({ id }).delete();
    },
    async listManagerUsers(trx = knex) {
      const rows = await trx('users')
        .leftJoin('user_roles', 'users.id', 'user_roles.user_id')
        .leftJoin('roles', 'user_roles.role_id', 'roles.id')
        .where({ status: 'active' })
        .orderBy('display_name')
        .select(
          'users.id',
          'users.display_name',
          'users.primary_email',
          'roles.name as role',
        );
      return rows.reduce((users, row) => {
        let user = users.find((candidate) => candidate.id === row.id);
        if (!user) {
          user = {
            id: row.id,
            display_name: row.display_name,
            primary_email: row.primary_email,
            roles: [],
          };
          users.push(user);
        }
        if (row.role) user.roles.push(row.role);
        return users;
      }, []);
    },
    async findManagerUserById(id, trx = knex) {
      const rows = await trx('users')
        .leftJoin('user_roles', 'users.id', 'user_roles.user_id')
        .leftJoin('roles', 'user_roles.role_id', 'roles.id')
        .where({ 'users.id': id, 'users.status': 'active' })
        .select('users.id', 'users.display_name', 'users.primary_email', 'roles.name as role');
      if (!rows.length) return null;
      return {
        id: rows[0].id,
        display_name: rows[0].display_name,
        primary_email: rows[0].primary_email,
        roles: rows.filter((row) => row.role).map((row) => row.role),
      };
    },
  };
}

export function createSisRepository(db) {
  const knex = db.knex;

  return {
    async createConnection(row, trx = knex) {
      await trx('sis_connections').insert(row);
      return row;
    },
    async listConnections(trx = knex) {
      return trx('sis_connections').select(
        'id',
        'provider',
        'connection_name',
        'configuration_json',
        'active',
        'sync_interval_seconds',
        'last_synced_at',
        'created_at',
        'updated_at',
      ).orderBy('connection_name');
    },
    async findConnection(id, trx = knex) {
      return trx('sis_connections').where({ id }).first();
    },
    async updateConnection(id, patch, trx = knex) {
      await trx('sis_connections').where({ id }).update({ ...patch, updated_at: trx.fn.now() });
    },
    async deleteConnection(id, trx = knex) {
      await trx('sis_connections').where({ id }).delete();
    },
    async createSyncHistory(row, trx = knex) {
      await trx('sis_sync_history').insert(row);
      return row;
    },
    async completeSyncHistory(id, patch, trx = knex) {
      await trx('sis_sync_history').where({ id }).update(patch);
    },
    async listSyncHistory(connectionId, limit = 50, trx = knex) {
      return trx('sis_sync_history')
        .where({ connection_id: connectionId })
        .orderBy('started_at', 'desc')
        .limit(limit);
    },
    async upsertStudent(connectionId, student, trx = knex) {
      const existing = await trx('students')
        .where({ sis_connection_id: connectionId, sis_student_id: student.sisId })
        .first();
      const patch = {
        first_name: student.firstName,
        last_name: student.lastName,
        display_name: `${student.firstName} ${student.lastName}`.trim(),
        status: student.active ? 'active' : 'inactive',
        updated_at: trx.fn.now(),
      };
      if (existing) {
        await trx('students').where({ id: existing.id }).update(patch);
        return { created: false, updated: true, student: { ...existing, ...patch } };
      }
      const created = {
        id: randomUUID(),
        student_number: student.sisId,
        sis_connection_id: connectionId,
        sis_student_id: student.sisId,
        ...patch,
      };
      await trx('students').insert(created);
      return { created: true, updated: false, student: created };
    },
    async markMissingStudentsInactive(connectionId, seenIds, trx = knex) {
      const query = trx('students')
        .where({ sis_connection_id: connectionId, status: 'active' })
        .whereNotNull('sis_student_id');
      if (seenIds.size > 0) query.whereNotIn('sis_student_id', [...seenIds]);
      return query.update({ status: 'inactive', updated_at: trx.fn.now() });
    },
  };
}
