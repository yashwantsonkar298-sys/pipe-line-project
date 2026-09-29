# NexusFlow architecture

There are **two** execution paths, and they share almost nothing but ADB:

Both AI paths reach the model through one swappable provider (`server/ai/`), so
"which model vendor" is a detail neither of them knows.

| | Classic pipeline | Vani Autopilot |
|---|---|---|
| Entry | `execute_command` / `ai_chat` | `agent_task` |
| Brain | `nlp.js` keyword parser, or `ai/assistant.js` | `agent/agentLoop.js` |
| Action space | `actions/registry.js` — 30 fixed intents | `agent/tools.js` — 10 primitives |
| Sees the screen | no | yes, every step |
| Shape | parse → one action | bounded Perceive/Plan/Act/Verify loop |

---

# Part 1 — Vani Autopilot (the agent)

## The loop

```
 voice / text ─► submitCommand ─► WS {type:'agent_task'}
                                        │
                    index.js: enqueueAgentTask → JobQueue (per device)
                                        │
                    pipeline.js: runAgentText(text, session)
                      · checks the device is connected
                      · creates a trace (agent/trace.js)
                      · maps agent phases onto pipeline_step 0-4 for the HUD
                                        │
                    agent/agentLoop.js: runAgentTask({...})
                                        │
   round 0  PLAN     messages.create(buildPlanPrompt) → parsePlan → agent_plan
                                        │
   ┌──────────────────────── each round ────────────────────────────────────┐
   │ budget.checkBeforeStep()   → step cap · cost cap · abort → stop cleanly │
   │                                                                        │
   │ PERCEIVE  perception.captureState({deviceId, withImage})               │
   │           · uiautomator dump → parseUiXml → elements[]                 │
   │           · screencap only when asked for (step 1 / screenshot / degraded)│
   │                                                                        │
   │ VERIFY    screenSignature(state) vs last → changed? repeats?           │
   │           3 identical screens → inject STUCK_NOTE → model replans      │
   │                                                                        │
   │ THINK     messages.create({system, tools, messages: history})          │
   │           history pruned: old listings and images collapse to stubs    │
   │                                                                        │
   │ ACT       take the FIRST tool_use only                                 │
   │           safety.classifyAction(action, state)                         │
   │             block   → tool_result is_error, "do not retry"             │
   │             confirm → dry run? stop and narrate                        │
   │                       else ctx.confirm() → the existing WS dialog       │
   │             safe    → tools.runPrimitive() → adb.js                    │
   │           extra tool_use blocks get "only one action per turn"          │
   └────────────────────────────────────────────────────────────────────────┘
                                        │
              finish → done · ask_user → pause · caps/abort → stop
```

## Agent modules

### `agent/perception.js` — what the phone looks like
- `dumpUi(deviceId)` — `uiautomator dump` to `/sdcard`, then `exec-out cat`.
- `parseUiXml(xml)` — pure, dependency-free. Three OEM realities it exists to
  absorb, all observed on a real Vivo dump:
  1. **Row + label split.** Android list rows are an unlabelled clickable
     container wrapping a labelled `TextView`. Neither half is usable alone, so
     the label inherits the row's clickability and the container is dropped.
  2. **Layout noise.** A resource id is only used as a label for *interactive*
     nodes. Otherwise `content_parent`, `nestedlayout`, `bbk_zonelist_bottom`
     and friends become "elements" and crowd out real targets — on the test
     screen this alone cut 45 elements to 32.
  3. **Stale toggle state.** A settings row can report `checked` on both the row
     and the real `Switch` nested inside it, and *the row's copy can be wrong*.
     The inner widget wins on state, the outer row keeps the label and the
     tappable area. Without this the agent reads "USB debugging: off" while
     connected over USB debugging, and tries to "fix" it.

  Then: drops disabled nodes, dedupes near-identical overlaps, sorts
  top-to-bottom, caps at 60, and derives the screen size from the largest
  node's bounds.
- `captureState({deviceId, withImage})` — never throws. On dump failure returns
  `degraded: true` and fetches a screenshot so the agent can still use `tap_xy`.
  The dump, the foreground-app probe and the screencap are **issued
  concurrently** — they are independent, and this runs before every action.
  Measured on a Vivo V2437: **~2.5 s either way**, because the screenshot hides
  behind the dump that dominates the critical path. Sequentially it was ~3.3 s
  text-only and ~4.3 s with an image.
- `serializeForModel(state)` — the compact numbered listing (~1-1.5k tokens).
- `screenSignature(state)` — stable fingerprint driving stuck detection.
- `overlayElements(state)` — the minimal shape the browser overlay needs.

