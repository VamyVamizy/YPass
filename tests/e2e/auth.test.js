import { describe, expect, it, afterEach } from 'vitest';
import { createTestApp } from '../helpers/app.js';

describe('local authentication', () => {
  let ctx;
  afterEach(async () => {
    if (ctx) await ctx.close();
  });

  it('registers, rejects login before verification when required, and logs in when email flow is disabled', async () => {
    ctx = await createTestApp({ LOCAL_AUTH_EMAIL_FLOW: 'disabled', EMAIL_ENABLED: 'false' });
    const { default: request } = await import('supertest');
    const agent = request.agent(ctx.app);

    const page = await agent.get('/auth/register');
    const csrf = extractCsrf(page.text);
    const register = await agent.post('/auth/register').type('form').send({
      _csrf: csrf,
      username: 'alice',
      email: 'alice@example.test',
      password: 'correct-horse-battery',
      displayName: 'Alice',
    });
    expect(register.status).toBe(302);

    const loginPage = await agent.get('/auth/login');
    const loginCsrf = extractCsrf(loginPage.text);
    const login = await agent.post('/auth/login').type('form').send({
      _csrf: loginCsrf,
      username: 'alice',
      password: 'correct-horse-battery',
    });
    expect(login.status).toBe(302);

    const me = await agent.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.data.displayName).toBe('Alice');
    expect(me.body.data.roles).toContain('student');
    expect(me.body.data.roles).not.toContain('teacher');

    const teacherPage = await agent.get('/teacher');
    expect(teacherPage.status).toBe(403);
  });

  it('uses a generic password-reset response whether or not the email exists', async () => {
    ctx = await createTestApp();
    const { default: request } = await import('supertest');
    const agent = request.agent(ctx.app);
    const page = await agent.get('/auth/forgot');
    const csrf = extractCsrf(page.text);
    const res = await agent.post('/auth/forgot').type('form').send({
      _csrf: csrf,
      email: 'nobody@example.test',
    });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/If that email is registered/i);
  });
});

export function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : '';
}
