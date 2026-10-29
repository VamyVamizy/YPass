/**
 * User persistence. Keep SQL inside this module.
 */
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
    async removeRoles(userId, roleNames, trx = knex) {
      await trx('user_roles')
        .where('user_roles.user_id', userId)
        .whereIn('user_roles.role_id', trx('roles').select('id').whereIn('name', roleNames))
        .delete();
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
      const row = await trx('kiosks').max({ value: 'kiosk_code' }).first();
      const current = Number(String(row?.value || '').match(/(\d+)$/)?.[1] || 0);
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
        .where('locations.active', true)
        .whereNot('locations.id', originLocationId)
        .select(
          'locations.id',
          'locations.name',
          'locations.type',
          'locations.teacher_user_id',
          'users.display_name as teacher_name',
        )
        .orderBy('locations.name');
    },
    async findStudentByNumber(studentNumber, trx = knex) {
      return trx('students').where({ student_number: studentNumber, status: 'active' }).first();
    },
    async findCurrentPassForStudent(studentId, trx = knex) {
      return trx('passes')
        .where({ student_id: studentId })
        .whereIn('status', ['pending_approval', 'active', 'arrived', 'returning'])
        .orderBy('requested_at', 'desc')
        .first();
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
    async markAppointmentUsed(id, usedAt, trx = knex) {
      await trx('appointments')
        .where({ id, status: 'scheduled' })
        .update({ status: 'used', used_at: usedAt, updated_at: trx.fn.now() });
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
    async findAppointmentForStudentAtTime(studentId, scheduledAt, trx = knex) {
      return trx('appointments').where({ student_id: studentId, scheduled_at: scheduledAt }).first();
    },
    async createAppointment(appointment, trx = knex) {
      await trx('appointments').insert(appointment);
      return appointment;
    },
    async listAppointmentsForTeacher(userId, trx = knex) {
      return trx('appointments')
        .join('students', 'appointments.student_id', 'students.id')
        .join('locations as origin', 'appointments.origin_location_id', 'origin.id')
        .join('locations as destination', 'appointments.destination_location_id', 'destination.id')
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
        .join('locations as origin', 'passes.origin_location_id', 'origin.id')
        .join('locations as destination', 'passes.destination_location_id', 'destination.id')
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
        .join('locations as origin', 'appointments.origin_location_id', 'origin.id')
        .join('locations as destination', 'appointments.destination_location_id', 'destination.id')
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
    async listManagerLocations(trx = knex) {
      return trx('locations')
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
    async listManagerKiosks(trx = knex) {
      return trx('kiosks')
        .join('locations', 'kiosks.location_id', 'locations.id')
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
    async listManagerUsers(trx = knex) {
      const rows = await trx('users')
        .leftJoin('user_roles', 'users.id', 'user_roles.user_id')
        .leftJoin('roles', 'user_roles.role_id', 'roles.id')
        .where({ status: 'active' })
        .orderBy('display_name')
        .select('users.id', 'users.display_name', 'users.primary_email', 'roles.name as role');
      return [...new Map(rows.map((row) => [row.id, { ...row, roles: [] }])).values()].map((user) => ({
        ...user,
        roles: rows.filter((row) => row.id === user.id && row.role).map((row) => row.role),
      }));
    },
  };
}