### `agent/tools.js` — what the phone can be told to do
`PRIMITIVES` maps each name to a description + JSON schema.
`runPrimitive(name, input, ctx)` validates with `security.assertJsonSchema`,
then calls `screenMirror.sendTap/sendSwipe` or `adb.typeText/openApp/pressKeyEvent`.
`finish` / `ask_user` return a `control` object instead of touching the device;
`screenshot` returns `requestImage: true`.

### `agent/safety.js` — what must not happen
`classifyAction(action, state, {appAllowlist})` → `safe | confirm | block`,
purely from the target label, the surrounding screen text and the foreground
package — so it works in any app with no per-app rules. Blocks credential entry
(password fields, OTP/PIN/CVV labels, and code-shaped strings on a credential
screen even when focus is not reported). Unknown actions fail closed.

### `agent/budget.js` — when to stop
Step counter, token→USD estimate, cost cap, and an `abort()` the WS
`agent_abort` handler calls via `session.agentBudget`. `checkBeforeStep()`
returns a stop reason rather than throwing, so every run ends with a clean
`agent_done`. `PRICE_PER_MTOK` tracks the default model in `ai/client.js` —
change one and change the other, or the cost cap quietly means something else.

**Per-turn `max_tokens`.** `ACT_MAX_TOKENS` is deliberately generous (4096).
On thinking-enabled models the reasoning is billed against `max_tokens`, so a
tight ceiling truncates the turn *before* the `tool_use` block and the loop sees
a step that took no action. `stop_reason: 'max_tokens'` is therefore handled as
its own explicit outcome rather than falling through to the no-tool nudge. The
cost cap, not `max_tokens`, is the spending control.

### `ai/` — the model provider, behind one seam

The agent loop and the assistant only ever call
`client.messages.create({model, max_tokens, system, tools, messages})` and read
back `{content: blocks[], stop_reason, usage}`. **That interface is NexusFlow's
own**, not a vendor's — which is what let the provider be swapped from Anthropic
to Gemini without touching `agentLoop.js` beyond its error-handling import.

```
agentLoop.js / assistant.js
        │  client.messages.create(...)          ← unchanged call site
        ▼
ai/provider.js          picks the provider, memoised per key + pacing
        ├── ai/gemini.js  → POST /v1beta/interactions   (plain fetch, no SDK)
        └── ai/mock.js    → scripted steps, no network
```

- **`ai/gemini.js`** — `toInteractionInput()` turns our `messages[]` into
  Gemini's step array, flattening our nested image block into
  `{type:'image', data, mime_type}`. `toInternalResponse()` turns `steps[]` plus
  `status` back into our blocks and `stop_reason`, reading `id` off a
  `function_call` step so tool results still match their calls.

  **Only `user_input` and `model_output` are ever sent as input.** Established
  by probing the live API, not from the docs:
    - echoing a `function_call` step back is rejected in every field spelling,
      even verbatim from the response;
    - a `function_result` step is accepted only as the *last* entry in `input`,
      and our loop always appends the next screen observation after it.

  So a tool's outcome travels as text in the following user turn ("Result of
  open_app: Opened Clock"). The model still sees its own stated intent, what
  happened, and the new screen.

  Sends `store: false`: history stays client-side, because the loop
  deliberately prunes old screenshots and server-side history would retain them
  all. (`previous_interaction_id` chaining is not an alternative here —
  `store: false` returns no interaction id to chain from.)
- **Throttle and retry.** The free tier's binding limit is requests per minute,
  so the client paces itself to `aiRequestsPerMinute` and retries 429/5xx with
  exponential backoff, honouring `Retry-After`. An unhandled 429 is the single
  likeliest way a live demo falls over.
- **`ai/geminiSchema.js`** — Gemini's `parameters` accepts only an OpenAPI
  subset, so `additionalProperties`, `minimum`, `maximum`, `minLength` and
  `maxLength` are stripped and **folded into the property description** instead.
  Nothing is lost: `security.assertJsonSchema` still validates every tool input
  against the real schema before a primitive runs. The model is merely told the
  bounds in prose rather than in keywords.
- **`ai/mock.js`** — scripted decisions, real execution. Used to rehearse the
  demo without burning quota. It reads the *task*, not the raw prompt: the
  planning prompt embeds a worked example, and matching against that made every
  task look like the airplane one.
- **`ai/errors.js`** — `AiAuthError` / `AiRateLimitError` / `AiConnectionError` /
  `AiSafetyError`, plus `describeAiError()` so both callers word failures alike.

