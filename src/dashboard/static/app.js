// The browserctl dashboard: polls the server's state, streams every browser's screencast into the grid, and opens a
// focused view of one browser, or the noVNC view of a sign-in session, which is the only view that sends input.

import RFB from '/dashboard/novnc/core/rfb.js';

const API = '/dashboard/api';
const POLL_MS = 3000;
const socketBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/dashboard/ws`;

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) node.append(child instanceof Node ? child : document.createTextNode(String(child ?? '')));
  return node;
}

function showError(message) {
  document.getElementById('error').textContent = message ?? '';
}

async function api(path, body) {
  const response = await fetch(`${API}${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `request failed (${response.status})`);
  return result;
}

async function act(path, body = {}) {
  try {
    showError();
    const result = await api(path, body);
    await refresh();
    return result;
  } catch (error) {
    showError(error.message);
    return undefined;
  }
}

/** A screencast into an image: each binary message is one JPEG frame. */
function stream(id, kind, image) {
  const socket = new WebSocket(`${socketBase}/screencast/${encodeURIComponent(id)}?stream=${kind}`);
  socket.binaryType = 'blob';
  let url;
  socket.onmessage = (event) => {
    const next = URL.createObjectURL(event.data);
    image.src = next;
    if (url) URL.revokeObjectURL(url);
    url = next;
  };
  return () => {
    socket.close();
    if (url) URL.revokeObjectURL(url);
  };
}

const tiles = new Map();

function tileLabel(browser) {
  if (browser.watched) return `${browser.provider} slot ${browser.slot} · ${browser.owner} (watching)`;
  const origin = browser.profile ? `${browser.profile} r${browser.revision}` : browser.provider ?? 'ephemeral';
  return `${browser.purpose === 'sign_in' ? 'sign-in' : browser.purpose} · ${origin} · ${browser.client}`;
}

function renderGrid(state) {
  const grid = document.getElementById('grid');
  const browsers = [
    ...state.sessions.filter((session) => session.state === 'ready').map((session) => ({ ...session, watched: false })),
    ...state.watched.map((entry) => ({ ...entry, watched: true, view: 'screencast' })),
  ];
  const ids = new Set(browsers.map((browser) => browser.id));
  for (const [id, tile] of tiles) {
    if (!ids.has(id)) {
      tile.stop?.();
      tile.node.remove();
      tiles.delete(id);
    }
  }
  for (const browser of browsers) {
    let tile = tiles.get(browser.id);
    if (!tile) {
      const view = browser.view === 'screencast' ? element('img', { alt: '' }) : element('div', { class: 'placeholder' }, browser.view === 'vnc' ? 'Sign-in session' : 'No live view');
      const label = element('div', { class: 'label' });
      const node = element('div', { class: 'tile', onclick: () => focus(browser) }, view, label);
      tile = { node, label, stop: browser.view === 'screencast' ? stream(browser.id, 'grid', view) : undefined };
      tiles.set(browser.id, tile);
      grid.append(node);
    }
    tile.label.textContent = tileLabel(browser);
  }
}

let closeFocus;

function focus(browser) {
  closeFocus?.();
  const dialog = document.getElementById('focus');
  const image = document.getElementById('focus-image');
  const vnc = document.getElementById('focus-vnc');
  const actions = document.getElementById('focus-actions');
  document.getElementById('focus-title').textContent = tileLabel(browser);
  actions.replaceChildren();
  vnc.replaceChildren();
  image.removeAttribute('src');
  let stop;
  if (browser.view === 'vnc') {
    image.hidden = true;
    vnc.hidden = false;
    const rfb = new RFB(vnc, `${socketBase}/vnc/${encodeURIComponent(browser.id)}`);
    rfb.scaleViewport = true;
    stop = () => rfb.disconnect();
    actions.append(
      element('button', { onclick: async () => { if (await act(`/sessions/${browser.id}/save`)) closeFocus(); } }, 'Save as new revision'),
      element('button', { onclick: async () => { if (await act(`/sessions/${browser.id}/discard`)) closeFocus(); } }, 'Discard'),
    );
  } else if (browser.view === 'screencast') {
    image.hidden = false;
    vnc.hidden = true;
    stop = stream(browser.id, 'focused', image);
  }
  closeFocus = () => {
    stop?.();
    closeFocus = undefined;
    if (dialog.open) dialog.close();
  };
  dialog.showModal();
}

function table(id, headings, rows) {
  document.getElementById(id).replaceChildren(
    element('tr', {}, headings.map((heading) => element('th', {}, heading))),
    ...rows.map((cells) => element('tr', {}, cells.map((cell) => (cell instanceof Node && cell.tagName === 'TD' ? cell : element('td', {}, cell))))),
  );
}

const time = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const value = (text) => element('td', { class: 'value' }, text ?? '');

