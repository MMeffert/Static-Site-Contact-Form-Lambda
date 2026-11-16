const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { SESClient } = require('@aws-sdk/client-ses');
const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { handler } = require('../contact-form.js');

const key = 'test-only-hmac-key';
const originalEnv = { ...process.env };
let sends, secrets, writes, consumed, storageFailure, secretValue, recaptcha, requests;

function proof({ expires = Math.floor(Date.now() / 1000) + 300, signingKey = key } = {}) {
  const salt = randomBytes(12).toString('hex') + (expires === null ? '&' : `?expires=${expires}&`);
  const number = 42;
  const challenge = createHash('sha256').update(salt + number).digest('hex');
  const signature = createHmac('sha256', signingKey).update(challenge).digest('hex');
  return { algorithm: 'SHA-256', salt, number, challenge, signature };
}
const encode = payload => Buffer.from(JSON.stringify(payload)).toString('base64');
const event = (altcha, extra = {}) => ({
  httpMethod: 'POST', headers: { origin: 'https://yourdomain.com' },
  body: JSON.stringify({ name: 'Test User', email: 'test@example.com', message: 'Hello', altcha, ...extra }),
});

beforeEach(t => {
  sends = []; secrets = []; writes = []; consumed = new Set(); storageFailure = null;
  secretValue = JSON.stringify({ hmacKey: key }); requests = 0;
  recaptcha = { tokenProperties: { valid: true, action: 'submit' }, riskAnalysis: { score: 0.9 } };
  process.env.CAPTCHA_PROVIDER = 'altcha';
  process.env.ALTCHA_SECRET_ARN = 'test/altcha';
  process.env.ALTCHA_CHALLENGE_TABLE = 'test-used-challenges';
  process.env.RECAPTCHA_SECRET_ARN = 'test/recaptcha';
  process.env.FROM_EMAIL = process.env.TO_EMAIL = 'test@example.com';
  t.mock.method(SESClient.prototype, 'send', async command => { sends.push(command.input); return {}; });
  t.mock.method(SecretsManagerClient.prototype, 'send', async command => {
    secrets.push(command.input.SecretId);
    return { SecretString: command.input.SecretId === 'test/recaptcha'
      ? JSON.stringify({ apiKey: 'test-api', projectId: 'test-project', siteKey: 'test-site' }) : secretValue };
  });
  t.mock.method(DynamoDBClient.prototype, 'send', async command => {
    if (storageFailure) throw storageFailure;
    const input = command.input;
    writes.push(input);
    // Model DynamoDB's atomic conditional put rather than allowing duplicate consumption.
    if (consumed.has(input.Item.challenge.S)) {
      throw Object.assign(new Error('Already consumed'), { name: 'ConditionalCheckFailedException' });
    }
    consumed.add(input.Item.challenge.S);
    return {};
  });
  t.mock.method(https, 'request', (options, callback) => {
    requests++;
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      callback(response);
      response.emit('data', JSON.stringify(recaptcha));
      response.emit('end');
    });
    return request;
  });
});
afterEach(() => {
  for (const name of ['CAPTCHA_PROVIDER', 'ALTCHA_SECRET_ARN', 'ALTCHA_CHALLENGE_TABLE',
    'RECAPTCHA_SECRET_ARN', 'FROM_EMAIL', 'TO_EMAIL']) {
    if (originalEnv[name] === undefined) delete process.env[name]; else process.env[name] = originalEnv[name];
  }
});

test('valid ALTCHA proof sends email only after atomic consumption', async () => {
  const payload = proof();
  assert.equal((await handler(event(encode(payload)))).statusCode, 200);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].ReplyToAddresses[0], 'test@example.com');
  assert.deepEqual(secrets, ['test/altcha']);
  assert.equal(requests, 0);
  assert.equal(writes[0].TableName, 'test-used-challenges');
  assert.equal(writes[0].ConditionExpression, 'attribute_not_exists(challenge)');
  assert.equal(writes[0].Item.expires.N, new URLSearchParams(payload.salt.split('?')[1]).get('expires'));
});

for (const [name, makePayload] of [
  ['missing', () => undefined], ['malformed base64', () => 'not base64!'],
  ['non-object JSON', () => encode(null)], ['oversized', () => 'A'.repeat(8193)],
  ['wrong key', () => encode(proof({ signingKey: 'wrong-key' }))],
  ['wrong answer', () => encode({ ...proof(), number: 43 })],
  ['tampered salt', () => encode({ ...proof(), salt: 'tampered?expires=9999999999' })],
  ['expired', () => encode(proof({ expires: Math.floor(Date.now() / 1000) - 60 }))],
  ['without expiration', () => encode(proof({ expires: null }))],
  ['unsupported algorithm', () => encode({ ...proof(), algorithm: 'SHA-1' })],
  ['non-integer answer', () => encode({ ...proof(), number: 4.2 })],
]) {
  test(`rejects ${name} ALTCHA proof without sending or falling back to reCAPTCHA`, async () => {
    assert.equal((await handler(event(makePayload(), { recaptchaToken: 'legacy-token' }))).statusCode, 400);
    assert.equal(sends.length, 0);
    assert.equal(writes.length, 0);
    assert.equal(requests, 0);
  });
}

