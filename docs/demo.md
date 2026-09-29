# Demo script — Vani Autopilot

Target: **5 minutes**. Three live scenarios, one number, one closing line.

---

## Before you go on stage

- [ ] `GEMINI_API_KEY` in `.env` (free from aistudio.google.com); run
      `npm start` and confirm the AUTOPILOT tab says **READY** (not "AI OFF").
- [ ] Rehearse with **`NEXUSFLOW_AI_PROVIDER=mock`** — it drives the phone for
      real but scripts the decisions, so you can run the whole demo as many
      times as you like without touching the free-tier quota.
- [ ] Phone connected, **unlocked**, screen timeout set long, brightness up.
- [ ] Airplane mode **off**, Bluetooth **off**, YouTube installed and logged in.
- [ ] Run each scenario once as a rehearsal — it also warms the ADB daemon.
- [ ] `npm run bench` beforehand; screenshot the summary table for the slide.
- [ ] **Record a clean run as a backup video.** Phones and stage Wi-Fi fail.
- [ ] Set **DRY RUN off** for scenarios 1-2, **on** for scenario 3.
- [ ] Close other apps on the phone; put it on a stand facing the camera.

---

## Scenario 1 — "it can do a thing nobody wired" (60 s)

> Type or say: **"airplane mode on kar do"**

Point at, in this order:

1. **PLAN** — the subgoals it wrote before touching the phone.
2. **The phone frame** — numbered boxes over every real UI element. "It is not
   guessing pixels. It reads the actual view hierarchy."
3. **The green glowing box** just before the tap, then the ripple where it landed.
4. **REASONING** — one short thought per step.
5. **TRACE** — a thumbnail per step, and the meter: *N steps, $0.0X*.

Line to say: *"Nobody wrote an 'airplane mode' function. It found the toggle."*

---

## Scenario 2 — "and it recovers" (75 s)

> Say: **"open YouTube and search for lofi beats"**

This crosses apps, types, and submits — more places to go wrong, which is the
point. If it takes a wrong turn, **let it**: the VERIFY line will say *screen
unchanged*, and it will try a different route. That recovery is the demo.

Then hit **★ SAVE AS MACRO**, switch to the MACROS tab, and run it.

Line to say: *"It solved it once with the model. Now it is a one-tap macro that
replays with zero AI calls. Learn once, replay forever."*

---

## Scenario 3 — "and it knows when to stop" (75 s)

Turn **DRY RUN on** first. Then:

> Say: **"order something on <a shopping app>"**

It navigates all the way to checkout and **stops**, narrating the tap it *would*
have made. Show the amber `DRY RUN` card in the trace.

Now turn DRY RUN **off** and re-run the last step: the **confirmation dialog**
appears instead. Decline it — the agent reports that plainly and does not retry.

Finally, mention the two it will never do at all:

- typing into a password field
- filling an OTP / CVV

Line to say: *"An agent with a real SIM and real payment apps needs a brake.
Every action is classified before it runs — and there is always a STOP."*

(Hit **STOP** mid-run once, anywhere, to show it halts within a step.)

---

## The number (20 s)

Show the `npm run bench` table.

> *"Eight scripted tasks, each verified by reading device state over ADB — the
> agent never sees the checker. N of 8 autonomous, median M steps, about $X per
> task."*

---

## Closing (20 s)

> *"Every phone assistant today can only do what someone pre-wired. This one
> reads the screen, so the action space is whatever is on it. It plans, verifies,
> recovers, stops before anything irreversible — and everything it learns
> becomes free to repeat."*

---

## If something breaks

| Symptom | Do this |
|---|---|
| Overlay boxes missing / misaligned | The mirror stopped. Click **LIVE MIRROR**; the agent still works without it. |
| Agent stuck on one screen | Let it — the stuck detector and replan is a feature. After 3 tries, hit STOP and say so. |
| `uiautomator` fails on a screen | It falls back to vision + coordinates. Point that out; it is designed for. |
| A step feels slow | Normal: ~2.5 s to read the screen + the model call, so 5-8 s per step. Talk over it — narrate what it is doing. Don't pick 10-step tasks. |
| Phone disconnects | `adb kill-server` then replug. Meanwhile, play the backup video. |
| Rate limited (free tier, ~requests/min) | The provider paces and retries automatically; if it still gives up the run ends with a readable message. Wait ~30 s, or switch to the saved macro demo. |
| API unreachable / key rejected | Restart with `NEXUSFLOW_AI_PROVIDER=mock` — the phone is still driven live, only the decisions are scripted. Say so honestly; the safety layer and the whole pipeline are unchanged. |

---

## Q&A prep

**"Is this just a screen scraper?"** No — the hierarchy gives it semantics
(labels, roles, checked state), and it *verifies* after every action instead of
firing a fixed script.

**"What about apps that block screenshots?"** Those degrade to hierarchy-only,
or refuse entirely. We do not pretend otherwise; the state reports `degraded`.

**"How do you stop it doing something awful?"** Three layers: a classifier that
runs before every single action, a human confirm on anything irreversible, and
hard step/cost caps plus a STOP that halts within one step. Credential entry is
refused outright, not confirmed.

**"Cost?"** It runs on Gemini's AI Studio **free tier** — the meter shows tokens
per run, and there is a hard step cap. The binding limit is requests per minute,
so the client paces itself. And a solved task can be frozen into a macro that
costs nothing at all to repeat.

**"Why not an SDK?"** There is no model SDK in this project — the provider is
~200 lines of `fetch` behind a one-method interface. That is how the whole thing
moved from one model vendor to another without the agent loop changing.

**"Why not just use the accessibility service / an on-device model?"** Would be
the production answer; ADB gets the same hierarchy with zero install on the
phone, which is what makes this demoable on any device in 30 seconds.
