/**
 * A scripted provider that never touches the network.
 *
 * `NEXUSFLOW_AI_PROVIDER=mock` drives the whole product — plan checklist,
 * element overlay, reasoning stream, safety gate, trace rail, learn-as-macro —
 * with no API key and no quota. It exists for two reasons:
 *
 *  - rehearsing the demo without burning a free-tier request budget that is
 *    measured in requests per minute;
 *  - having something to fall back to on stage if the network or the API is
 *    having a bad day.
 *
 * It really does drive the phone: the primitives it returns are executed for
 * real. Only the *decisions* are canned.
 */

const RESPOND_AFTER_MS = 350;

let counter = 0;
const nextId = () => `mock_${Date.now().toString(36)}_${(counter += 1)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const text = (t) => ({ type: 'text', text: t });
const call = (name, input) => ({ type: 'tool_use', id: nextId(), name, input });

const reply = (content, stopReason) => ({
  content,
  stop_reason: stopReason,
  usage: { input_tokens: 900, output_tokens: 60 }
});

/**
 * Scripts are matched loosely against the task text. Each is a list of turns;
 * the loop consumes one per step.
 *
 * `tap` steps deliberately aim at element #0 — on a real screen that is the
 * topmost element, which keeps the mock honest: it can miss, and you get to see
 * the verify/stuck path do its job.
 */
const SCRIPTS = [
  {
    match: /airplane|flight|hawai/i,
    plan: ['Open Settings', 'Find the network section', 'Turn on Airplane mode'],
    turns: [
      [text('Opening Settings.'), call('open_app', { appName: 'Settings' })],
      [text('Letting the app settle.'), call('wait', { ms: 900 })],
      [text('Looking for the airplane mode row.'), call('screenshot', {})],
      [text('Tapping the first row I can see.'), call('tap_element', { index: 0 })],
      [text('Done.'), call('finish', { success: true, summary: 'Mock run complete — Airplane mode reached.' })]
    ]
  },
  {
    match: /youtube|video|search/i,
    plan: ['Open YouTube', 'Tap search', 'Type the query'],
    turns: [
      [text('Opening YouTube.'), call('open_app', { appName: 'YouTube' })],
      [text('Waiting for it to load.'), call('wait', { ms: 1200 })],
      [text('Tapping search.'), call('tap_element', { index: 0 })],
      [text('Typing the query.'), call('type_text', { text: 'lofi beats' })],
      [text('Done.'), call('finish', { success: true, summary: 'Mock run complete — search entered.' })]
    ]
  },
  {
    // Shows the safety gate: this one walks into a confirm-worthy action.
    match: /order|buy|pay|checkout|kharid/i,
    plan: ['Open the app', 'Reach checkout', 'Stop before paying'],
    turns: [
      [text('Opening the shop.'), call('open_app', { appName: 'Settings' })],
      [text('Navigating toward checkout.'), call('swipe', { direction: 'up' })],
      [text('This is the irreversible step.'), call('tap_element', { index: 0 })],
      [text('Stopping here.'), call('finish', { success: false, summary: 'Mock run stopped at the irreversible step.' })]
    ]
  }
];

const FALLBACK = {
  plan: ['Look at the current screen', 'Take one action', 'Report back'],
  turns: [
    [text('Taking a look at the screen first.'), call('screenshot', {})],
    [text('Scrolling to see more.'), call('swipe', { direction: 'up' })],
    [text('Nothing further to do without a real model.'), call('finish', {
      success: true,
      summary: 'Mock provider: scripted run finished. Set GEMINI_API_KEY for a real one.'
    })]
  ]
};

function scriptFor(task) {
  return SCRIPTS.find((s) => s.match.test(task)) || FALLBACK;
}

/** The planning turn asks for prose; every other turn asks for an action. */
function isPlanRequest(params) {
  const messages = params.messages || [];
  if (messages.length !== 1) return false;
  const content = messages[0]?.content;
  return typeof content === 'string' && /subgoals/i.test(content);
}

/**
 * Pull out just the user's task.
 *
 * This has to be precise: the planning prompt embeds a worked *example*
 * ("Turn on Airplane mode"), so matching a script against the raw prompt text
 * makes every task look like the airplane one.
 */
function extractTask(params) {
  for (const message of params.messages || []) {
    if (message.role !== 'user') continue;
    const raw = typeof message.content === 'string'
      ? message.content
      : (message.content || []).find((b) => b.type === 'text')?.text || '';
    if (!raw) continue;

    const quoted = /Task from the user:\s*"([^"]*)"/.exec(raw);
    if (quoted) return quoted[1];

    const labelled = /^Task:\s*(.+)$/m.exec(raw);
    if (labelled) return labelled[1].trim();

    return raw;
  }
  return '';
}

/**
 * @param {object} [options]
 * @param {number} [options.latencyMs] pretend-thinking delay, so the UI's
 *   loading states are exercised the way a real run exercises them.
 */
export function createMockClient({ latencyMs = RESPOND_AFTER_MS } = {}) {
  // Keyed per task text so two runs in one session do not share a cursor.
  const cursors = new Map();

  async function create(params = {}) {
    await sleep(latencyMs);
    const task = extractTask(params);
    const script = scriptFor(task);
    const key = task.slice(0, 120);

    if (isPlanRequest(params)) {
      // Every run opens with a plan request, so this is the reliable "new run"
      // signal — without it a second run of the same task resumes mid-script.
      cursors.set(key, 0);
      return reply([text(script.plan.map((s) => `- ${s}`).join('\n'))], 'end_turn');
    }

    const index = cursors.get(key) ?? 0;
    cursors.set(key, index + 1);

    const turn = script.turns[index];
    if (!turn) {
      return reply(
        [text('Mock script exhausted.'), call('finish', { success: true, summary: 'Mock run finished.' })],
        'tool_use'
      );
    }
    return reply(turn, 'tool_use');
  }

  return { messages: { create }, provider: 'mock' };
}