test('a replay cannot send a second email', async () => {
  const request = event(encode(proof()));
  assert.equal((await handler(request)).statusCode, 200);
  assert.equal((await handler(request)).statusCode, 400);
  assert.equal(sends.length, 1);
});

test('concurrent reuse sends at most one email', async () => {
  const request = event(encode(proof()));
  const responses = await Promise.all([handler(request), handler(request)]);
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 400]);
  assert.equal(sends.length, 1);
});

test('a storage failure fails closed', async () => {
  storageFailure = new Error('Storage unavailable');
  assert.equal((await handler(event(encode(proof())))).statusCode, 500);
  assert.equal(sends.length, 0);
});

for (const variable of ['ALTCHA_SECRET_ARN', 'ALTCHA_CHALLENGE_TABLE']) {
  test(`missing ${variable} fails closed`, async () => {
    delete process.env[variable];
    assert.equal((await handler(event(encode(proof())))).statusCode, 500);
    assert.equal(sends.length, 0);
  });
}

test('empty signing key fails closed', async () => {
  secretValue = JSON.stringify({ hmacKey: '' });
  assert.equal((await handler(event(encode(proof())))).statusCode, 500);
  assert.equal(sends.length, 0);
});

test('an unknown provider cannot disable CAPTCHA validation', async () => {
  process.env.CAPTCHA_PROVIDER = 'off';
  assert.equal((await handler(event(encode(proof())))).statusCode, 500);
  assert.equal(sends.length, 0);
});

test('existing deployments still validate reCAPTCHA when no provider is set', async () => {
  delete process.env.CAPTCHA_PROVIDER;
  assert.equal((await handler(event(undefined, { recaptchaToken: 'legacy-token' }))).statusCode, 200);
  assert.deepEqual(secrets, ['test/recaptcha']);
  assert.equal(requests, 1);
  assert.equal(writes.length, 0);
  assert.equal(sends.length, 1);
});

test('existing reCAPTCHA action validation is preserved', async () => {
  process.env.CAPTCHA_PROVIDER = 'recaptcha';
  recaptcha.tokenProperties.action = 'wrong-action';
  assert.equal((await handler(event(undefined, { recaptchaToken: 'legacy-token' }))).statusCode, 400);
  assert.equal(sends.length, 0);
});

test('preflight responds without consulting AWS or sending email', async () => {
  const response = await handler({ httpMethod: 'OPTIONS', headers: { origin: 'https://yourdomain.com' } });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://yourdomain.com');
  assert.equal(sends.length + secrets.length + writes.length, 0);
});

test('challenge endpoint creates an expiring proof the verifier accepts', async () => {
  const response = await handler({ httpMethod: 'GET', path: '/contact/challenge', headers: {} });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  const challenge = JSON.parse(response.body);
  const expires = Number(new URLSearchParams(challenge.salt.split('?')[1]).get('expires'));
  assert.ok(expires > Date.now() / 1000 && expires <= Date.now() / 1000 + 300);
  assert.equal(writes.length + sends.length, 0);
  const { solveChallenge } = await import('altcha-lib/v1');
  const solution = await solveChallenge(challenge.challenge, challenge.salt, challenge.algorithm, challenge.maxnumber).promise;
  assert.ok(solution);
  assert.equal((await handler(event(encode({ ...challenge, number: solution.number })))).statusCode, 200);
  assert.equal(sends.length, 1);
});

test('unsupported request methods do not send email', async () => {
  assert.equal((await handler({ httpMethod: 'GET', path: '/other', headers: {} })).statusCode, 405);
  assert.equal(sends.length + secrets.length + writes.length, 0);
});

for (const [name, subject] of [
  ['CRLF', 'Question\r\nBcc: other@example.com'],
  ['line feed', 'Question\nSecond line'],
  ['null byte', 'Question\0'],
  ['non-string', { text: 'Question' }],
  ['overlong', 'x'.repeat(201)],
]) {
  test(`rejects ${name} subject before verification or email delivery`, async () => {
    const response = await handler(event(encode(proof()), { subject }));
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).message, 'Invalid subject');
    assert.equal(secrets.length + writes.length + sends.length, 0);
  });
}

test('a valid Unicode subject within the length limit is delivered intact', async () => {
  const subject = 'Résumé: ' + 'é'.repeat(192);
  assert.equal(subject.length, 200);
  assert.equal((await handler(event(encode(proof()), { subject }))).statusCode, 200);
  assert.equal(sends[0].Message.Subject.Data, 'Contact Form: ' + subject);
});
