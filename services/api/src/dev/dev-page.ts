/** The dev helper page. Everything dynamic is written with textContent, never innerHTML. */
export function renderDevPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Erase.me dev helper</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; padding: 24px 16px; max-width: 880px; line-height: 1.45; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  .note { font-size: .85rem; opacity: .75; margin: 0 0 20px; }
  section { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; padding: 14px 16px; margin: 0 0 16px; }
  h2 { font-size: 1rem; margin: 0 0 8px; }
  button, a.btn { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
  button:disabled { opacity: .45; cursor: default; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
  .grow { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
  .warn { padding: 8px 10px; border-left: 3px solid #b26a00; background: color-mix(in srgb, #b26a00 12%, transparent); margin: 8px 0; }
  .err { color: #b3261e; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); vertical-align: top; }
  td.dom { opacity: .65; font-size: .8rem; }
  .chip { display: inline-block; padding: 0 6px; margin: 0 4px 2px 0; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 10px; font-size: .78rem; }
  progress { width: 160px; }
  .high { font-weight: 600; }
  .keep { font-size: .8rem; }
</style>
</head>
<body>
<h1>Erase.me dev helper</h1>
<p class="note">Development only. Reads header metadata of your mail (never bodies) and keeps only company, dates and signal names. No subjects or sender addresses are kept or shown. Nothing is sent. Results are hints: these companies may hold data about you, and the signals show why.</p>
<div id="msg" class="err" role="alert"></div>
<div id="setup"></div>

<section id="signin" hidden>
  <h2>1. Sign in</h2>
  <p>Sign in with Google (name and email only).</p>
  <a class="btn" href="/v1/auth/google/start">Sign in with Google</a>
</section>

<section id="inboxes" hidden>
  <h2>2. Inbox</h2>
  <p>Connecting asks Google for Gmail read-only (to scan) and send (used later, only after you approve a request). This helper never sends.</p>
  <div id="inbox-list"></div>
  <div class="row"><button id="connect" type="button">Connect a Gmail inbox</button></div>
</section>

<section id="results" hidden>
  <h2>3. Results</h2>
  <div id="scan-status" class="row"></div>
  <table>
    <thead><tr><th>Company</th><th>Confidence</th><th>First seen</th><th>Last seen</th><th>Signals used</th><th>Must keep</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <p id="empty" class="note" hidden>No companies yet. Run a scan.</p>
</section>

<script nonce="${nonce}">
(function () {
  var csrf = '';
  var timer = null;
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var codes = {
    access_denied: 'Google consent was cancelled.',
    invalid_state: 'The sign-in link expired or came from another browser. Try again.',
    exchange_failed: 'Google did not accept the sign-in. Try again.',
    scopes_missing: 'Both Gmail permissions are needed. Tick them on the consent screen.',
    no_refresh_token: 'Google did not return offline access. Remove Erase.me at myaccount.google.com/permissions and connect again.',
    inbox_limit: 'You already have 5 inboxes connected.',
    account_unavailable: 'This account is being deleted.'
  };
  var err = params.get('auth_error');
  if (err) $('msg').textContent = codes[err] || 'Something went wrong (' + err + ').';

  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.detail || j.title || 'Request failed');
        return j;
      });
    });
  }

  function render(s) {
    var setup = $('setup');
    setup.textContent = '';
    if (!s.setup.googleConfigured) setup.appendChild(el('div', 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env.', 'warn'));
    if (!s.setup.encryptionConfigured) setup.appendChild(el('div', 'TOKEN_MASTER_KEY is not set in .env, so an inbox cannot be connected yet.', 'warn'));
    $('signin').hidden = s.signedIn;
    $('inboxes').hidden = !s.signedIn;
    $('results').hidden = !s.signedIn;
    if (!s.signedIn) return;
    csrf = s.csrfToken;

    var list = $('inbox-list');
    list.textContent = '';
    var active = false;
    s.inboxes.forEach(function (inbox) {
      var scan = s.scans[inbox.id];
      var row = el('div', undefined, 'row');
      row.appendChild(el('span', inbox.email + ' (' + inbox.status + ')', 'grow'));
      var scanBtn = el('button', scan && (scan.status === 'queued' || scan.status === 'running') ? 'Scanning...' : 'Scan');
      scanBtn.type = 'button';
      scanBtn.disabled = inbox.status !== 'connected' || !!(scan && (scan.status === 'queued' || scan.status === 'running'));
      scanBtn.addEventListener('click', function () {
        scanBtn.disabled = true;
        api('/dev/api/scan', { inboxId: inbox.id }).then(refresh, fail);
      });
      row.appendChild(scanBtn);
      var off = el('button', 'Disconnect');
      off.type = 'button';
      off.disabled = inbox.status === 'disconnected';
      off.addEventListener('click', function () {
        off.disabled = true;
        api('/dev/api/disconnect', { inboxId: inbox.id }).then(refresh, fail);
      });
      row.appendChild(off);
      list.appendChild(row);
      if (inbox.status === 'error') list.appendChild(el('div', 'Google no longer allows access for this inbox. Disconnect it and connect again.', 'warn'));
      if (scan && scan.status === 'failed') list.appendChild(el('div', 'Last scan failed (' + scan.errorCode + ').', 'warn'));
      if (scan && (scan.status === 'queued' || scan.status === 'running')) active = true;
    });
    if (!s.inboxes.length) list.appendChild(el('p', 'No inbox connected yet.', 'note'));
    $('connect').disabled = !s.setup.googleConfigured || !s.setup.encryptionConfigured;

    var status = $('scan-status');
    status.textContent = '';
    var latest = null;
    s.inboxes.forEach(function (i) { if (s.scans[i.id]) latest = s.scans[i.id]; });
    if (latest) {
      var p = el('progress');
      p.max = 100;
      p.value = latest.progressPct;
      status.appendChild(p);
      status.appendChild(el('span', 'Scan ' + latest.status + ', ' + latest.progressPct + '%, ' + latest.foundCount + ' companies found'));
    }

    var rows = $('rows');
    rows.textContent = '';
    s.results.forEach(function (r) {
      var tr = document.createElement('tr');
      var c = el('td', r.company);
      c.appendChild(el('div', r.domain, 'dom'));
      if (typeof r.selfServeUrl === 'string' && r.selfServeUrl.indexOf('https://') === 0) {
        var link = el('a', 'Delete it yourself (company page)');
        link.href = r.selfServeUrl;
        link.rel = 'noopener noreferrer';
        link.target = '_blank';
        link.className = 'dom';
        c.appendChild(link);
      }
      tr.appendChild(c);
      var conf = el('td', r.confidence === 'high' ? 'Likely' : 'Possible', r.confidence === 'high' ? 'high' : '');
      if (r.activity) conf.appendChild(el('div', r.activity === 'looks_in_use' ? 'Looks in use' : 'Looks unused', 'dom'));
      if (r.kept) conf.appendChild(el('div', 'Kept', 'dom'));
      tr.appendChild(conf);
      tr.appendChild(el('td', r.firstSeen));
      tr.appendChild(el('td', r.lastSeen));
      var sig = el('td');
      r.signals.forEach(function (x) { sig.appendChild(el('span', x, 'chip')); });
      tr.appendChild(sig);
      tr.appendChild(el('td', r.mustKeep ? 'Yes. Needed for your account, so no deletion request is offered.' : 'No', 'keep'));
      rows.appendChild(tr);
    });
    $('empty').hidden = s.results.length > 0;

    clearTimeout(timer);
    if (active) timer = setTimeout(refresh, 1500);
  }

  function fail(e) { $('msg').textContent = e.message; refresh(); }

  function refresh() {
    return fetch('/dev/api/state', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { $('msg').textContent = 'Cannot reach the API.'; });
  }

  $('connect').addEventListener('click', function () {
    $('connect').disabled = true;
    api('/dev/api/connect').then(function (j) { location.href = j.authorizationUrl; }, fail);
  });

  if (params.get('inbox') === 'connected') $('msg').textContent = '';
  refresh();
})();
</script>
</body>
</html>`;
}
