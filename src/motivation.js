import {
  getUser, handleAuthCallback, login, logout, requestPasswordRecovery, signup, updateUser,
} from '@netlify/identity';

const byId = (id) => document.getElementById(id);
const apiPath = '/api/motivation';
const maxFileBytes = 20 * 1024 * 1024;
const categories = {
  affirmation: { label: 'Affirmation', mark: '✦', plural: 'affirmations' },
  song: { label: 'Song', mark: '♫', plural: 'songs', formats: '.mp3,.m4a,.wav', hint: 'MP3, M4A, or WAV' },
  video: { label: 'Video', mark: '▷', plural: 'videos', formats: '.mp4,.webm', hint: 'MP4 or WebM' },
};

const authForm = byId('auth-form');
const authSubmit = byId('auth-submit');
const signOut = byId('logout');
const email = byId('email');
const password = byId('password');
const library = byId('library');
const itemsGrid = byId('items');
const filters = byId('filters');
const editor = byId('editor');
const itemForm = byId('item-form');
const categoryField = byId('category');
const sourceField = byId('source');
const affirmationField = byId('affirmation');
const linkField = byId('link');
const fileField = byId('file');
const saveItem = byId('save-item');
let authMode = 'login';
let filter = 'all';
let items = [];
let loadSequence = 0;
let loaded = false;

function message(id, text, error = false) {
  const target = byId(id);
  target.textContent = text;
  target.classList.toggle('error', error);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function setAuthMode(mode) {
  authMode = mode;
  const recovery = mode === 'recover';
  const reset = mode === 'reset';
  const creating = mode === 'signup';
  byId('email-row').hidden = reset;
  email.disabled = reset;
  byId('password-row').hidden = recovery;
  password.disabled = recovery;
  password.value = '';
  password.minLength = creating || reset ? 8 : 0;
  password.autocomplete = creating || reset ? 'new-password' : 'current-password';
  byId('auth-alternate').hidden = reset;
  byId('auth-alternate').textContent = mode === 'login' ? 'Create an account' : 'Back to sign in';
  byId('auth-recover').hidden = mode !== 'login';
  authSubmit.textContent = { login: 'Sign in', signup: 'Create account', recover: 'Send reset link', reset: 'Save new password' }[mode];
  byId('auth-title').textContent = { login: 'Make this shelf yours.', signup: 'Create your account.', recover: 'Reset your password.', reset: 'Choose a new password.' }[mode];
  const description = byId('auth-description');
  description.lang = mode === 'login' ? 'hi-Latn' : 'en';
  description.textContent = {
    login: 'Sign in karo aur apni shelf kisi bhi device par kholo. Jo save karoge, woh sirf tumhe dikhega.',
    signup: 'Use your email to keep your shelf private and open it on any device.',
    recover: 'Enter your account email to receive a password reset link.',
    reset: 'Use at least eight characters for your new password.',
  }[mode];
  message('auth-message', '');
}

function showAuth(text = '', error = false) {
  loadSequence++;
  items = [];
  loaded = false;
  itemsGrid.replaceChildren();
  if (editor.open) editor.close();
  library.hidden = true;
  signOut.hidden = true;
  byId('account').hidden = false;
  authForm.hidden = false;
  byId('session-status').hidden = true;
  setAuthMode('login');
  message('auth-message', text, error);
}

function showLibrary() {
  authForm.reset();
  byId('account').hidden = true;
  library.hidden = false;
  signOut.hidden = false;
  setFilter('all');
  return loadItems();
}

function authError(error) {
  if (error.status === 429) return 'Too many attempts. Please wait and try again.';
  if (authMode === 'login' && [400, 401, 422].includes(error.status)) return 'Check your email and password, and confirm your email if you just signed up.';
  if (authMode === 'signup' && error.status === 403) return 'Account creation is not available right now.';
  return 'That didn’t work. Check your details and try again.';
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authSubmit.disabled = true;
  byId('auth-alternate').disabled = true;
  byId('auth-recover').disabled = true;
  message('auth-message', 'One moment…');
  try {
    if (authMode === 'signup') {
      await signup(email.value.trim(), password.value);
      if (await getUser()) await showLibrary();
      else {
        setAuthMode('login');
        message('auth-message', 'Check your email to confirm your account, then sign in.');
      }
    } else if (authMode === 'recover') {
      try {
        await requestPasswordRecovery(email.value.trim());
      } catch (error) {
        if (![400, 404].includes(error.status)) throw error;
      }
      setAuthMode('login');
      message('auth-message', 'If there’s an account for that address, a reset link is on its way.');
    } else if (authMode === 'reset') {
      await updateUser({ password: password.value });
      await showLibrary();
    } else {
      await login(email.value.trim(), password.value);
      await showLibrary();
    }
  } catch (error) {
    message('auth-message', authError(error), true);
  } finally {
    authSubmit.disabled = false;
    byId('auth-alternate').disabled = false;
    byId('auth-recover').disabled = false;
  }
});

