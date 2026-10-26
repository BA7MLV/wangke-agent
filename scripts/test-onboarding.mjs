import assert from 'node:assert/strict';
import test from 'node:test';
import { errorKey, initialStep, previousStep, SETUP_STEPS, STEP_FIGURE, stepForError, stepIndex } from '../src/cloud/onboarding/flow.ts';

test('first deploy starts at welcome, later visits go straight to login', () => {
  assert.equal(initialStep({ initialized: false, authenticated: false }), 'welcome');
  assert.equal(initialStep({ initialized: true, authenticated: false }), 'login');
  assert.equal(initialStep({ initialized: true, authenticated: true }), 'configure');
});

test('back walks the setup steps and stops at the ends', () => {
  assert.equal(previousStep('account'), 'key');
  assert.equal(previousStep('key'), 'welcome');
  assert.equal(previousStep('welcome'), null);
  assert.equal(previousStep('login'), null);
  assert.equal(previousStep('configure'), null, 'admin already exists; no way back to creation');
});

test('errors send the user to the step that can fix them', () => {
  assert.equal(stepForError('account', 'invalid_or_expired_bootstrap_secret'), 'key');
  assert.equal(stepForError('account', 'bootstrap_closed'), 'login');
  assert.equal(stepForError('account', 'admin_password_must_be_12_to_256_characters'), 'account');
  assert.equal(stepForError('login', 'invalid_credentials'), 'login');
});

test('known errors are translated, unknown ones pass through', () => {
  assert.equal(errorKey('invalid_credentials'), 'invalid_credentials');
  assert.equal(errorKey('http_502'), null);
});

test('progress dots cover only the setup flow', () => {
  assert.deepEqual(SETUP_STEPS.map(stepIndex), [1, 2, 3, 4]);
  assert.equal(stepIndex('login'), 0);
  for (const step of [...SETUP_STEPS, 'login']) assert.ok(STEP_FIGURE[step], `${step} has a figure`);
});
