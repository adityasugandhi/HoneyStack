const $ = (id) => document.getElementById(id);
const state = { sessions: [], selectedId: null, detail: null, jobId: null, highlighted: new Set(), localFailures: new Map(), refreshedAt: 0, busy: false, signedIn: false };
const stageLabels = ['Recon', 'Token leak', 'Injection', 'Reverse shell', 'Post-exploitation'];
const stageDisplay = {
  initial_access: 'Initial access', recon: 'Recon', credential_hunting: 'Credential hunting',
  privilege_escalation_attempt: 'Privilege escalation attempt', lateral_movement_attempt: 'Lateral movement attempt',
  persistence_attempt: 'Persistence attempt', exfiltration_attempt: 'Exfiltration attempt',
  tool_download_attempt: 'Tool download attempt',
};

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
}

function append(parent, ...children) {
  parent.append(...children.filter(Boolean));
  return parent;
}

function setText(id, value) { $(id).textContent = String(value); }

function timeOf(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function dateOf(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function duration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const secs = total % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m ${String(secs).padStart(2, '0')}s`;
}

function elapsed(session) {
  return session.live ? Math.max(session.time_wasted_seconds || 0, Math.floor((Date.now() - Date.parse(session.started_at)) / 1000)) : session.time_wasted_seconds;
}

function safeGuildUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'app.guild.ai' ? url.href : null;
  } catch { return null; }
}

function link(label, href, className = '') {
  const safe = safeGuildUrl(href);
  if (!safe) return null;
  const anchor = node('a', className, label);
  anchor.href = safe;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function showError(message) {
  const banner = $('error-banner');
  banner.textContent = message;
  banner.hidden = false;
}

function clearError() { $('error-banner').hidden = true; }

function showLogin(message = '') {
  state.signedIn = false;
  $('dashboard').hidden = true;
  $('login-screen').hidden = false;
  $('logout-button').hidden = true;
  setText('login-error', message);
}

function showDashboard() {
  state.signedIn = true;
  $('dashboard').hidden = false;
  $('login-screen').hidden = true;
  $('logout-button').hidden = false;
}

function updateBars(card, values) {
  const bars = [...card.querySelectorAll('.mini-bars i')];
  const last = values.slice(-bars.length);
  const padded = [...Array(Math.max(0, bars.length - last.length)).fill(0), ...last];
  const max = Math.max(1, ...padded);
  bars.forEach((bar, index) => {
    bar.style.height = `${Math.max(10, Math.round(padded[index] / max * 100))}%`;
    bar.title = String(padded[index]);
  });
}

function renderMetrics(overview) {
  setText('metric-attackers', overview.attackers_trapped);
  setText('metric-commands', overview.commands_captured);
  setText('metric-time', duration(overview.time_wasted_seconds));
  setText('metric-bait', overview.bait_reads);
  setText('metric-analyses', overview.analyses_completed);
  const oldestFirst = [...state.sessions].reverse();
  const cards = [...document.querySelectorAll('.metric-card')];
  updateBars(cards[0], oldestFirst.map((session) => Number(session.stage.level >= 3)));
  updateBars(cards[1], oldestFirst.map((session) => session.commands));
  updateBars(cards[2], oldestFirst.map((session) => session.time_wasted_seconds));
  updateBars(cards[3], oldestFirst.map((session) => session.bait_reads));
  updateBars(cards[4], oldestFirst.map((session) => Number(session.analysis_state === 'complete')));
}

function renderSessions() {
  const showNoise = $('noise-toggle').checked;
  const visible = state.sessions.filter((session) => showNoise || session.stage.level >= 2);
  const rows = $('session-rows');
  rows.replaceChildren();
  setText('session-count', `${visible.length} shown / ${state.sessions.length} total`);
  $('empty-sessions').hidden = visible.length !== 0;
  for (const session of visible) {
    const row = node('tr', session.session_id === state.selectedId ? 'selected' : '');
    row.tabIndex = 0;
    row.setAttribute('aria-label', `Open session ${session.session_id}`);
    row.addEventListener('click', () => selectSession(session.session_id));
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSession(session.session_id); } });
    const statusCell = node('td');
    const status = node('span', `session-status ${session.live ? 'live' : 'ended'}`);
    append(status, node('span', 'status-dot'), node('span', '', session.live ? 'LIVE' : 'ENDED'));
    const id = node('span', 'session-id', session.session_id.slice(0, 8));
    append(statusCell, status, id);
    if (session.fixture) statusCell.append(node('span', 'row-fixture', 'fixture'));
    const stageCell = node('td');
    append(stageCell, node('span', `stage-tag stage-${session.stage.level}`, session.stage.label));
    if (session.analysis_state === 'complete') stageCell.append(node('span', 'analyzed-tag', 'Analyzed'));
    const startCell = node('td', 'muted-cell', `${dateOf(session.started_at)} · ${timeOf(session.started_at)}`);
    const commandsCell = node('td', 'number-cell', session.commands);
    const durationCell = node('td', 'number-cell session-duration', duration(elapsed(session)));
    durationCell.dataset.sessionId = session.session_id;
    append(row, statusCell, stageCell, startCell, commandsCell, durationCell, append(node('td', 'row-arrow'), node('span', '', '↗')));
    rows.append(row);
  }
}

function renderAttackPath(detail) {
  const path = $('attack-path');
  path.replaceChildren();
  const level = detail.summary.stage.level;
  stageLabels.forEach((label, index) => {
    const reached = level >= index + 1;
    const step = node('div', `path-step ${reached ? 'reached' : ''} ${level === index + 1 ? 'current' : ''}`);
    append(step, node('span', 'step-number', String(index + 1).padStart(2, '0')), node('span', 'step-label', label));
    path.append(step);
    if (index < stageLabels.length - 1) path.append(node('span', `path-connector ${level > index + 1 ? 'reached' : ''}`, '→'));
  });
}

function renderReplay(detail) {
  const terminal = $('terminal');
  const atBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 60;
  const oldScroll = terminal.scrollTop;
  terminal.replaceChildren();
  const turns = detail.timeline.filter((item) => item.kind === 'turn');
  setText('replay-count', `${turns.length} turns`);
  if (!detail.timeline.length) {
    terminal.append(node('p', 'terminal-empty', 'No captured evidence yet.'));
    return;
  }
  for (const item of detail.timeline) {
    if (item.kind === 'event') {
      const data = item.data;
      const event = node('div', `timeline-item http-event ${state.highlighted.has(item.id) ? 'evidence-highlight' : ''}`);
      event.dataset.evidenceId = item.id;
      const top = node('div', 'event-main');
      append(top, node('span', 'event-time', timeOf(item.at)), node('span', 'event-icon', '↳'),
        node('span', 'event-method', data.method), node('span', 'event-route', data.route), node('span', 'event-template', data.response_template));
      event.append(top);
      if (data.payload_text) event.append(node('div', 'event-payload', data.payload_text));
      terminal.append(event);
      continue;
    }
    const data = item.data;
    const turn = node('div', `timeline-item shell-turn ${state.highlighted.has(item.id) ? 'evidence-highlight' : ''}`);
    turn.dataset.evidenceId = item.id;
    const meta = node('div', 'turn-meta');
    append(meta, node('span', 'turn-index', `#${String(Number(data.seq) + 1).padStart(2, '0')}`),
      node('span', 'turn-time', timeOf(item.at)), node('span', `served-badge served-${data.served_by}`, data.served_by === 'fast_path' ? 'FAST' : String(data.served_by).toUpperCase()));
    if (data.served_by === 'guild') meta.append(link('Guild ↗', detail.analysis?.guild_session_url, 'guild-inline-link'));
    const prompt = node('div', 'terminal-command');
    append(prompt, node('span', 'terminal-prompt', `node@acme-status-7f9c4:${data.cwd || '/app'}$`), node('span', 'command-text', data.command));
    append(turn, meta, prompt, node('pre', 'terminal-output', data.output || ''));
    terminal.append(turn);
  }
  if (atBottom && detail.summary.live) terminal.scrollTop = terminal.scrollHeight;
  else terminal.scrollTop = oldScroll;
}

