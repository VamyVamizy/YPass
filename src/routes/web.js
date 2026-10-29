import { Router } from 'express';
import { createWebController } from '#controllers/web-controller.js';
import {
  requireAuthentication,
  requireKioskSession,
  requireManager,
  requireStaffRole,
} from '#middleware/auth.js';
import { validate } from '#middleware/validate.js';
import {
  createPassRequestSchema,
  kioskScanSchema,
  kioskSessionPassSchema,
  kioskSessionScanSchema,
} from '#validators/pass.js';
import {
  appointmentSchema,
  managerFilterSchema,
  managerKioskCreateSchema,
  managerKioskUpdateSchema,
  managerEnrollmentCodeSchema,
  managerEnrollmentCompleteSchema,
  managerKioskCredentialRotationSchema,
  managerLocationCreateSchema,
  managerLocationUpdateSchema,
  managerStudentCreateSchema,
  managerStudentUpdateSchema,
  managerUserRoleSchema,
  passActionSchema,
} from '#validators/staff.js';

export function createWebRouter(container) {
  const router = Router();
  const controller = createWebController(container);
  router.get('/', controller.home);
  router.get('/example', requireAuthentication(), controller.example);
  router.get('/teacher', requireStaffRole('teacher'), controller.teacher);
  router.post(
    '/teacher/pass',
    requireStaffRole('teacher'),
    validate(passActionSchema),
    controller.teacherAction,
  );
  router.get('/teacher/appointment', requireStaffRole('teacher'), controller.appointment);
  router.post(
    '/teacher/appointment',
    requireStaffRole('teacher'),
    validate(appointmentSchema),
    controller.createAppointment,
  );
  router.get('/kiosk', requireAuthentication(), controller.kiosk);
  router.get('/kiosk/pass', requireKioskSession(container), controller.kioskPass);
  router.get('/kiosk/pass/status', requireKioskSession(container), controller.kioskPassStatus);
  router.post(
    '/kiosk/scan',
    (req, _res, next) =>
      req.session?.kioskId
        ? requireKioskSession(container)(req, _res, next)
        : requireAuthentication()(req, _res, next),
    (req, _res, next) =>
      validate(req.session?.kioskId ? kioskSessionScanSchema : kioskScanSchema)(req, _res, next),
    controller.scanKiosk,
  );
  router.post(
    '/kiosk/pass',
    (req, _res, next) =>
      req.session?.kioskId
        ? requireKioskSession(container)(req, _res, next)
        : requireAuthentication()(req, _res, next),
    (req, _res, next) =>
      validate(req.session?.kioskId ? kioskSessionPassSchema : createPassRequestSchema)(
        req,
        _res,
        next,
      ),
    controller.createKioskPass,
  );
  router.get(
    '/manager',
    requireAuthentication(),
    requireManager(container.config.managers),
    validate(managerFilterSchema, 'query'),
    controller.manager,
  );
  const manager = [requireAuthentication(), requireManager(container.config.managers)];
  router.post(
    '/manager/students/create',
    ...manager,
    validate(managerStudentCreateSchema),
    controller.createManagerStudent,
  );
  router.post(
    '/manager/students/update',
    ...manager,
    validate(managerStudentUpdateSchema),
    controller.updateManagerStudent,
  );
  router.post(
    '/manager/users/role',
    ...manager,
    validate(managerUserRoleSchema),
    controller.updateManagerUserRole,
  );
  router.post(
    '/manager/locations/create',
    ...manager,
    validate(managerLocationCreateSchema),
    controller.createManagerLocation,
  );
  router.post(
    '/manager/locations/update',
    ...manager,
    validate(managerLocationUpdateSchema),
    controller.updateManagerLocation,
  );
  router.post(
    '/manager/kiosks/create',
    ...manager,
    validate(managerKioskCreateSchema),
    controller.createManagerKiosk,
  );
  router.post(
    '/manager/kiosks/update',
    ...manager,
    validate(managerKioskUpdateSchema),
    controller.updateManagerKiosk,
  );
  router.post(
    '/manager/kiosks/enrollment-codes/create',
    ...manager,
    validate(managerEnrollmentCodeSchema),
    controller.createManagerEnrollmentCode,
  );
  router.post(
    '/manager/kiosks/enrollment/complete',
    ...manager,
    validate(managerEnrollmentCompleteSchema),
    controller.completeManagerEnrollment,
  );
  router.post(
    '/manager/kiosks/credentials/regenerate',
    ...manager,
    validate(managerKioskCredentialRotationSchema),
    controller.regenerateManagerKioskCredentials,
  );
  return router;
}