function renderProfiles(state) {
  const taskNames = state.tasks.map((task) => task.name);
  document.getElementById('profiles').replaceChildren(...state.profiles.map((profile) => {
    const service = element('input', { placeholder: 'service name', required: true });
    const task = element('select', {}, taskNames.map((name) => element('option', { value: name }, name)));
    return element('div', { class: 'profile' },
      element('h3', {}, profile.name, profile.inUse ? ' (in use)' : ''),
      element('button', {
        onclick: async () => {
          const result = await act(`/profiles/${profile.name}/sign-in`);
          if (result) focus({ id: result.session, view: 'vnc', purpose: 'sign_in', profile: profile.name, revision: profile.current, client: state.client });
        },
      }, 'Sign in'),
      element('button', { disabled: profile.inUse, onclick: () => confirm(`Delete profile ${profile.name}?`) && act(`/profiles/${profile.name}/delete`) }, 'Delete'),
      element('table', {},
        element('tr', {}, ['Revision', 'Created', 'Client', '', ''].map((heading) => element('th', {}, heading))),
        [...profile.revisions].reverse().map((revision) => element('tr', {},
          element('td', {}, revision.id, revision.id === profile.current ? ' (current)' : '', revision.pinned ? ' (pinned)' : ''),
          element('td', {}, time(revision.createdAt)),
          element('td', {}, revision.client),
          element('td', {}, element('button', { onclick: () => act(`/profiles/${profile.name}/revisions/${revision.id}/pin`, { pinned: !revision.pinned }) }, revision.pinned ? 'Unpin' : 'Pin')),
          element('td', {}, revision.id === profile.current ? '' : element('button', { onclick: () => act(`/profiles/${profile.name}/current`, { revision: revision.id }) }, 'Make current')),
        )),
      ),
      element('table', {},
        element('tr', {}, ['Service', 'Check task', 'Last check', '', ''].map((heading) => element('th', {}, heading))),
        profile.services.map((entry) => element('tr', {},
          element('td', {}, entry.name),
          element('td', {}, entry.task),
          element('td', {}, entry.lastCheck ? element('span', { class: entry.lastCheck.result }, `${entry.lastCheck.result.replace('_', ' ')} · ${time(entry.lastCheck.time)} · run ${entry.lastCheck.run}`) : 'not checked'),
          element('td', {}, element('button', { onclick: () => act(`/profiles/${profile.name}/services/${entry.name}/check`) }, 'Check now')),
          element('td', {}, element('button', { onclick: () => act(`/profiles/${profile.name}/services/${entry.name}/delete`) }, 'Remove')),
        )),
      ),
      element('form', { onsubmit: (event) => { event.preventDefault(); act(`/profiles/${profile.name}/services`, { name: service.value, task: task.value }); } },
        service, ' ', task, ' ', element('button', {}, 'Add service')),
    );
  }));
}

async function showSource(name, revision) {
  try {
    const result = await api(`/tasks/${name}/revisions/${revision}`);
    const source = document.getElementById('source');
    source.textContent = `// ${name} revision ${result.revision}, saved by ${result.client}\n${result.content}`;
    source.hidden = false;
  } catch (error) {
    showError(error.message);
  }
}

const rendered = new Map();

/** Render a part only when its data changed, so a poll never clears a form being filled in. */
function renderIf(key, data, draw) {
  const text = JSON.stringify(data);
  if (rendered.get(key) === text) return;
  rendered.set(key, text);
  draw();
}

function render(state) {
  document.getElementById('client').textContent = `signed in as ${state.client}`;
  renderGrid(state);
  renderIf('sessions', [state.sessions, state.watched], () => table('sessions', ['Session', 'Source', 'Profile or provider', 'Client', 'Started', 'State'], state.sessions.map((session) => [
    session.id, session.purpose === 'agent' ? session.source : session.purpose.replace('_', '-'),
    session.profile ?? session.provider ?? '', session.client, time(session.createdAt), session.state,
  ]).concat(state.watched.map((entry) => [entry.id, 'watched', `${entry.provider} slot ${entry.slot}`, entry.owner, '', entry.running ? 'running' : 'idle']))));
  renderIf('profiles', [state.profiles, state.tasks.map((task) => task.name)], () => renderProfiles(state));
  renderIf('tasks', state.tasks, () => table('tasks', ['Task', 'Revisions'], state.tasks.map((task) => [
    task.name,
    element('td', {}, [...task.revisions].reverse().map((revision) =>
      element('button', { title: `${time(revision.createdAt)} by ${revision.client}`, onclick: () => showSource(task.name, revision.id) }, `r${revision.id} · ${revision.client}`))),
  ])));
  renderIf('runs', state.runs, () => table('runs', ['Run', 'Task', 'Status', 'Client', 'Started', 'Duration', 'Input', 'Output', 'Failure'], state.runs.map((run) => [
    run.run, `${run.task} r${run.revision}`, element('td', { class: run.status }, run.status), run.client, time(run.startedAt),
    `${(run.durationMs / 1000).toFixed(1)} s`, value(run.input), value(run.output), value(run.failure),
  ])));
  renderIf('providers', state.providers, () => table('providers', ['Provider', 'Reachable', 'Checked', 'Leased browsers'], state.providers.map((provider) => [
    provider.name, provider.reachable ? 'yes' : `no (${provider.error ?? 'not checked'})`, time(provider.checkedAt),
    provider.slots.map((slot) => `slot ${slot.slot}: ${slot.own ? 'this server' : slot.owner}`).join(', ') || 'none',
  ])));
}

async function refresh() {
  try {
    render(await api('/state'));
  } catch (error) {
    showError(error.message);
  }
}

document.getElementById('new-profile').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = event.target.elements.name;
  act('/profiles', { name: input.value }).then((result) => result && (input.value = ''));
});
document.getElementById('focus-close').addEventListener('click', () => closeFocus?.());
document.getElementById('focus').addEventListener('close', () => closeFocus?.());
refresh();
setInterval(refresh, POLL_MS);