function highlightEvidence(ids) {
  state.highlighted = new Set(ids);
  for (const element of document.querySelectorAll('.timeline-item')) {
    element.classList.toggle('evidence-highlight', state.highlighted.has(element.dataset.evidenceId));
  }
  const first = [...document.querySelectorAll('.timeline-item')].find((element) => state.highlighted.has(element.dataset.evidenceId));
  if (first) first.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
}

function analysisButton(label) {
  const button = node('button', 'primary-button analyze-button', label);
  button.type = 'button';
  button.addEventListener('click', analyzeSelected);
  return button;
}

function renderAnalysis(detail) {
  const box = $('analysis-content');
  box.replaceChildren();
  const analysis = detail.analysis;
  if (!analysis) {
    const empty = node('div', 'analysis-empty');
    append(empty, node('div', 'analysis-orbit', '✳'), node('p', 'eyebrow', 'READY TO ANALYZE'),
      node('h4', '', 'Turn activity into evidence.'),
      node('p', '', 'Ask Guild to classify this session and link each finding to the exact captured events.'),
      analysisButton('Analyze with Guild ↗'));
    box.append(empty);
    return;
  }
  if (analysis.state === 'running') {
    const running = node('div', 'analysis-pending');
    append(running, node('div', 'pending-spinner'), node('p', 'eyebrow', 'ANALYSIS IN PROGRESS'),
      node('h4', '', 'Guild is reviewing the trail.'),
      node('p', '', 'The report will appear here when the evidence review completes.'),
      link('Open Guild session ↗', analysis.guild_session_url, 'text-link'));
    box.append(running);
    return;
  }
  if (analysis.state === 'failed') {
    const failed = node('div', 'analysis-failed');
    append(failed, node('span', 'failed-symbol', '!'), node('p', 'eyebrow', 'ANALYSIS FAILED'),
      node('h4', '', 'Guild could not complete this report.'), node('p', '', analysis.error || 'Please try again.'),
      analysisButton('Retry analysis ↗'));
    box.append(failed);
    return;
  }
  const result = analysis.result;
  if (!result) {
    box.append(node('p', 'analysis-failed', 'The saved analysis has no readable report.'));
    return;
  }
  const label = result.classification === 'suspicious_sequence' ? 'SUSPICIOUS SEQUENCE' : result.classification === 'benign_test' ? 'BENIGN TEST' : 'UNKNOWN';
  const status = node('div', 'classification-row');
  append(status, node('span', `classification classification-${result.classification}`, label),
    node('span', 'report-time', `${duration(analysis.time_wasted_seconds)} wasted`));
  box.append(status, node('p', 'analysis-summary', result.summary));
  const heading = node('div', 'report-heading');
  append(heading, node('span', '', 'KILL CHAIN'), node('span', '', `${result.playbook_stages.length} stages`));
  box.append(heading);
  const list = node('div', 'kill-chain');
  result.playbook_stages.forEach((stage, index) => {
    const button = node('button', 'kill-step');
    button.type = 'button';
    button.title = 'Highlight cited evidence in terminal replay';
    append(button, node('span', 'kill-number', String(index + 1).padStart(2, '0')),
      node('span', 'kill-title', stageDisplay[stage.stage] || stage.stage),
      node('span', 'evidence-count', `${stage.evidence_ids.length} evidence ↗`));
    button.addEventListener('click', () => highlightEvidence(stage.evidence_ids));
    list.append(button);
  });
  if (!result.playbook_stages.length) list.append(node('p', 'report-empty', 'No specific stages were identified.'));
  box.append(list);
  if (result.credentials_targeted.length) {
    box.append(node('div', 'report-heading', 'CREDENTIALS TARGETED'));
    const chips = node('div', 'credential-chips');
    result.credentials_targeted.forEach((value) => chips.append(node('span', 'credential-chip', value)));
    box.append(chips);
  }
  if (result.limitations.length) {
    box.append(node('div', 'report-heading', 'ANALYST NOTES'));
    result.limitations.forEach((value) => box.append(node('p', 'limitation', value)));
  }
  const footer = node('div', 'analysis-footer');
  append(footer, link('View full Guild session ↗', analysis.guild_session_url, 'text-link'),
    node('span', '', `${result.evidence_event_ids.length} cited items`));
  box.append(footer);
}

