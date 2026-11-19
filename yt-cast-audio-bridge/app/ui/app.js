'use strict';

const $ = (id) => document.getElementById(id);
const POLL_MS = 3000;
let busy = false;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function ago(timestamp, now) {
  if (!timestamp) return 'never';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function formatCode(code) {
  return String(code).replace(/(\d{3})(?=\d)/g, '$1 ');
}

const STATE_LABEL = { active: 'In YouTube app', hidden: 'Not shown', offline: 'Offline', error: 'Problem', starting: 'Starting…' };

function renderDevice(device, now, address) {
  const toggle = el('input', { type: 'checkbox', 'aria-label': `Show ${device.name} in the YouTube app` });
  toggle.checked = device.enabled;
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      await api(`api/devices/${encodeURIComponent(device.id)}/enabled`, { enabled: toggle.checked });
    } catch (err) {
      $('action-result').textContent = err.message;
    }
    await refresh();
  });

  const title = el('h3', { text: device.receiver ? device.receiver.displayName : device.name }, [
    el('span', { class: `badge ${device.state}`, text: STATE_LABEL[device.state] || device.state }),
  ]);
  const details = [device.isGroup ? 'Speaker group' : device.model, device.host, device.online ? '' : `last seen ${ago(device.lastSeen, now)}`]
    .filter(Boolean)
    .join(' · ');
  const meta = el('div', { class: 'meta', text: device.reason ? `${details} — ${device.reason}` : details });

  const card = el('div', { class: 'card' }, [
    el('div', {}, [title, meta]),
    el('label', { class: 'switch' }, [toggle, el('span', { text: device.enabled ? 'On' : 'Off' })]),
  ]);

  const receiver = device.receiver;
  if (receiver) {
    if (address) {
      // Opening this from a phone shows whether the phone can reach this speaker's receiver.
      const url = `http://${address}:${receiver.port}/ytbridge/${device.id}/ssdp/device-desc.xml`;
      meta.append(` · port ${receiver.port} · `, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'reachability test link' }));
    }
    let line = '';
    if (receiver.nowPlaying) {
      const np = receiver.nowPlaying;
      const verb = np.state === 'paused' ? 'Paused' : np.state === 'loading' ? 'Loading' : 'Playing';
      line = `${verb}: ${np.title}${np.artist ? ` — ${np.artist}` : ''}`;
    } else if (receiver.lastError) {
      line = `Last playback failed: ${receiver.lastError}`;
    } else if (receiver.senders > 0) {
      line = `${receiver.senders} phone${receiver.senders === 1 ? '' : 's'} connected`;
    }
    if (line) card.append(el('div', { class: 'playing', text: line }));

    const pairing = el('div', { class: 'pairing' });
    if (receiver.pairing) {
      pairing.append(
        el('div', {}, [el('span', { text: 'TV code: ' }), el('strong', { class: 'code', text: formatCode(receiver.pairing.code) })]),
        el('div', { class: 'meta', text: `In the YouTube app: profile picture → Settings → Watch on TV → Link with TV code. Works from any network; several phones can use it. Shown for another ${Math.max(1, Math.round((receiver.pairing.validUntil - now) / 60000))} min.` }),
      );
    } else {
      const button = el('button', { type: 'button', text: 'Link with TV code' });
      button.addEventListener('click', () => runAction(button, 'Asking YouTube…', async () => {
        const result = await api(`api/devices/${encodeURIComponent(device.id)}/pairing-code`, {});
        return result.ok ? '' : `No TV code: ${result.error}`;
      }));
      pairing.append(button, el('span', { class: 'meta', text: ' for phones that do not find this speaker in the Cast menu' }));
    }
    card.append(pairing);
  }
  return card;
}

function renderFacts(target, facts) {
  target.replaceChildren(...facts.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: String(value) })]));
}

