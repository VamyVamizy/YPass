import { z } from 'zod';

const id = z.string().uuid();
const studentNumber = z.string().trim().min(1).max(64);
const studentName = z.string().trim().min(1).max(120);

export const passActionSchema = z.object({
  passId: id,
  action: z.enum(['approve', 'cancel']),
  _csrf: z.string().optional(),
});

export const appointmentSchema = z.object({
  studentNumber,
  studentName,
  originLocationId: id,
  destinationLocationId: id,
  scheduledAt: z.string().trim().min(1).max(40),
  notes: z.string().trim().max(500).optional(),
  _csrf: z.string().optional(),
});

export const managerFilterSchema = z.object({
  status: z.string().trim().max(32).optional(),
  appointmentStatus: z.string().trim().max(32).optional(),
  studentNumber: z.string().trim().max(64).optional(),
  enrollmentCode: z.string().trim().max(16).optional(),
});

const active = z.enum(['true', 'false']).transform((value) => value === 'true');
const managerId = z.string().uuid();

export const managerStudentCreateSchema = z.object({
  studentNumber,
  studentName,
  status: z.enum(['active', 'inactive']),
  _csrf: z.string().optional(),
});
export const managerStudentUpdateSchema = managerStudentCreateSchema.extend({ id: managerId });
export const managerUserRoleSchema = z.object({
  userId: managerId,
  roleName: z.enum(['student', 'teacher', 'manager']),
  _csrf: z.string().optional(),
});

export const managerLocationCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['round_trip', 'one_way', 'bathroom']),
  teacherUserId: managerId.optional().or(z.literal('')),
  active,
  _csrf: z.string().optional(),
});
export const managerLocationUpdateSchema = managerLocationCreateSchema.extend({ id: managerId });

export const managerKioskCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kioskCode: z.string().trim().min(1).max(64),
  kioskSecret: z.string().trim().min(16).max(255).optional().or(z.literal('')),
  locationId: managerId,
  active,
  _csrf: z.string().optional(),
});
export const managerKioskUpdateSchema = managerKioskCreateSchema.extend({ id: managerId });

export const managerEnrollmentCodeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  locationId: managerId,
  _csrf: z.string().optional(),
});

export const managerEnrollmentCompleteSchema = z.object({
  enrollmentCode: z.string().trim().min(9).max(16),
  name: z.string().trim().min(1).max(120),
  locationId: managerId,
  _csrf: z.string().optional(),
});

export const managerKioskCredentialRotationSchema = z.object({
  kioskId: managerId,
  _csrf: z.string().optional(),
});