function renderDetail(options = { replay: true, analysis: true }) {
  const detail = state.detail;
  if (!detail) return;
  const session = detail.summary;
  setText('detail-title', `Session ${session.session_id.slice(0, 8)}`);
  setText('detail-subtitle', `${session.live ? 'Live now' : 'Ended'} · Started ${dateOf(session.started_at)} at ${timeOf(session.started_at)} · ${duration(elapsed(session))} in the trap`);
  $('fixture-badge').hidden = !session.fixture;
  renderAttackPath(detail);
  if (options.replay) renderReplay(detail);
  if (options.analysis) renderAnalysis(detail);
}

async function loadDetail(id) {
  try {
    const detail = await request(`/admin/api/sessions/${encodeURIComponent(id)}`);
    if (state.selectedId !== id) return;
    if (!detail.analysis && state.localFailures.has(id)) detail.analysis = state.localFailures.get(id);
    const previous = state.detail;
    const replayChanged = !previous || previous.timeline.length !== detail.timeline.length ||
      previous.timeline.some((item, index) => item.id !== detail.timeline[index].id ||
        JSON.stringify(item.data) !== JSON.stringify(detail.timeline[index].data));
    const analysisChanged = !previous || JSON.stringify(previous.analysis) !== JSON.stringify(detail.analysis);
    state.detail = detail;
    state.jobId = detail.analysis?.state === 'running' ? detail.analysis.id : null;
    renderDetail({ replay: replayChanged, analysis: analysisChanged });
  } catch (error) {
    if (error.status !== 401) showError(`Session detail could not refresh: ${error.message}`);
  }
}

