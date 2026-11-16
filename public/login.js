const { startRegistration, startAuthentication, browserSupportsWebAuthn } = window.SimpleWebAuthnBrowser;
const $ = (s) => document.querySelector(s);

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const say = (text, err = false) => { $('#msg').textContent = text; $('#msg').className = `msg${err ? ' err' : ''}`; };

const status = await fetch('/auth/status').then((r) => r.json());
if (status.signedIn) location.replace('/');
const setup = !status.registered;

if (setup) {
  $('#title').textContent = 'Set up your passkey';
  $('#lede').textContent = 'Enter the setup code you saved when deploying. This device will become your key.';
  $('#code-wrap').hidden = false;
  $('#go').textContent = 'Create passkey';
}
if (!browserSupportsWebAuthn()) say('This browser does not support passkeys. Try Safari, Chrome or Edge.', true);

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#go').disabled = true;
  say('');
  try {
    if (setup) {
      const { challengeId, options } = await post('/auth/register/options', { setupCode: $('#code').value });
      const response = await startRegistration({ optionsJSON: options });
      await post('/auth/register/verify', { challengeId, response, name: navigator.platform || 'First device' });
    } else {
      const { challengeId, options } = await post('/auth/login/options');
      const response = await startAuthentication({ optionsJSON: options });
      await post('/auth/login/verify', { challengeId, response });
    }
    location.replace('/');
  } catch (err) {
    say(err.name === 'NotAllowedError' ? 'Cancelled. Try again when ready.' : err.message, true);
    $('#go').disabled = false;
  }
});
