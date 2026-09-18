import { db, auth } from '../db.js';
import * as svc from '../services.js';
import { esc, initials, icon } from '../ui.js';
import { backgroundBalls } from './auth-balls.js';

// The theatrical "front door": dark/gold atmosphere, deliberately unlike the ivory app behind it.
// The card content differs per state (sign-in form, first-run setup, demo picker, pending), but
// they all share this shell so the brand identity is consistent across every screen before login.
const frame = (inner) => `
  <div class="gb-auth">
    ${backgroundBalls()}
    <div class="gb-content">
      <div class="gb-logo">
        <img src="assets/logo-golden-break.png" alt="Golden Break Billiard Hall" width="380" height="167">
      </div>
      <div class="gb-card">${inner}</div>
    </div>
    <p class="gb-footer">Golden Break Billiard Hall · Davao Region, Philippines</p>
  </div>`;

export async function renderAuth(root) {
  if (auth.demo) return renderDemo(root);
  root.innerHTML = frame('<div class="empty" role="status" data-auth-pending><span class="spinner" aria-hidden="true"></span><p>Checking hall setup…</p></div>');
  let setupDone = true;
  try { setupDone = await auth.isSetupDone(); } catch { /* fall back to sign-in */ }
  if (!root.querySelector('[data-auth-pending]')) return; // someone signed in meanwhile
  if (setupDone) renderLogin(root); else renderSetup(root);
}

function wireForm(root, handler) {
  const form = root.querySelector('form');
  const err = form.querySelector('.gb-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    err.hidden = true;
    try {
      await handler(new FormData(form));
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      if (btn.isConnected) btn.disabled = false;
    }
  });
  form.querySelector('input')?.focus();
}

/** Wires the eye/eye-off button next to a password field to toggle its visibility. */
function wirePasswordToggle(root, inputId) {
  const input = root.querySelector(`#${inputId}`);
  const btn = root.querySelector(`[data-toggle-for="${inputId}"]`);
  btn?.addEventListener('click', () => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    btn.innerHTML = icon(shown ? 'eye' : 'eyeOff');
    btn.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
    btn.setAttribute('aria-pressed', String(!shown));
  });
}

const passwordField = (id, label, { autocomplete, hint = '' } = {}) => `
  <div class="gb-field gb-field--password">
    <label for="${id}">${label}</label>
    <span class="gb-field__icon">${icon('lock')}</span>
    <input id="${id}" name="password" type="password" autocomplete="${autocomplete}" placeholder="${esc(label)}" ${hint ? `minlength="6"` : ''} required>
    <button type="button" class="gb-field__toggle" data-toggle-for="${id}" aria-label="Show password" aria-pressed="false">${icon('eye')}</button>
  </div>
  ${hint ? `<p class="gb-card__sub" style="margin-top:-8px">${hint}</p>` : ''}`;

export function renderLogin(root) {
  root.innerHTML = frame(`
    <div class="gb-card__head">
      <h1 class="gb-card__title">Welcome back</h1>
      <p class="gb-card__sub">Sign in to manage the hall</p>
    </div>
    <form class="gb-form" novalidate>
      <div class="gb-field">
        <label for="login-email">Staff ID or email</label>
        <span class="gb-field__icon">${icon('person')}</span>
        <input id="login-email" name="email" type="email" autocomplete="username" placeholder="Staff ID or email" required>
      </div>
      ${passwordField('login-pass', 'Password', { autocomplete: 'current-password' })}
      <div class="gb-row">
        <label class="gb-remember">
          <input type="checkbox" name="remember" checked>
          <span>Remember me</span>
        </label>
        <button type="button" class="gb-forgot" data-action="forgot">Forgot password?</button>
      </div>
      <p class="gb-error" role="alert" hidden></p>
      <button type="submit" class="gb-submit">Sign In</button>
    </form>`);
  wirePasswordToggle(root, 'login-pass');
  wireForm(root, (fd) => auth.signIn(String(fd.get('email')).trim(), String(fd.get('password')), { remember: fd.get('remember') === 'on' }));
  root.querySelector('[data-action=forgot]').addEventListener('click', () => forgotPasswordDialog(root));
}

