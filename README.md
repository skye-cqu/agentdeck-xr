# AgentDeck XR

**Spatial agent workbench for Meta VR — watch an AI agent think, plan, and act in your room.**

> One-line pitch (Agentic Interaction track, Meta VR Start Developer Competition 2026):
> *AgentDeck turns a VR workbench into a live agent observatory — every intent is parsed, planned
> (real LLM or deterministic fallback), executed as spatial tool calls (task cards materialize on a
> 3D rail), and traced step-by-step on a console you can stand next to.*

Built with **IWSDK** (Immersive Web SDK) + Three.js ECS. Runs in any WebXR browser (Quest Browser)
and on desktop via the built-in emulator (IWER) — no headset required for development.

## What works today (PoC)

- **Spatial console panel** (`public/ui/console.uikitml`, Horizon kit): status line, intent, plan
  reasoning, result, 6-row trace ring buffer, task counters, 4 preset-intent buttons.
- **Agent decision loop** (`src/agent/loop.ts`): event-driven `intent → plan → act → trace`
  state machine with a bounded queue; UI and 3D mirror the phases in real time.
- **Pluggable LLM provider** (`src/agent/llm.ts`): OpenAI-compatible `/chat/completions` (JSON mode,
  bounded timeout) with **degrade-to-mock on every failure path** — no key, timeout, HTTP error, or
  bad JSON falls back to a deterministic keyword planner, so the demo never blocks.
- **Spatial tool calls** (`src/agent/tools.ts` + `src/agent-console.ts`): `plan_day`, `spawn_task`,
  `clear_tasks`, `report_status`. Tool calls are scene commands; task cards spawn as tinted 3D slabs
  on the left rail (queued = amber, acting = blue pulse, done = green).
- **Headless/2D hooks**: `window.agentdeck.dispatch(text)`, `dispatchVoice(text)`, `snapshot()`,
  `trace()` — voice input rides the exact same dispatch path as text (`source: 'voice'`).

## Run locally

Requires Node >= 20.19 (CI and docs tested on Node 22).

```sh
npm install
npm run dev        # iwsdk dev session, opens https://localhost:8081 (IWER emulator on localhost)
npm run build      # production build -> dist/ (static, deployable anywhere)
npm run typecheck  # tsc --noEmit
```

- Open the printed URL in a desktop browser and click **Enter XR** — the IWER emulator injects a
  virtual Quest 3 (mouse look: click the play icon; WASD/arrow keys move controllers; `Esc` exits).
  IWER controls: https://iwsdk.dev/guides/02-testing-experience.html#iwer-controls
- The dev server is HTTPS on localhost (WebXR needs a secure context); accept the self-signed cert.
- Without a key the MockProvider answers; to use a real model, create `.env.local`:

```sh
VITE_LLM_BASE_URL=https://api.openai.com/v1   # or Nebius/Groq/DeepSeek/local vLLM - any OpenAI-compatible
VITE_LLM_API_KEY=sk-...
VITE_LLM_MODEL=gpt-4o-mini
```

Keys stay client-side for the demo; a proxy worker is the production path.

## Starter content (from the IWSDK scaffold)

The robot turns toward the player and plays a sound when pressed; the welcome panel holds the
Enter/Exit XR buttons; the plinths hold grabbable pieces and a spinning ring. All props are built
in code (`src/scene-assets/*.scene-asset.ts`) so no extra models are downloaded. The robot is a
natural mascot for the agent — keep or delete it (remove its scene node, `RobotSystem` from
`src/index.ts`, `Robot` from `src/components.ts`).

## Deploy (GitHub Pages)

`vite.config.ts` uses `base: './'`, so the built site works from any subpath — no repo-name
configuration needed. The included workflow (`.github/workflows/deploy.yml`) builds and deploys on
every push to `main`:

1. Repo Settings → Pages → Source: **GitHub Actions**.
2. Push `main`. Site goes live at `https://<user>.github.io/<repo>/`.

WebXR requires HTTPS — GitHub Pages provides it; Quest Browser opens the URL directly.

## Architecture

```text
src/
├── agent/                  # framework-agnostic agent core (no IWSDK imports)
│   ├── types.ts            # Intent / Plan / ToolCall / TraceStep / Phase
│   ├── llm.ts              # LlmProvider: OpenAICompatProvider + MockProvider (deterministic fallback)
│   ├── tools.ts            # tool registry -> SceneCommand[] (spawn-card / clear-cards / pulse-act)
│   └── loop.ts             # AgentRuntime: event-driven intent->plan->act->trace queue
├── agent-console.ts        # AgentConsoleSystem: wires panel + rail to runtime, exposes window.agentdeck
├── scene-assets/
│   ├── task-card.scene-asset.ts   # card prefab + per-state tinting
│   ├── studio.scene-asset.ts      # (starter) stage, plinths, graphite props
│   └── decor.scene-asset.ts       # (starter) gallery / sideboard sets
├── index.ts                # registers RobotSystem, PanelSystem, AgentConsoleSystem
├── panel.ts / robot.ts     # (starter) XR enter/exit + mascot robot
public/
├── ui/console.uikitml      # spatial console UI (Horizon kit, dark scheme)
└── scenes/main.iwsdk.scene.json  # declarative scene incl. agent-console node
```

Roadmap to submission (Nov 18, 2026, 12:00 PST): hands-first interactions (pinch to grab cards),
WebXR speech recognition wired to `dispatchVoice`, multi-agent roles on the rail, <3 min capture
video via IWER + Quest screencast.

## Sources

- IWSDK docs: https://iwsdk.dev (setup, IWER testing, build & deploy guides)
- IWSDK repo (MIT): https://github.com/meta/immersive-web-sdk
- npm: `@iwsdk/core` 1.1.0-rc.2; scaffold via `npm create @iwsdk@latest` (`@iwsdk/create`)
- Competition: https://start-developer-competition-26.devpost.com/
