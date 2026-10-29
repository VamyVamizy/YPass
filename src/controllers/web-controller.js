export function createWebController(container) {
  const { passService, kioskService, userService } = container;

  return {
    home(req, res) {
      res.render('pages/home', {
        title: 'Home',
        features: container.config.features,
      });
    },
    example(req, res) {
      res.render('pages/example', {
        title: 'Example',
        socketEnabled: container.config.features.socketIo,
      });
    },
    teacher(req, res) {
      return passService.teacherDashboard(req.currentUser.id).then((dashboard) =>
        res.render('pages/teacher', {
          title: 'Teacher panel',
          currentUser: req.currentUser,
          message: null,
          ...dashboard,
        }),
      );
    },
    async teacherAction(req, res, next) {
      try {
        const approved = req.body.action === 'approve';
        const action = approved ? passService.approvePass : passService.cancelPass;
        await action({ passId: req.body.passId, userId: req.currentUser.id });
        const dashboard = await passService.teacherDashboard(req.currentUser.id);
        res.render('pages/teacher', {
          title: 'Teacher panel',
          currentUser: req.currentUser,
          message: approved ? 'Pass approved.' : 'Pass cancelled.',
          ...dashboard,
        });
      } catch (error) {
        next(error);
      }
    },
    async appointment(req, res, next) {
      try {
        const options = await passService.appointmentOptions(req.currentUser.id);
        res.render('pages/appointment', {
          title: 'Create appointment',
          currentUser: req.currentUser,
          ...options,
          form: {},
          message: null,
        });
      } catch (error) {
        next(error);
      }
    },
    async createAppointment(req, res, next) {
      try {
        await passService.createAppointment({ userId: req.currentUser.id, ...req.body });
        const options = await passService.appointmentOptions(req.currentUser.id);
        res.render('pages/appointment', {
          title: 'Create appointment',
          currentUser: req.currentUser,
          ...options,
          form: {},
          message: 'Appointment created.',
        });
      } catch (error) {
        if (!error.expose) {
          next(error);
          return;
        }
        const options = await passService.appointmentOptions(req.currentUser.id);
        res.status(error.status).render('pages/appointment', {
          title: 'Create appointment',
          currentUser: req.currentUser,
          ...options,
          form: req.body,
          message: error.message,
        });
      }
    },
    async kiosk(req, res, next) {
      try {
        const kioskCode = String(req.query.kiosk || 'main-office');
        const options = await passService.kioskOptions(kioskCode);
        const pendingRequest = req.session?.kioskPendingPass;
        const pending = pendingRequest
          ? await passService.kioskPendingPass({ kioskCode, ...pendingRequest })
          : null;
        if (!pending && pendingRequest) {
          delete req.session.kioskPendingPass;
        }
        renderKiosk(res, {
          kioskCode,
          ...options,
          action: pending ? 'pending' : null,
          student: pending?.student || null,
          pass: pending?.pass || null,
          form: pending
            ? {
                studentNumber: pending.student.student_number,
                studentName: pending.student.display_name,
                destinationLocationId:
                  pending.destination?.id || pending.pass.destination_location_id,
              }
            : {},
          message: pending
            ? { type: 'warning', text: 'This pass is waiting for teacher approval.' }
            : null,
        });
      } catch (error) {
        next(error);
      }
    },
    async kioskPass(req, res, next) {
      try {
        const options = await passService.kioskOptions(req.kiosk.kiosk_code);
        const pendingRequest = req.session.kioskPendingPass;
        const pending = pendingRequest
          ? await passService.kioskPendingPass({
              kioskCode: req.kiosk.kiosk_code,
              ...pendingRequest,
            })
          : null;
        if (!pending && pendingRequest) {
          delete req.session.kioskPendingPass;
        }
        renderKiosk(res, {
          view: 'pages/pass',
          kioskSession: true,
          kioskCode: req.kiosk.kiosk_code,
          ...options,
          action: pending ? 'pending' : null,
          student: pending?.student || null,
          pass: pending?.pass || null,
          form: pending
            ? {
                studentNumber: pending.student.student_number,
                studentName: pending.student.display_name,
                destinationLocationId:
                  pending.destination?.id || pending.pass.destination_location_id,
              }
            : {},
          message: pending
            ? { type: 'warning', text: 'This pass is waiting for teacher approval.' }
            : null,
        });
      } catch (error) {
        next(error);
      }
    },
    async kioskPassStatus(req, res, next) {
      try {
        const pendingRequest = req.session.kioskPendingPass;
        const pending = pendingRequest
          ? await passService.kioskPendingPass({
              kioskCode: req.kiosk.kiosk_code,
              ...pendingRequest,
            })
          : null;
        if (!pending && pendingRequest) delete req.session.kioskPendingPass;
        res.json({ pending: Boolean(pending) });
      } catch (error) {
        next(error);
      }
    },
    async scanKiosk(req, res, next) {
      const kioskCode = req.kiosk?.kiosk_code || req.body.kioskCode;
      try {
        const result = await passService.scanStudent({
          kioskCode,
          studentNumber: req.body.studentNumber,
          actorUserId: req.currentUser?.id,
        });
        const message = scanMessage(result);
        renderKiosk(res, {
          ...result,
          kioskCode,
          kioskSession: Boolean(req.kiosk),
          form: {},
          message,
        });
      } catch (error) {
        if (!error.expose) {
          next(error);
          return;
        }
        try {
          const options = await passService.kioskOptions(kioskCode);
          renderKiosk(
            res,
            {
              ...options,
              kioskCode,
              kioskSession: Boolean(req.kiosk),
              form: req.body,
              message: { type: 'error', text: error.message },
            },
            error.status,
          );
        } catch (renderError) {
          next(renderError);
        }
      }
    },
    async createKioskPass(req, res, next) {
      const kioskCode = req.kiosk?.kiosk_code || req.body.kioskCode;
      try {
        const pendingRequest = req.session?.kioskPendingPass;
        if (pendingRequest) {
          const pending = await passService.kioskPendingPass({ kioskCode, ...pendingRequest });
          if (pending) {
            renderKiosk(res, {
              ...pending,
              action: 'pending',
              kioskCode,
              kioskSession: Boolean(req.kiosk),
              form: {
                studentNumber: pending.student.student_number,
                studentName: pending.student.display_name,
                destinationLocationId:
                  pending.destination?.id || pending.pass.destination_location_id,
              },
              message: { type: 'warning', text: 'This pass is waiting for teacher approval.' },
            });
            return;
          }
          delete req.session.kioskPendingPass;
        }
        const result = await passService.requestPass({
          kioskCode,
          studentNumber: req.body.studentNumber,
          studentName: req.body.studentName,
          destinationLocationId: req.body.destinationLocationId,
          actorUserId: req.currentUser?.id,
        });
        if (result.pass.status === 'pending_approval' && req.session) {
          req.session.kioskPendingPass = {
            passId: result.pass.id,
            studentNumber: result.student.student_number,
          };
        }
        renderKiosk(res, {
          ...result,
          kioskCode,
          kioskSession: Boolean(req.kiosk),
          form: {},
          message: {
            type: 'success',
            text: `Pass requested for ${result.student.display_name}. A teacher must approve it before departure.`,
          },
        });
      } catch (error) {
        if (!error.expose) {
          next(error);
          return;
        }
        try {
          const options = await passService.kioskOptions(kioskCode);
          renderKiosk(
            res,
            {
              ...options,
              kioskCode,
              kioskSession: Boolean(req.kiosk),
              student: { display_name: req.body.studentName },
              form: req.body,
              message: { type: 'error', text: error.message },
            },
            error.status,
          );
        } catch (renderError) {
          next(renderError);
        }
      }
    },
    async manager(req, res, next) {
      try {
        const manager = await passService.managerDashboard(req.query);
        const enrollmentCodes = await kioskService.listEnrollmentCodes();
        res.render('pages/manager', {
          title: 'Manager panel',
          currentUser: req.currentUser,
          ...manager,
          enrollmentCodes,
          enrollmentCode: req.query.enrollmentCode || null,
        });
      } catch (error) {
        next(error);
      }
    },
    async createManagerStudent(req, res, next) {
      return managerMutation(req, res, next, () => passService.createManagerStudent(req.body));
    },
    async updateManagerStudent(req, res, next) {
      return managerMutation(req, res, next, () => passService.updateManagerStudent(req.body));
    },
    async updateManagerUserRole(req, res, next) {
      return managerMutation(req, res, next, () =>
        userService.setStaffRole(req.body, { userId: req.currentUser.id, ...req }),
      );
    },
    async createManagerLocation(req, res, next) {
      return managerMutation(req, res, next, () => passService.createManagerLocation(req.body));
    },
    async updateManagerLocation(req, res, next) {
      return managerMutation(req, res, next, () => passService.updateManagerLocation(req.body));
    },
    async createManagerKiosk(req, res, next) {
      return managerMutation(req, res, next, () => passService.createManagerKiosk(req.body));
    },
    async updateManagerKiosk(req, res, next) {
      return managerMutation(req, res, next, () => passService.updateManagerKiosk(req.body));
    },
    async createManagerEnrollmentCode(req, res, next) {
      try {
        const result = await kioskService.createEnrollmentCode({
          createdBy: req.currentUser.id,
          ...req.body,
          reqLike: req,
        });
        res.redirect(`/manager?enrollmentCode=${encodeURIComponent(result.code)}`);
      } catch (error) {
        next(error);
      }
    },
    async completeManagerEnrollment(req, res, next) {
      try {
        await kioskService.completeEnrollment({ ...req.body, reqLike: req });
        res.redirect('/manager');
      } catch (error) {
        next(error);
      }
    },
    async regenerateManagerKioskCredentials(req, res, next) {
      try {
        const result = await kioskService.createCredentialRegenerationCode({
          createdBy: req.currentUser.id,
          kioskId: req.body.kioskId,
          reqLike: req,
        });
        res.redirect(`/manager?enrollmentCode=${encodeURIComponent(result.code)}`);
      } catch (error) {
        next(error);
      }
    },
  };

  async function managerMutation(req, res, next, action) {
    try {
      await action();
      res.redirect('/manager');
    } catch (error) {
      next(error);
    }
  }

  function renderKiosk(res, data, status = 200) {
    const { view = 'pages/kiosk', ...viewData } = data;
    res.status(status).render(view, {
      title: 'Student Pass Kiosk',
      currentUser: res.req.currentUser || null,
      action: null,
      student: null,
      destinations: [],
      kiosk: null,
      form: {},
      message: null,
      kioskSession: false,
      ...viewData,
    });
  }
}

function scanMessage(result) {
  if (result.action === 'create') {
    return { type: 'info', text: `Welcome, ${result.student.display_name}. Choose a destination.` };
  }
  if (result.action === 'pending') {
    return { type: 'warning', text: 'This student has a pass waiting for teacher approval.' };
  }
  if (result.action === 'arrival') {
    return { type: 'success', text: `Arrival recorded for ${result.student.display_name}.` };
  }
  if (result.action === 'scan_out') {
    return { type: 'info', text: `${result.student.display_name} has left the destination.` };
  }
  return { type: 'success', text: `Pass ended for ${result.student.display_name}.` };
}
