import { describe, expect, it, afterEach } from 'vitest';
import { createTestApp } from '../helpers/app.js';

describe('http skeleton', () => {
  /** @type {Awaited<ReturnType<typeof createTestApp>> | null} */
  let ctx = null;
  afterEach(async () => {
    if (ctx) {
      await ctx.close();
      ctx = null;
    }
  });

  it('serves the home page and hides X-Powered-By', async () => {
    ctx = await createTestApp();
    const res = await ctx.request.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Elektronischer Hallenpass');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeTruthy();
  });

  it('returns JSON 404 for API paths', async () => {
    ctx = await createTestApp();
    const res = await ctx.request.get('/api/v1/missing');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('reports live and ready health', async () => {
    ctx = await createTestApp();
    const live = await ctx.request.get('/health/live');
    expect(live.status).toBe(200);
    expect(live.body.status).toBe('live');
    const ready = await ctx.request.get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.details).toBeUndefined();
  });

  it('requires authentication for /api/v1/me', async () => {
    ctx = await createTestApp();
    const me = await ctx.request.get('/api/v1/me');
    expect(me.status).toBe(401);
  });

  it('renders the teacher page for an authenticated user', async () => {
    ctx = await createTestApp({ LOCAL_AUTH_EMAIL_FLOW: 'disabled', EMAIL_ENABLED: 'false' });
    const { default: request } = await import('supertest');
    const agent = request.agent(ctx.app);
    const registerPage = await agent.get('/auth/register');
    const register = await agent.post('/auth/register').type('form').send({
      _csrf: extractCsrf(registerPage.text),
      username: 'teacher-page-user',
      email: 'teacher-page@example.test',
      password: 'correct-horse-battery',
      displayName: 'Teacher Page User',
    });
    expect(register.status).toBe(302);
    const user = await ctx.container.db
      .knex('users')
      .where({ primary_email: 'teacher-page@example.test' })
      .first();
    await ctx.container.userService.setStaffRole({ userId: user.id, roleName: 'teacher' });

    const loginPage = await agent.get('/auth/login');
    const login = await agent.post('/auth/login').type('form').send({
      _csrf: extractCsrf(loginPage.text),
      username: 'teacher-page-user',
      password: 'correct-horse-battery',
    });
    expect(login.status).toBe(302);

    const teacherPage = await agent.get('/teacher');
    expect(teacherPage.status).toBe(200);
    expect(teacherPage.text).toContain('Lehrerseite');
  });

  it('redirects teacher pass actions before rendering the teacher page', async () => {
    ctx = await createTestApp({ LOCAL_AUTH_EMAIL_FLOW: 'disabled', EMAIL_ENABLED: 'false' });
    const { default: request } = await import('supertest');
    const agent = request.agent(ctx.app);
    const registerPage = await agent.get('/auth/register');
    await agent.post('/auth/register').type('form').send({
      _csrf: extractCsrf(registerPage.text),
      username: 'teacher-action-user',
      email: 'teacher-action@example.test',
      password: 'correct-horse-battery',
      displayName: 'Teacher Action User',
    });
    const loginPage = await agent.get('/auth/login');
    await agent.post('/auth/login').type('form').send({
      _csrf: extractCsrf(loginPage.text),
      username: 'teacher-action-user',
      password: 'correct-horse-battery',
    });
    const user = await ctx.container.db
      .knex('users')
      .where({ primary_email: 'teacher-action@example.test' })
      .first();
    await ctx.container.userService.setStaffRole({ userId: user.id, roleName: 'teacher' });
    const origin = await ctx.container.db.knex('locations').where({ name: 'Main Office' }).first();
    const destination = await ctx.container.db
      .knex('locations')
      .whereNot({ id: origin.id })
      .first();
    await ctx.container.db
      .knex('locations')
      .where({ id: origin.id })
      .update({ teacher_user_id: user.id });
    const requested = await ctx.container.passService.requestPass({
      kioskCode: 'main-office',
      studentNumber: '111111',
      studentName: 'Test Student 111111',
      destinationLocationId: destination.id,
    });
    const teacherPage = await agent.get('/teacher');

    const response = await agent.post('/teacher/pass').type('form').send({
      _csrf: extractCsrf(teacherPage.text),
      passId: requested.pass.id,
      action: 'approve',
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/teacher');
  });

  it('allows managers to use teacher and manager pages but blocks students from both', async () => {
    ctx = await createTestApp({ LOCAL_AUTH_EMAIL_FLOW: 'disabled', EMAIL_ENABLED: 'false' });
    const { default: request } = await import('supertest');
    const studentAgent = request.agent(ctx.app);
    const registerPage = await studentAgent.get('/auth/register');
    await studentAgent.post('/auth/register').type('form').send({
      _csrf: extractCsrf(registerPage.text),
      username: 'student-access-user',
      email: 'student-access@example.test',
      password: 'correct-horse-battery',
      displayName: 'Student Access User',
    });
    const studentLoginPage = await studentAgent.get('/auth/login');
    await studentAgent.post('/auth/login').type('form').send({
      _csrf: extractCsrf(studentLoginPage.text),
      username: 'student-access-user',
      password: 'correct-horse-battery',
    });
    expect((await studentAgent.get('/teacher')).status).toBe(403);
    expect((await studentAgent.get('/manager')).status).toBe(403);

    const manager = await ctx.container.db
      .knex('users')
      .where({ primary_email: 'student-access@example.test' })
      .first();
    await ctx.container.userService.setStaffRole({ userId: manager.id, roleName: 'manager' });
    expect((await studentAgent.get('/teacher')).status).toBe(200);
    expect((await studentAgent.get('/manager')).status).toBe(200);
  });

  it('treats configured MANAGERS as admin users', async () => {
    ctx = await createTestApp({
      MANAGERS: 'env-admin@example.test',
      LOCAL_AUTH_EMAIL_FLOW: 'disabled',
      EMAIL_ENABLED: 'false',
    });
    const { default: request } = await import('supertest');
    const agent = request.agent(ctx.app);
    const registerPage = await agent.get('/auth/register');
    await agent.post('/auth/register').type('form').send({
      _csrf: extractCsrf(registerPage.text),
      username: 'env-admin-user',
      email: 'env-admin@example.test',
      password: 'correct-horse-battery',
      displayName: 'Env Admin User',
    });
    const loginPage = await agent.get('/auth/login');
    await agent.post('/auth/login').type('form').send({
      _csrf: extractCsrf(loginPage.text),
      username: 'env-admin-user',
      password: 'correct-horse-battery',
    });

    const me = await agent.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.data.roles).toContain('admin');
    expect((await agent.get('/manager')).status).toBe(200);
  });

  it('does not register API routes when API_ENABLED is false', async () => {
    ctx = await createTestApp({ API_ENABLED: 'false' });
    const res = await ctx.request.get('/api/v1/me');
    expect(res.status).toBe(404);
  });
});

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : '';
}