byId('auth-alternate').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
byId('auth-recover').addEventListener('click', () => { setAuthMode('recover'); email.focus(); });
signOut.addEventListener('click', async () => {
  signOut.disabled = true;
  try {
    await logout();
    showAuth('You’re signed out.');
  } catch {
    message('library-status', 'Couldn’t sign out. Please try again.', true);
  } finally {
    signOut.disabled = false;
  }
});

async function api(path = '', options) {
  const response = await fetch(`${apiPath}${path}`, { ...options, credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) {
    showAuth('Sign in again to open your shelf.', true);
    throw new Error('Your session expired.');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? 'The shelf is unavailable. Please try again.');
  return data;
}

async function loadItems() {
  const sequence = ++loadSequence;
  byId('retry').hidden = true;
  message('library-status', 'Opening your shelf…');
  try {
    const result = await api();
    if (sequence !== loadSequence) return;
    if (!Array.isArray(result)) throw new Error('The shelf didn’t load. Please try again.');
    items = result;
    loaded = true;
    message('library-status', '');
    renderItems();
  } catch (error) {
    if (sequence !== loadSequence) return;
    message('library-status', error.message, true);
    byId('retry').hidden = false;
  }
}

function setFilter(next) {
  filter = next;
  for (const button of filters.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  if (loaded) renderItems();
}

function renderItems() {
  const visible = filter === 'all' ? items : items.filter((item) => item.category === filter);
  if (!visible.length) {
    const empty = element('div', 'empty panel');
    const mark = element('span', 'empty-icon', '✧');
    mark.setAttribute('aria-hidden', 'true');
    const title = filter === 'all' ? 'A little room for good things.' : `No ${categories[filter].plural} yet.`;
    const button = element('button', 'text-button', 'Add your first item');
    button.type = 'button';
    button.addEventListener('click', openEditor);
    empty.append(mark, element('h3', '', title), element('p', '', 'Save something you want to come back to.'), button);
    itemsGrid.replaceChildren(empty);
    return;
  }
  itemsGrid.replaceChildren(...visible.map(renderItem));
}

function renderItem(item) {
  const info = categories[item.category];
  const card = element('article', 'item panel');
  const top = element('div', 'item-top');
  const remove = element('button', 'icon-button', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${item.title}`);
  remove.addEventListener('click', () => removeItem(item, remove));
  top.append(element('span', 'category-tag', `${info.mark} ${info.label}`), remove);
  card.append(top, element('h3', '', item.title));
  if (item.kind === 'text') card.append(element('p', 'affirmation', item.content));
  else if (item.kind === 'link') {
    const link = element('a', 'text-button media-action', 'Open saved link ↗');
    link.href = item.content;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    card.append(link);
  } else {
    const media = element(item.category === 'song' ? 'audio' : 'video');
    media.controls = true;
    media.preload = 'none';
    media.playsInline = true;
    media.src = `${apiPath}/${item.id}/media`;
    media.setAttribute('aria-label', item.title);
    media.addEventListener('error', () => {
      card.append(element('p', 'message error', 'Can’t play this file. Try reloading or uploading a different format.'));
    }, { once: true });
    card.append(media);
  }
  return card;
}

async function removeItem(item, button) {
  if (!window.confirm(`Remove “${item.title}” from your shelf?`)) return;
  button.disabled = true;
  try {
    await api(`/${item.id}`, { method: 'DELETE' });
    items = items.filter((entry) => entry.id !== item.id);
    renderItems();
    message('library-status', 'Removed from your shelf.');
    byId('add').focus();
  } catch (error) {
    message('library-status', error.message, true);
  } finally {
    button.disabled = false;
  }
}

function syncEditor() {
  const category = categoryField.value;
  const isText = category === 'affirmation';
  const isLink = !isText && sourceField.value === 'link';
  const isFile = !isText && !isLink;
  const fields = [
    [affirmationField, byId('text-row'), isText],
    [linkField, byId('link-row'), isLink],
    [fileField, byId('file-row'), isFile],
  ];
  for (const [field, row, active] of fields) {
    row.hidden = !active;
    field.disabled = !active;
    field.required = active;
  }
  byId('source-row').hidden = isText;
  if (isFile) {
    fileField.accept = categories[category].formats;
    byId('file-help').textContent = `${categories[category].hint} · Max 20 MB. For larger files, save a link instead.`;
  }
}

function openEditor() {
  itemForm.reset();
  categoryField.value = filter === 'all' ? 'affirmation' : filter;
  message('item-message', '');
  syncEditor();
  editor.showModal();
}

itemForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = itemForm.elements.title.value.trim();
  const category = categoryField.value;
  const uploading = category !== 'affirmation' && sourceField.value === 'file';
  let options;
  if (uploading) {
    const file = fileField.files[0];
    if (!file?.size || file.size > maxFileBytes) {
      message('item-message', 'Choose a file under 20 MB, or save a link instead.', true);
      return;
    }
    options = { method: 'POST', headers: { 'X-Motivation-Upload': category, 'X-Motivation-Title': encodeURIComponent(title.toWellFormed?.() ?? title) }, body: file };
  } else {
    const content = category === 'affirmation' ? affirmationField.value : linkField.value;
    options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, category, content }) };
  }
  saveItem.disabled = true;
  byId('close-editor').disabled = true;
  message('item-message', uploading ? 'Uploading… keep this tab open.' : 'Saving to your shelf…');
  try {
    const saved = await api('', options);
    if (!saved?.id) throw new Error('The item couldn’t be saved. Please try again.');
    editor.close();
    if (loaded) {
      items.unshift(saved);
      setFilter(filter === 'all' ? 'all' : saved.category);
      message('library-status', 'Saved to your shelf.');
    } else {
      await loadItems();
    }
  } catch (error) {
    message('item-message', error.message, true);
  } finally {
    saveItem.disabled = false;
    byId('close-editor').disabled = false;
  }
});

editor.addEventListener('cancel', (event) => { if (saveItem.disabled) event.preventDefault(); });
byId('close-editor').addEventListener('click', () => editor.close());
categoryField.addEventListener('change', () => { fileField.value = ''; syncEditor(); });
sourceField.addEventListener('change', syncEditor);
byId('add').addEventListener('click', openEditor);
byId('retry').addEventListener('click', loadItems);
filters.addEventListener('click', (event) => {
  const next = event.target.closest('button')?.dataset.filter;
  if (next) setFilter(next);
});

async function start() {
  try {
    const callback = await handleAuthCallback();
    if (callback?.type === 'recovery') {
      showAuth();
      setAuthMode('reset');
      return;
    }
    if (await getUser()) await showLibrary();
    else showAuth();
  } catch {
    history.replaceState(null, '', location.pathname + location.search);
    showAuth('This email link is invalid or expired. Sign in or request a new reset link.', true);
  }
}

start();
