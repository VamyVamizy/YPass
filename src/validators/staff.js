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
  destinationLocationId: id,
  scheduledAt: z.string().trim().min(1).max(40),
  notes: z.string().trim().max(500).optional(),
  _csrf: z.string().optional(),
});

export const appointmentStudentLookupSchema = z.object({
  studentNumber: studentNumber.optional(),
  studentName: studentName.optional(),
}).refine(({ studentNumber, studentName }) => studentNumber || studentName, {
  message: 'Enter a student name or ID',
});

export const managerFilterSchema = z.object({
  status: z.string().trim().max(32).optional(),
  appointmentStatus: z.string().trim().max(32).optional(),
  studentNumber: z.string().trim().max(64).optional(),
  enrollmentCode: z.string().trim().max(16).optional(),
  role: z.enum(['student','teacher','manager','']).optional(),
});

const active = z.enum(['true', 'false']).transform((value) => value === 'true');
const managerId = z.string().uuid();
const defaultLocation = z
  .preprocess((value) => value === 'true' || value === true, z.boolean())
  .default(false);

export const managerStudentCreateSchema = z.object({
  studentNumber,
  studentName,
  status: z.enum(['active', 'inactive']),
  _csrf: z.string().optional(),
});
export const managerStudentUpdateSchema = managerStudentCreateSchema.extend({ id: managerId });

export const managerLocationCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['round_trip', 'one_way', 'bathroom']),
  bathroom: managerId.optional().or(z.literal('')),
  teacherUserId: managerId.optional().or(z.literal('')),
  defaultLocation,
  active,
  _csrf: z.string().optional(),
});
export const managerLocationUpdateSchema = managerLocationCreateSchema.extend({ id: managerId });
export const managerLocationDeleteSchema = z.object({
  id: managerId,
  _csrf: z.string().optional(),
});

export const managerKioskCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kioskCode: z.string().trim().min(1).max(64),
  kioskSecret: z.string().trim().min(16).max(255).optional().or(z.literal('')),
  locationId: managerId,
  active,
  _csrf: z.string().optional(),
});
export const managerKioskUpdateSchema = managerKioskCreateSchema.extend({
  locationId: managerId.or(z.literal('')),
  id: managerId,
});
export const managerKioskDeleteSchema = z.object({
  id: managerId,
  _csrf: z.string().optional(),
});

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

export const managerUserRoleSchema = z.object({
  userId: managerId,
  roleName: z.enum(['student', 'teacher', 'manager']),
  _csrf: z.string().optional(),
});