### `env.js` — why `.env` loading is its own module
ES module imports are evaluated before any statement in the importing file, so
calling `loadEnvFile()` partway down `index.js` ran *after* `ai/client.js` had
already read `process.env.NEXUSFLOW_AI_MODEL`. A model pinned in `.env` was
silently ignored while the API key — read lazily inside `getGeminiKey()` — worked
fine, which made the bug easy to miss. `server/env.js` loads `.env` on import
and must stay the **first** import of every entry point (`server/index.js`,
`bench/run.js`).

### `agent/trace.js` — what happened
Writes `server/.runtime/traces/<runId>/trace.json` + `stepNN.png`.
`traceToMacro()` rewrites `tap_element` steps as `tap_xy` using the normalized
centre recorded at the time, producing a schema-valid macro that replays with
no model call. Run ids are validated against path traversal.

## Agent WebSocket events

Client → server: `agent_task` (`{text, source}`), `agent_abort`.

Server → client: `agent_trace` (`{runId}`), `agent_start`, `agent_plan`
(`{subgoals}`), `agent_phase` (`{phase, step}`), `agent_observe`
(`{elements, appPackage, degraded}`), `agent_step` (`{thought, budget}`),
`agent_verify` (`{changed, repeats}`), `agent_action`
(`{description, outcome, target, reason}`), `agent_ask`, `agent_event`,
`agent_done` (`{ok, reason, summary, steps, costUsd}`).

Confirmation reuses the existing `confirm_request` / `confirm_action` pair.

## Agent HTTP routes

`GET agent/status` · `POST agent/run` · `GET agent/traces` ·
`GET agent/traces/:id` · `GET agent/traces/:id/step/:step.png` ·
`POST agent/traces/:id/save-as-macro`.

## The Agent Console (`public/js/agentConsole.js`)

An IIFE with its own `socket.addEventListener('message')` — app.js's message
switch is untouched. It draws the numbered overlay on the **existing** live
mirror (`#phone-screenshot`), aligned with `nxImageContentRect()`, which
accounts for `object-fit: contain` letterboxing; the same helper now also fixes
the mirror's own tap mapping. Step thumbnails are captured from the mirror
image into a canvas, so the trace rail costs no extra ADB round trip.

---

# Part 2 — the classic pipeline

## Request flow

Every command — typed, spoken, from the Vani chat, or a macro step — ends up at
**`runAction(intent, params, ctx)`** in `server/actions/registry.js`.

```
                    ┌─────────────────────────── browser ───────────────────────────┐
   voice.js  ──►  submitCommand({command, alternatives[], source:'voice'})
   text box  ──►  submitCommand({command})
   aiChat.js ──►  {type:'ai_chat', message}
                    └──────────────────────── WebSocket (wsClient.js, reconnecting) ─┘
                                           │
                        server/index.js  ws.on('message')
                                           │  enqueueCommand / ai_chat
                                           ▼
                        server/jobQueue.js   — one job at a time per deviceId,
                                               concurrent across devices
                                           ▼
                        server/pipeline.js   runCommandText(text, session, opts)
                          │
                          ├─ "ai:" prefix ─────────────► ai/assistant.js
                          │
                          ├─ parseCandidates(candidates)      (nlp.js)
                          │     normalizeHinglish → parseCommand → first non-UNKNOWN
                          │
                          ├─ intent !== UNKNOWN ─► runAction(intent, details, ctx)   (registry.js)
                          │
                          └─ intent === UNKNOWN ─► ai/assistant.js
                                                    (candidate list handed to the model)
                                           ▼
                        ai/assistant.js   tool-use loop:
                          messages.create({ tools: listAiTools() })
                          while stop_reason === 'tool_use':
                            for each tool_use → runAction(intentForAiTool(name), input, ctx)
                            (destructive → ctx.confirm() first)
                            post ALL tool_result blocks in one user message
                                           ▼
                        registry.runAction   assertJsonSchema(params) → action.run(params, ctx)
                                           ▼
                        server/adb.js   runAdbArgs(['-s', id, ...])  (execFile, no shell)
```

## Key modules

### `actions/registry.js` — the single execution layer
`ACTIONS[intent] = { destructive, local?, readOnly?, params (JSON schema),
required, aiName, run(params, ctx), tts(params), summary(params) }`.

- `runAction()` validates `params` against the same schema the model sees, runs
  the confirmation gate when `ctx.requireConfirm && action.destructive`, then
  calls `action.run`. This validation is the real gate — the provider adapter
  may strip keywords the vendor cannot express, but nothing reaches a device
  without passing the full schema here.
