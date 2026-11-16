const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function form(provider, proof = 'encoded-proof') {
  const inputs = Object.fromEntries(Object.entries({
    name: 'Test User', mail: 'test@example.com', subject: 'Question', comment: 'Hello',
  }).map(([id, value]) => [id, { value }]));
  const state = { requests: [], resets: 0, tokens: 0, text: '', disabled: false };
  const meta = value => value === undefined ? null : { getAttribute: () => value };
  const document = {
    querySelector: selector => ({
      'meta[name="contact-api"]': meta('https://example.com/contact'),
      'meta[name="recaptcha-site-key"]': meta('test-site-key'),
      'meta[name="captcha-provider"]': meta(provider),
      'input[name="altcha"]': { value: proof },
      'altcha-widget': { reset: () => { state.resets++; } },
    })[selector] || null,
    getElementById: id => inputs[id],
  };
  function $(selector) {
    if (typeof selector === 'function') { selector(); return; }
    const control = {
      val: () => inputs[selector.slice(1)].value,
      html: value => value === undefined ? 'Send Message' : control,
      prop: (name, value) => { if (name === 'disabled') state.disabled = value; return control; },
      text: value => { if (selector === '#message') state.text = value; return control; },
      css: () => control, attr: () => control, removeAttr: () => control, focus: () => control,
      on: (event, listener) => { state.submit = listener; return control; },
    };
    return control;
  }
  $.ajax = options => { state.requests.push(options); };
  const grecaptcha = { enterprise: {
    ready: callback => callback(),
    execute: async () => { state.tokens++; return 'recaptcha-token'; },
  } };
  const context = vm.createContext({ document, $, window: { grecaptcha }, grecaptcha, console,
    alert: () => { throw new Error('Unexpected validation alert'); } });
  vm.runInContext(readFileSync(join(__dirname, '../../website/js/contact-form.js'), 'utf8'), context);
  return { state, inputs, submit: () => state.submit({ preventDefault() {} }) };
}

test('ALTCHA form posts its proof without requesting a reCAPTCHA token', () => {
  const { state, inputs, submit } = form('altcha');
  submit();
  assert.equal(state.requests.length, 1);
  assert.equal(state.tokens, 0);
  assert.equal(state.disabled, true);
  const request = state.requests[0];
  const body = JSON.parse(request.data);
  assert.equal(body.altcha, 'encoded-proof');
  assert.equal(body.recaptchaToken, undefined);
  assert.equal(request.url, 'https://example.com/contact');
  request.success({ message: 'Sent' });
  assert.equal(state.text, 'Sent');
  assert.equal(inputs.name.value, '');
  assert.equal(state.resets, 1);
  assert.equal(state.disabled, false);
});

test('missing ALTCHA proof prevents submission and displays verification prompt', () => {
  const { state, submit } = form('altcha', '');
  submit();
  assert.equal(state.requests.length, 0);
  assert.match(state.text, /complete the verification/i);
  assert.equal(state.tokens, 0);
});

test('failed request preserves fields and refreshes the single-use proof for retry', () => {
  const { state, inputs, submit } = form('altcha');
  submit();
  state.requests[0].error({ responseText: JSON.stringify({ message: 'Please retry' }) });
  assert.equal(state.text, 'Please retry');
  assert.equal(inputs.name.value, 'Test User');
  assert.equal(state.resets, 1);
  assert.equal(state.disabled, false);
});

test('missing provider metadata retains the existing reCAPTCHA flow', async () => {
  const { state, submit } = form(undefined);
  submit();
  await new Promise(setImmediate);
  assert.equal(state.tokens, 1);
  const body = JSON.parse(state.requests[0].data);
  assert.equal(body.recaptchaToken, 'recaptcha-token');
  assert.equal(body.altcha, undefined);
});

test('unsupported provider never submits', () => {
  const { state, submit } = form('off');
  submit();
  assert.equal(state.requests.length, 0);
  assert.match(state.text, /not configured/i);
});
