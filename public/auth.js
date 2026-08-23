// public/auth.js - ekran logowania, rejestracji na zaproszenie i zalozenia pierwszego konta.
import { api, $, toast } from './ui.js';
import { t, applyStatic, languageSwitcher, errorText } from './i18n.js';

const ui = {
  title: $('#title'),
  subtitle: $('#subtitle'),
  error: $('#error'),
  form: $('#form'),
  submit: $('#submit'),
  toggle: $('#toggle'),
  wrapName: $('#wrap-name'),
  wrapInvite: $('#wrap-invite'),
  passwordHint: $('#password-hint'),
};

let mode = 'login';          // login | register | bootstrap
let inviteRequired = false;
let lastError = null;

/** Kod zaproszenia moze przyjsc w linku: login.html#invite=XYZ */
function inviteFromHash() {
  const match = /invite=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  return match ? match[1] : '';
}

/** Blad trzymamy jako obiekt, zeby po zmianie jezyka przetlumaczyc go ponownie po kodzie. */
function showError(err) {
  lastError = err?.code ? { code: err.code, details: err.details, fallback: err.message } : null;
  ui.error.textContent = lastError
    ? errorText(lastError.code, lastError.fallback, lastError.details)
    : String(err?.message ?? err);
  ui.error.classList.remove('hidden');
}

function clearError() {
  lastError = null;
  ui.error.classList.add('hidden');
}

/** Jedno miejsce, w ktorym ekran dostosowuje sie do trybu i jezyka. */
function applyMode() {
  applyStatic();
  const isRegister = mode !== 'login';
  ui.wrapName.classList.toggle('hidden', !isRegister);
  ui.wrapInvite.classList.toggle('hidden', !(mode === 'register' && inviteRequired));
  ui.form.password.setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
  ui.passwordHint.textContent = isRegister ? t('auth.passwordHint') : '';

  if (mode === 'bootstrap') {
    ui.title.textContent = t('auth.bootstrapTitle');
    ui.subtitle.textContent = t('auth.bootstrapLead');
    ui.submit.textContent = t('auth.bootstrapSubmit');
    ui.toggle.classList.add('hidden');
  } else if (mode === 'register') {
    ui.title.textContent = t('auth.register');
    ui.subtitle.textContent = inviteRequired ? t('auth.registerInvite') : t('auth.registerOpen');
    ui.submit.textContent = t('auth.register');
    ui.toggle.textContent = t('auth.toLogin');
    ui.toggle.classList.remove('hidden');
  } else {
    ui.title.textContent = t('app.title');
    ui.subtitle.textContent = t('auth.signInPrompt');
    ui.submit.textContent = t('auth.signIn');
    ui.toggle.textContent = t('auth.toRegister');
    ui.toggle.classList.remove('hidden');
  }
}

async function boot() {
  $('#lang-switch').append(languageSwitcher(() => {
    applyMode();
    // Widoczny komunikat bledu tez musi zmienic jezyk.
    if (lastError) {
      ui.error.textContent = errorText(lastError.code, lastError.fallback, lastError.details);
    }
  }));

  // Jesli sesja jest wciaz wazna, nie pokazujemy formularza.
  try {
    await api('/auth/me', { redirectOn401: false });
    window.location.href = './';
    return;
  } catch { /* brak sesji - normalna sciezka */ }

  try {
    const status = await api('/auth/bootstrap');
    inviteRequired = status.inviteRequired;
    const invite = inviteFromHash();
    if (status.needsBootstrap) mode = 'bootstrap';
    else if (invite) { mode = 'register'; ui.form.inviteCode.value = invite; }
    applyMode();
    ui.form.classList.remove('hidden');
  } catch (err) {
    ui.error.textContent = t('auth.serverUnavailable', { error: err.message });
    ui.error.classList.remove('hidden');
    ui.subtitle.textContent = '';
  }
}

ui.toggle.addEventListener('click', () => {
  mode = mode === 'login' ? 'register' : 'login';
  applyMode();
});

ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  ui.submit.disabled = true;
  const data = Object.fromEntries(new FormData(ui.form).entries());

  try {
    if (mode === 'login') {
      await api('/auth/login', {
        method: 'POST',
        redirectOn401: false,
        body: { email: data.email, password: data.password },
      });
    } else {
      await api('/auth/register', {
        method: 'POST',
        redirectOn401: false,
        body: {
          email: data.email,
          password: data.password,
          displayName: data.displayName,
          inviteCode: data.inviteCode || undefined,
        },
      });
    }
    toast(t('auth.signedIn'), 'success', 1500);
    window.location.href = './';
  } catch (err) {
    showError(err);
  } finally {
    ui.submit.disabled = false;
  }
});

boot();
