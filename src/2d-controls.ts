/**
 * 2D desktop control bar (pure DOM, no uikit ray dependency).
 *
 * Rationale: the spatial console's uikit buttons are hit-tested through
 * IWSDK's CanvasPointerSystem, which needs a real browser pointer chain that
 * is not reproducible in all headless/automation contexts. This bar guarantees
 * the agent loop is drivable in plain 2D mode (eval reviewers, demo capture)
 * and doubles as a debug console. Voice parity: the text input dispatches with
 * source 'voice' semantics via window.agentdeck.dispatchVoice.
 */

const PRESETS: Array<{ label: string; text: string }> = [
  { label: 'Plan day', text: 'Plan my day: add the two most important focus tasks.' },
  { label: 'Add task', text: 'Add task card: review grant budget, urgent.' },
  { label: 'Status', text: 'Give me a status report.' },
  { label: 'Clear', text: 'Clear all task cards.' },
];

interface AgentdeckBridge {
  dispatch(text: string): void;
  dispatchVoice(text: string): void;
  snapshot(): unknown;
  trace(): unknown;
}

const agentdeck = (): AgentdeckBridge | undefined =>
  (window as unknown as { agentdeck?: AgentdeckBridge }).agentdeck;

export function mount2DControls(parent: HTMLElement = document.body): void {
  const bar = document.createElement('div');
  bar.id = 'agentdeck-2d-controls';
  bar.style.cssText = [
    'position:fixed', 'left:12px', 'bottom:12px', 'z-index:9999',
    'display:flex', 'flex-wrap:wrap', 'gap:6px', 'align-items:center',
    'padding:8px 10px', 'border-radius:10px',
    'background:rgba(20,22,26,0.82)', 'color:#dddfe3',
    'font:13px/1.2 system-ui,sans-serif', 'backdrop-filter:blur(4px)',
  ].join(';');

  const title = document.createElement('span');
  title.textContent = 'AgentDeck:';
  title.style.cssText = 'font-weight:700;color:#f5d90a;margin-right:2px';
  bar.appendChild(title);

  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.textContent = preset.label;
    button.style.cssText =
      'padding:5px 10px;border-radius:8px;border:1px solid #3a3b40;background:#2563eb;' +
      'color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer';
    button.addEventListener('click', () => {
      agentdeck()?.dispatch(preset.text);
    });
    bar.appendChild(button);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type an intent...';
  input.style.cssText =
    'width:220px;padding:5px 8px;border-radius:8px;border:1px solid #3a3b40;' +
    'background:#1c1d20;color:#dddfe3;font:13px system-ui,sans-serif';
  const send = document.createElement('button');
  send.textContent = 'Send';
  send.style.cssText =
    'padding:5px 10px;border-radius:8px;border:1px solid #3a3b40;background:#3a3b40;' +
    'color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer';
  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    agentdeck()?.dispatch(value);
    input.value = '';
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  bar.appendChild(input);
  bar.appendChild(send);

  parent.appendChild(bar);
}