function render(status) {
  const now = status.now;
  const active = status.devices.filter((d) => d.state === 'active').length;
  $('summary').textContent = `Version ${status.version} · ${active} of ${status.devices.length} device${status.devices.length === 1 ? '' : 's'} available in YouTube · running since ${ago(status.startedAt, now).replace(' ago', '')}`;

  $('problems').replaceChildren(...status.problems.map((p) => el('div', { class: `notice ${p.level}`, text: p.text })));

  const devices = $('devices');
  // Keep a toggle that is being used from being replaced under the user's finger.
  if (!devices.contains(document.activeElement) || !document.activeElement.disabled) {
    const focusedId = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.device : '';
    devices.replaceChildren(
      ...(status.devices.length
        ? status.devices.map((d) => {
            const card = renderDevice(d, now, status.network.addresses[0]);
            card.querySelector('input').dataset.device = d.id;
            return card;
          })
        : [el('div', { class: 'empty', text: 'No Cast devices found yet. Make sure the speakers are switched on and in the same network as Home Assistant.' })]),
    );
    if (focusedId) {
      const again = devices.querySelector(`input[data-device="${CSS.escape(focusedId)}"]`);
      if (again) again.focus();
    }
  }

  const yt = status.ytdlp;
  renderFacts($('ytdlp'), [
    ['Status', yt.working ? (yt.stats.consecutiveFailures >= 2 ? 'Failing' : 'Working') : 'Not working'],
    ['yt-dlp version', yt.version || 'unknown'],
    ['Automatic updates', yt.autoUpdate ? `on (last check ${ago(yt.lastUpdateCheckAt, now)})` : 'off'],
    ['Lookups', `${yt.stats.resolved} ok, ${yt.stats.failed} failed, ${yt.stats.cacheHits} from cache`],
    ...(yt.stats.lastDurationMs ? [['Last lookup took', `${(yt.stats.lastDurationMs / 1000).toFixed(1)} s`]] : []),
    ...(yt.stats.lastError ? [['Last error', `${yt.stats.lastError} (${ago(yt.stats.lastErrorAt, now)})`]] : []),
  ]);
  $('update').hidden = !yt.autoUpdate;

  const net = status.network;
  renderFacts($('network'), [
    ['Address', net.addresses.length ? `${net.addresses.join(', ')} (${net.source === 'auto' ? 'detected automatically' : 'from configuration'})` : 'none found'],
    ['Receiver ports (TCP)', net.receiverPorts.length ? net.receiverPorts.join(', ') : 'none in use'],
    ['Status port (TCP)', net.healthPort],
    ['Last answer from a speaker', ago(status.discovery.lastResponseAt, now)],
  ]);

  if ($('log-details').open) {
    const logs = $('logs');
    const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 20;
    logs.textContent = status.logs.map((l) => `${l.time.slice(11, 19)} ${l.level.padEnd(5)} [${l.scope}] ${l.message}`).join('\n');
    if (atBottom) logs.scrollTop = logs.scrollHeight;
  }
}

async function refresh() {
  try {
    render(await api('api/status'));
  } catch (err) {
    $('summary').textContent = `Cannot reach the bridge: ${err.message}`;
  }
}

async function runAction(button, label, action) {
  if (busy) return;
  busy = true;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  $('action-result').textContent = '';
  try {
    $('action-result').textContent = await action();
  } catch (err) {
    $('action-result').textContent = err.message;
  }
  button.disabled = false;
  button.textContent = original;
  busy = false;
  await refresh();
}

$('rescan').addEventListener('click', () => runAction($('rescan'), 'Searching…', async () => {
  await api('api/rescan', {});
  return '';
}));
$('selftest').addEventListener('click', () => runAction($('selftest'), 'Testing…', async () => {
  const result = await api('api/selftest', {});
  return result.ok ? `Lookup works (${(result.ms / 1000).toFixed(1)} s).` : `Lookup failed: ${result.error}`;
}));
$('update').addEventListener('click', () => runAction($('update'), 'Updating…', async () => {
  const result = await api('api/ytdlp/update', {});
  if (!result.ok) return `Update failed: ${result.lastUpdateError}`;
  return result.updated ? `Updated to ${result.version}.` : `Already up to date (${result.version}).`;
}));
$('log-details').addEventListener('toggle', refresh);

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