function selectSession(id) {
  if (state.selectedId === id && state.detail) return;
  state.selectedId = id;
  state.detail = null;
  state.jobId = null;
  state.highlighted.clear();
  renderSessions();
  loadDetail(id);
}

async function analyzeSelected() {
  if (!state.selectedId || !state.detail) return;
  const sessionId = state.selectedId;
  state.localFailures.delete(sessionId);
  state.detail.analysis = { state: 'running', time_wasted_seconds: state.detail.summary.time_wasted_seconds };
  renderAnalysis(state.detail);
  try {
    const response = await request(`/admin/api/sessions/${encodeURIComponent(sessionId)}/analyze`, { method: 'POST' });
    if (state.selectedId !== sessionId || !state.detail) return;
    state.jobId = response.job_id;
    state.detail.analysis = { id: response.job_id, state: 'running', guild_session_url: response.guild_session_url,
      time_wasted_seconds: state.detail.summary.time_wasted_seconds };
    renderAnalysis(state.detail);
  } catch (error) {
    if (state.selectedId !== sessionId || !state.detail) return;
    state.detail.analysis = { state: 'failed', error: error.message, time_wasted_seconds: 0 };
    state.localFailures.set(sessionId, state.detail.analysis);
    renderAnalysis(state.detail);
  }
}

async function pollAnalysis() {
  if (!state.jobId || !state.detail || !state.signedIn) return;
  const jobId = state.jobId;
  try {
    const job = await request(`/admin/api/analysis/${encodeURIComponent(jobId)}`);
    if (state.jobId !== jobId || !state.detail) return;
    state.detail.analysis = job;
    if (job.state === 'complete' || job.state === 'failed') state.jobId = null;
    renderAnalysis(state.detail);
  } catch (error) {
    if (error.status === 401) showLogin('Session expired. Sign in again.');
    else showError(`Analysis status could not refresh: ${error.message}`);
  }
}

async function refresh() {
  if (state.busy || (state.signedIn === false && !$('login-screen').hidden)) return;
  state.busy = true;
  try {
    const since = $('range-select').value;
    const [overview, sessionData] = await Promise.all([
      request(`/admin/api/overview?since=${since}`),
      request(`/admin/api/sessions?since=${since}`),
    ]);
    const sessionsChanged = JSON.stringify(state.sessions) !== JSON.stringify(sessionData.sessions);
    state.sessions = sessionData.sessions;
    showDashboard();
    clearError();
    renderMetrics(overview);
    if (!state.selectedId || !state.sessions.some((session) => session.session_id === state.selectedId)) {
      state.selectedId = state.sessions.find((session) => session.stage.level >= 2)?.session_id || state.sessions[0]?.session_id || null;
      state.highlighted.clear();
    }
    if (sessionsChanged || !$('session-rows').childElementCount) renderSessions();
    if (state.selectedId) await loadDetail(state.selectedId);
    state.refreshedAt = Date.now();
    updateRefreshLabel();
  } catch (error) {
    if (error.status === 401) showLogin();
    else { showDashboard(); showError(`Dashboard could not refresh: ${error.message}`); }
  } finally { state.busy = false; }
}

function updateRefreshLabel() {
  if (!state.refreshedAt) return;
  const age = Math.max(0, Math.floor((Date.now() - state.refreshedAt) / 1000));
  setText('refresh-label', `● Last refresh ${age}s ago`);
}

function tick() {
  updateRefreshLabel();
  for (const cell of document.querySelectorAll('.session-duration')) {
    const session = state.sessions.find((candidate) => candidate.session_id === cell.dataset.sessionId);
    if (session?.live) cell.textContent = duration(elapsed(session));
  }
  if (state.detail?.summary.live) {
    setText('detail-subtitle', `Live now · Started ${dateOf(state.detail.summary.started_at)} at ${timeOf(state.detail.summary.started_at)} · ${duration(elapsed(state.detail.summary))} in the trap`);
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = $('operator-token').value;
  try {
    await request('/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    $('operator-token').value = '';
    showDashboard();
    await refresh();
  } catch (error) { setText('login-error', error.message); }
});
$('logout-button').addEventListener('click', async () => {
  try { await request('/admin/logout', { method: 'POST' }); } catch { /* local access may already be gone */ }
  showLogin();
});
$('range-select').addEventListener('change', refresh);
$('noise-toggle').addEventListener('change', renderSessions);
setInterval(() => { if (state.signedIn) refresh(); }, 5000);
setInterval(tick, 1000);
setInterval(pollAnalysis, 2000);
refresh();