/** A lightweight in-shell prompt (not the app's own dialog system, which is styled for the light app). */
function forgotPasswordDialog(root) {
  const prefill = root.querySelector('#login-email')?.value.trim() || '';
  const card = root.querySelector('.gb-card');
  card.innerHTML = `
    <div class="gb-card__head">
      <h1 class="gb-card__title">Reset password</h1>
      <p class="gb-card__sub">We’ll email a reset link to your account.</p>
    </div>
    <form class="gb-form" novalidate>
      <div class="gb-field">
        <label for="reset-email">Email</label>
        <span class="gb-field__icon">${icon('mail')}</span>
        <input id="reset-email" name="email" type="email" autocomplete="username" placeholder="Email" value="${esc(prefill)}" required>
      </div>
      <p class="gb-error" role="alert" hidden></p>
      <button type="submit" class="gb-submit">Send reset link</button>
      <button type="button" class="gb-secondary" data-action="back">${icon('arrowLeft')}Back to sign in</button>
    </form>`;
  card.querySelector('[data-action=back]').addEventListener('click', () => renderLogin(root));
  wireForm(root, async (fd) => {
    await auth.sendPasswordReset(String(fd.get('email')).trim());
    card.innerHTML = `
      <div class="gb-card__head">
        <h1 class="gb-card__title">Check your email</h1>
        <p class="gb-card__sub">If an account exists for that address, a reset link is on its way.</p>
      </div>
      <button type="button" class="gb-secondary" data-action="back">${icon('arrowLeft')}Back to sign in</button>`;
    card.querySelector('[data-action=back]').addEventListener('click', () => renderLogin(root));
  });
}

function renderSetup(root) {
  root.innerHTML = frame(`
    <div class="gb-card__head">
      <h1 class="gb-card__title">Set up your hall</h1>
      <p class="gb-card__sub">No owner account exists yet. Create it now — you can add cashiers afterwards.</p>
    </div>
    <form class="gb-form" novalidate>
      <div class="gb-field">
        <label for="setup-name">Your name</label>
        <span class="gb-field__icon">${icon('person')}</span>
        <input id="setup-name" name="name" autocomplete="name" placeholder="Your name" required maxlength="60">
      </div>
      <div class="gb-field">
        <label for="setup-email">Email</label>
        <span class="gb-field__icon">${icon('mail')}</span>
        <input id="setup-email" name="email" type="email" autocomplete="username" placeholder="Email" required>
      </div>
      ${passwordField('setup-pass', 'Password', { autocomplete: 'new-password', hint: 'At least 6 characters.' })}
      <p class="gb-error" role="alert" hidden></p>
      <button type="submit" class="gb-submit">Create owner account</button>
    </form>`);
  wirePasswordToggle(root, 'setup-pass');
  wireForm(root, async (fd) => {
    const name = String(fd.get('name')).trim();
    const password = String(fd.get('password'));
    if (!name) throw new Error('Your name is required.');
    if (password.length < 6) throw new Error('Password must be at least 6 characters.');
    await svc.setupOwner({ name, email: String(fd.get('email')).trim(), password });
  });
}

function renderDemo(root) {
  root.innerHTML = frame(`
    <div class="gb-card__head">
      <h1 class="gb-card__title">Choose an account</h1>
      <p class="gb-card__sub">Demo mode: data lives in this browser and syncs live between tabs. Add your Firebase config in <code>js/firebase-config.js</code> to go live.</p>
    </div>
    <ul class="gb-list" data-region="accounts" aria-label="Demo accounts"></ul>
    <button type="button" class="gb-secondary" data-action="reset">${icon('restock')}Reset demo data</button>`);
  const list = root.querySelector('[data-region=accounts]');
  const off = db.listen('users', (users) => {
    if (!list.isConnected) { off(); return; }
    users.sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.name.localeCompare(b.name)));
    list.innerHTML = users.filter((u) => u.active !== false).map((u) => `
      <li>
        <button type="button" class="gb-account" data-uid="${esc(u.id)}">
          <span class="gb-avatar" aria-hidden="true">${esc(initials(u.name))}</span>
          <span class="gb-account__text">
            <span class="gb-account__name">${esc(u.name)}</span>
            <span class="gb-account__role">${u.role === 'owner' ? 'Owner · full access' : 'Cashier'}</span>
          </span>
          <span class="gb-account__go" aria-hidden="true">Sign in</span>
        </button>
      </li>`).join('');
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-uid]');
    if (b) { off(); auth.signInAs(b.dataset.uid); }
  });
  root.querySelector('[data-action=reset]').addEventListener('click', () => auth.resetDemo());
}

export function renderPending(root, authUser) {
  root.innerHTML = frame(`
    <div class="gb-card__head">
      <h1 class="gb-card__title">Almost there</h1>
      <p class="gb-card__sub">You’re signed in as <strong>${esc(authUser.email)}</strong>, but this login isn’t linked to a staff profile yet. If you just created the owner account, this will update in a moment. Otherwise ask the owner to add you.</p>
    </div>
    <button type="button" class="gb-secondary" data-action="sign-out">${icon('logout')}Sign out</button>`);
  root.querySelector('[data-action=sign-out]').addEventListener('click', () => auth.signOut());
}