- `listAiTools()` projects every action with an `aiName` into a tool entry
  (`input_schema` = the action's `params`), which the provider then translates.
- `run` handlers are thin wrappers over `adb.js` exports — no ADB logic lives
  here.

### `pipeline.js`
`runCommandText(text, session, opts)` — the shared entry point. Emits
`pipeline_*` WS events for the visualiser. `configurePipeline({ broadcast,
startPcShutdown, runMacroByName })` injects transport so the module stays
import‑safe for tests. `runAssistantText()` wraps the assistant and treats
"AI disabled" as a normal state (soft reply, no failure event).

### `ai/`
- `client.js` — `getClient()`, `AI_MODEL` (default `gemini-3.8-flash`),
  `isAiEnabled()` (true with a `GEMINI_API_KEY`, or with the mock provider).
  Delegates provider choice to `provider.js`; see the provider section above.
- `tools.js` — `buildTools()` = `listAiTools()`, plus `intentForAiTool`.
- `systemPrompt.js` — the Vani persona + rules ("call the tool, don't claim").
- `assistant.js` — `runAssistant({ text, session, onEvent, actionCtx, client })`.
  History lives on `session.aiHistory` (per socket, never a module global).
  Errors are mapped through `describeAiError`.

### `nlp.js`
`parseCommand(text, contacts, context)` — keyword/regex intent parser with
safety guards (informational questions and negations never fire destructive
intents). `normalizeHinglish(text)` fixes common speech mis‑hearings.
`bestFuzzyContact()` (Dice ≥ 0.8 or Levenshtein ≤ 2). `parseCandidates()` runs
the parser over an ordered list of speech candidates and returns the first that
resolves.

### `security.js` (consumed by `index.js`)
`createHttpAccessMiddleware`, `authorizeWebSocketUpgrade`, `createRateLimiter`,
`assertJsonSchema` / `validateJsonSchema`, `sendSafeError`. Bearer token compared
in constant time; loopback‑only when no token is configured.

### `jobQueue.js`
`new JobQueue({ onEvent })`; `enqueue(resourceKey, task, meta)`. FIFO per key,
concurrent across keys, terminal‑state history, `cancel()` for not‑yet‑started
jobs. `resourceKey` = the current device id (`deviceState.currentDeviceKey()`).

### `deviceState.js`
`getDiagnostics()` — one in‑flight probe at a time + a 1.5 s cache, so the 5 s
server poll and any client request share one set of ADB calls.
`invalidateDiagnostics()` forces a re‑probe.

### `macros.js`
Two flavours share one driver. `kind: 'command'` (the original) runs each step's
natural-language string through `runCommandText`. `kind: 'agent'` replays a
`primitives[]` array captured from an agent trace via an injected
`executePrimitive` — no model call at all. `index.js` supplies that executor and
re-reads the screen first, so a recorded action lands on a freshly-perceived
state. Macros with no `kind` keep working unchanged.

## WebSocket messages

Client → server: `execute_command` (`{command, alternatives?, source?}`),
`ai_chat` (`{message}`), `agent_task` (`{text, source}`), `agent_abort`,
`confirm_action` (`{id, approved}`), `cancel_shutdown`,
`cancel_job` (`{jobId}`), `request_diagnostics`.

Server → client: `diagnostics`, `adb_log`, `pipeline_start` / `pipeline_step` /
`pipeline_end`, `command_queued`, `job_event`, `macro_step`, `confirm_request`
(`{id, summary}`), `ai_delta` / `ai_reply` / `ai_action` / `ai_event`,
`shutdown_timer_*`, `system_alert`.

## HTTP routes (all under `/api`, all behind the auth gate except `auth/*` and `health`)

`GET health` · `POST auth/login` · `GET auth/status` ·
`GET/POST/DELETE contacts` · `GET/POST config` · `GET diagnostics` ·
`GET screenshot` + `GET screen/current` · `POST sync-contacts` ·
`POST wireless/enable|disable` ·
`GET macros` `POST macros` `PUT/DELETE macros/:id` `POST macros/:id/run` ·
`GET agent/status` `POST agent/run` `GET agent/traces` `GET agent/traces/:id`
`GET agent/traces/:id/step/:step.png` `POST agent/traces/:id/save-as-macro` ·
`GET jobs` `POST jobs/:id/cancel` ·
`GET mirror/frame` `POST mirror/tap` `POST mirror/swipe` ·
`POST unlock` ·
`GET files/list` `POST files/upload` `GET files/download` `DELETE files/delete`
`POST files/mkdir` `GET files/storage`.

## Graceful shutdown

`SIGINT` / `SIGTERM` → clear the diagnostics poll, cancel any PC‑shutdown timer,
wait up to 4 s for a running job, close every WebSocket, `server.close()`, exit.
