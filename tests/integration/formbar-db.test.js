import { describe, expect, it, afterEach } from 'vitest';
import { createFormbarOAuth } from '#integrations/formbar/oauth.js';
import { parseConfig } from '#config';
import { validTestEnv } from '../helpers/env.js';
import { createLogger } from '#logging/logger.js';

describe('formbar oauth', () => {
  it('rejects a state mismatch', async () => {
    const config = parseConfig(validTestEnv());
    const oauth = createFormbarOAuth({
      config,
      logger: createLogger({ level: 'silent', pretty: false }),
    });
    expect(() => oauth.assertState('abc', 'xyz')).toThrow(/state mismatch/);
  });

  it('exchanges a code without putting tokens in the query string', async () => {
    const config = parseConfig(validTestEnv());
    const calls = [];
    const oauth = createFormbarOAuth({
      config,
      logger: createLogger({ level: 'silent', pretty: false }),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          async json() {
            return {
              data: {
                access_token: [
                  'hdr',
                  Buffer.from(JSON.stringify({ id: 7, displayName: 'Pat' })).toString('base64url'),
                  'sig',
                ].join('.'),
                refresh_token: 'refresh',
              },
            };
          },
        };
      },
    });
    const tokens = await oauth.exchangeCode('the-code');
    const identity = oauth.parseIdentity(tokens);
    expect(identity.subject).toBe('7');
    expect(calls[0].url).toContain('/api/v1/oauth/token');
    expect(String(calls[0].url)).not.toContain('the-code');
  });

  it('does not enable the http example in production config', () => {
    const config = parseConfig(
      validTestEnv({
        NODE_ENV: 'production',
        EMAIL_ENABLED: 'true',
        SMTP_HOST: 'smtp.test',
        SMTP_FROM: 'noreply@test',
        DATABASE_PROVIDER: 'postgres',
        DATABASE_URL: 'postgres://u:p@localhost:5432/app',
        FORMBAR_HTTP_EXAMPLE_ENABLED: 'true',
      }),
    );
    expect(config.features.formbarHttpExample).toBe(false);
  });
});

describe('database adapter', () => {
  let ctx;
  afterEach(async () => {
    if (ctx) await ctx.close();
  });

  it('migrates sqlite and answers select 1', async () => {
    const { createTestApp } = await import('../helpers/app.js');
    ctx = await createTestApp();
    const health = await ctx.container.db.health();
    expect(health.ok).toBe(true);
    const roles = await ctx.container.db.knex('roles').select('name');
    expect(roles.map((row) => row.name).sort()).toEqual([
      'admin',
      'manager',
      'student',
      'teacher',
      'user',
    ]);
  });
});
