'use strict';

// One controller per open Settings sheet. Host status updates may arrive in
// either order while someone is reading, scrolling, or copying instructions.
window.createAgentSettings = function ({el, icon, button, host, toast, refresh}) {
  const cli = '"$HOME/.local/bin/samare"';
  const session = `For this chat, give me a local Samare link for each Markdown file you write for me or that I ask to read, edit or share. Keep internal notes and build output out of the handoff.

Run ${cli} url <absolute-path-to-file>. Copy its exact output into your reply, once per document. The address works on this Mac.

If the sandbox prevents a connection, request permission for this command to reach the local service and retry. If the permitted command fails, use ${cli} doctor before changing any settings.`;
  const install = `Connect this agent client to Samare. First inspect the instructions with ${cli} print-skill. Keep any existing custom skill intact.

Choose the command for the client I am using:
${cli} install-skill codex
${cli} install-skill claude
${cli} install-skill cursor

For clients that use ~/.agents/skills, select install-skill shared. Load the installed instructions in a new session. If the command is missing, open Samare Settings and enable Use in Agent. For this chat, the Running session tab has a prompt you can use immediately.`;
  const recovery = `The Samare service is local to this Mac. Please allow the agent to connect to 127.0.0.1 through its local-service permission flow, then repeat the command. To inspect the connection, run ${cli} doctor.`;
  const clients = [['codex', 'Codex'], ['claude', 'Claude Code'], ['cursor', 'Cursor']];
  const descriptions = {
    ready: 'installed', fallback: 'using fallback', notDetected: 'not detected', repairRequired: 'needs repair',
    notInstalled: 'not installed', disabled: 'available after setup',
  };
  let expanded, selected = 'install', copied = '', resetCopy, statusTimer, pendingCopy, busy = false;

  function stateOf(bridge, key) {
    if (!bridge.enabled) return 'disabled';
    const detail = bridge.clientDetails?.[key];
    if (detail?.status === 'outdated' || detail?.status === 'modified') return 'repairRequired';
    if (detail?.usingFallback) return 'fallback';
    if (detail?.installed || bridge.clients?.[key]) return 'ready';
    return detail?.detected === false ? 'notDetected' : 'notInstalled';
  }

  function paintCopyButton() {
    const control = document.getElementById('agent-copy');
    if (!control) return;
    const tab = control.dataset.tab;
    const done = copied === tab;
    const label = done ? 'Agent instructions copied' : tab === 'install'
      ? 'Copy skill install instructions' : 'Copy instructions for a running session';
    control.title = label;
    control.setAttribute('aria-label', label);
    control.dataset.copied = String(done);
    control.replaceChildren(icon(done ? 'check' : 'copy'));
  }
  function copy(kind, text) {
    const id = 'agent-' + crypto.getRandomValues(new Uint32Array(2)).join('-');
    pendingCopy = {id, kind};
    host('copy', {text, requestId: id});
  }
  function copyResult({requestId, ok}) {
    if (requestId !== pendingCopy?.id) return;
    const {kind} = pendingCopy;
    pendingCopy = null;
    if (!ok) { toast('Could not copy to the clipboard.'); return; }
    if (kind === 'recovery') { toast('Copied · Paste this to your agent.'); return; }
    if (kind === 'diagnostic') { toast('Diagnostic command copied'); return; }
    copied = kind;
    paintCopyButton();
    clearTimeout(resetCopy);
    resetCopy = setTimeout(() => { copied = ''; paintCopyButton(); }, 1400);
  }
  function change(type, args) {
    if (busy) return;
    busy = true;
    refresh();
    host(type, args);
  }
  function switchRow(title, description, label, checked, disabled, type) {
    const row = el('div', 'setting'), line = el('div', 'setting-row'), info = el('div');
    info.append(el('h3', '', title), el('p', '', description));
    const toggle = button(label, null, () => change(type, {enabled: !checked}), 'switch');
    toggle.id = type;
    toggle.replaceChildren(el('i'));
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(checked));
    toggle.disabled = disabled || busy;
    line.append(info, toggle);
    row.append(line);
    return row;
  }
  function instructions(status, missing) {
    const open = expanded ?? missing;
    const kind = missing ? selected : 'session';
    const label = missing ? 'Finish setting up your agent' : 'Already have an agent session running?';
    const disclosure = button(label, 'chevron-right', () => {
      expanded = !open;
      refresh();
    }, 'agent-disclosure');
    disclosure.append(label);
    disclosure.id = 'agent-disclosure';
    disclosure.setAttribute('aria-expanded', String(open));
    disclosure.setAttribute('aria-controls', 'agent-instructions');
    status.append(disclosure);
    const body = el('div', 'agent-instructions');
    body.id = 'agent-instructions';
    body.hidden = !open;
    status.append(body);
    if (!open) return;
    if (missing) {
      const tabs = el('div', 'agent-tabs');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Agent instructions');
      for (const name of ['install', 'session']) {
        const tab = button(name === 'install' ? 'Install skill' : 'Running session', null, () => {
          selected = name;
          copied = '';
          pendingCopy = null;
          refresh();
          document.getElementById('agent-tab-' + name)?.focus({preventScroll: true});
        }, '');
        tab.id = 'agent-tab-' + name;
        tab.tabIndex = name === kind ? 0 : -1;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(name === kind));
        tab.setAttribute('aria-controls', 'agent-card');
        tab.onkeydown = (event) => {
          const next = ({Home:'install', End:'session'})[event.key] ??
            (/^Arrow(Left|Right|Up|Down)$/.test(event.key) ? (name === 'install' ? 'session' : 'install') : null);
          if (next) { event.preventDefault(); document.getElementById('agent-tab-' + next).click(); }
        };
        tabs.append(tab);
      }
      body.append(tabs);
    }
    const card = el('div', 'agent-card'), pre = el('pre');
    card.id = 'agent-card';
    card.setAttribute('role', missing ? 'tabpanel' : 'region');
    card.setAttribute('aria-labelledby', missing ? 'agent-tab-' + kind : disclosure.id);
    card.tabIndex = 0;
    card.dataset.tab = kind;
    const content = kind === 'install' ? install : session;
    const control = button('Copy instructions', 'copy', () => copy(kind, content), 'agent-copy');
    control.id = 'agent-copy';
    control.dataset.tab = kind;
    pre.append(el('code', '', content));
    card.append(control, pre);
    body.append(card);
  }
  function render(box, bridge) {
    const loaded = typeof bridge.enabled === 'boolean';
    const enabled = !!bridge.enabled, background = enabled && !!bridge.background;
    box.append(
      switchRow('Use in Agent', 'Use Samare with agent clients.',
        (enabled ? 'Disable' : 'Enable') + ' Use in Agent', enabled, !loaded, 'bridgeEnabled'),
      switchRow('Keep links working in the background', 'Samare links stay openable even when the app is closed.',
        background ? 'Turn off background links' : 'Keep links working in the background',
        background, !enabled, 'bridgeAuto'),
    );
    if (enabled) {
      const note = el('p', 'quiet agent-note');
      note.append('Agents may ask before connecting to Samare the first time. If yours gets stuck instead of asking, ',
        button('send it this', null, () => copy('recovery', recovery), 'note-action'), '.');
      box.append(note);
    }
    if (!loaded) { box.append(el('p', 'quiet', 'Checking Use in Agent…')); return; }
    const issues = bridge.issues || [];
    clearTimeout(statusTimer);
    if (bridge.portConflict) {
      statusTimer = setTimeout(() => host('bridgeStatus'), 1600);
      const {port, process, pid} = bridge.portConflict;
      const owner = process ? process + (pid ? ' (PID ' + pid + ')' : '') : 'another process';
      const notice = el('div', 'agent-error');
      notice.setAttribute('role', 'status');
      notice.append(el('strong', '', 'The saved link port is busy.'),
        el('p', '', owner + ' is using port ' + port + '. New links use port ' + bridge.port +
          '. Earlier links will work again when the saved port becomes available.'));
      box.append(notice);
    }
    if (bridge.error) {
      const error = el('div', 'agent-error');
      error.setAttribute('role', 'status');
      error.append(el('strong', '', 'Setup could not finish.'), el('p', '', bridge.error),
        button('Copy diagnostic command', null, () => copy('diagnostic', cli + ' doctor'), 'note-action'));
      box.append(error);
    }
    const states = clients.map(([key]) => stateOf(bridge, key));
    const ready = (s) => s === 'ready' || s === 'fallback';
    const status = el('section', 'setting agent-status');
    status.setAttribute('aria-label', 'Setup status');
    status.append(el('h3', '', 'Setup status'));
    const commandRow = el('div', 'statusrow'), command = el('div');
    const needsRepair = bridge.commandStatus === 'modified' || bridge.commandStatus === 'outdated';
    let message = 'Turn on Use in Agent to install the command.';
    if (enabled) message = bridge.commandInstalled ? 'Installed. Agents run it for you.'
      : needsRepair ? 'The command needs repair.' : 'Install the command to use Samare with agents.';
    command.append(el('span', '', 'Samare command'), el('p', '', message));
    commandRow.append(command);
    if (enabled && bridge.commandInstalled) {
      const check = el('span', 'command-check');
      check.setAttribute('role', 'img');
      check.setAttribute('aria-label', 'Installed');
      check.append(icon('check'));
      commandRow.append(check);
    } else if (enabled) {
      const action = button(needsRepair ? 'Repair' : 'Install', null, () => change('bridgeRepair'), 'bttn');
      action.disabled = busy;
      commandRow.append(action);
    }
    const skillRow = el('div', 'statusrow'), skill = el('div'), badges = el('div', 'client-options');
    skill.append(el('span', '', 'Agent skill'), el('p', '', !enabled ? 'Turn on Use in Agent to install the skill.'
      : states.some(ready) ? 'Start a new chat in an enabled client to load the skill.' : 'No agent skill detected. Install it below.'));
    clients.forEach(([key, label], index) => {
      const state = states[index], badge = el('span', 'client-badge'), logo = el('img');
      badge.setAttribute('role', 'img');
      badge.title = label + ' ' + descriptions[state];
      badge.setAttribute('aria-label', badge.title);
      badge.dataset.state = state;
      const darkCursor = key === 'cursor' && document.documentElement.dataset.theme === 'dark';
      logo.src = 'agent-icons/' + (darkCursor ? 'cursor-dark' : key) + '.svg';
      logo.alt = '';
      logo.draggable = false;
      logo.className = 'client-' + key;
      badge.append(logo);
      badges.append(badge);
    });
    skillRow.append(skill, badges);
    status.append(commandRow, skillRow);
    if (enabled) instructions(status, !states.every(ready));
    box.append(status);
    paintCopyButton();
    if (enabled && (issues.length || !bridge.commandInstalled || states.includes('repairRequired') ||
        states.includes('notInstalled'))) {
      const missingOnly = !needsRepair && !states.includes('repairRequired') &&
        (!bridge.commandInstalled || states.includes('notInstalled'));
      const repair = button(missingOnly ? 'Install missing items' : 'Repair setup',
        null, () => change('bridgeRepair'), 'bttn agent-repair');
      repair.disabled = busy;
      box.append(repair);
    }
  }
  return {render, copyResult, receivedStatus() { busy = false; }, dispose() { clearTimeout(statusTimer); clearTimeout(resetCopy); pendingCopy = null; }};
};
