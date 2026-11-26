# Viber — Vision & Architecture

> The next-gen IDE for vibe coders. You work on a living architecture diagram rather than on files.
> Code is a drill-down, not the main surface.

## 1. Two goals

1. **A visual-first development flow.** You think, prompt, review and approve on the diagram. Reading and editing files is the exception.
2. **The cheapest, most precise context possible.** The IDE knows the structure of the code, so neither you nor the agent has to explore. Every task starts already pointed at the right symbols, and the agent loads as few tokens as it needs.

These goals feed each other. The architecture model that draws the diagram is also the index that lets an agent skip `grep` + `read whole file` exploration.

## 2. Core principle: the IDE owns the model, not the agent

Viber has to work with any agent (Claude Code, Cursor, Codex, a local Ollama model), so it never depends on an agent describing its own work. It keeps its own model and watches the code.

| Layer | What it does |
|---|---|
| **Architecture model** | Versioned `.arch/model.yaml` in the repo: boxes, edges, actors, zoom levels, and pinned positions. Each box maps to files, folders or symbols. |
| **Symbol graph** | Built with tree-sitter (and LSP/SCIP where available). Every function, class, route and type gets a stable ID, with call/import/type edges. This is the base layer that boxes group. |
| **Extractor** | Static analysis builds the structure. An LLM pass adds prose only (box purpose, edge contract summaries). Summaries are cached by content hash, so only changed symbols are re-summarized. |
| **Live mode** | A file watcher plus git diffs map each changed hunk to a symbol, then to a box, and the box lights up. Unmapped files become *new box candidates*. This works with any agent. |
| **Context engine (MCP)** | The token-reduction layer (§4). Agents query the model instead of exploring the filesystem. |
| **Intent channel (MCP)** | Capable agents announce what they plan to do. The diagram then shows what is *about to* change, not only what already changed. |
| **Built-in agent (optional)** | A provider-pluggable loop: an OpenAI-compatible API (Ollama, vLLM, LM Studio) plus Anthropic. Runs locally on the RTX 5080. |

## 3. The redesigned flow

```
 ┌─ 1. Point ──────┐  ┌─ 2. Plan ────────┐  ┌─ 3. Execute ─────┐  ┌─ 4. Review ───────┐
 │ Select boxes /  │→ │ Agent proposes a │→ │ Agent works      │→ │ Per-box review:   │
 │ edges / actors, │  │ DIAGRAM DIFF:    │  │ inside the fence;│  │ contract diffs,   │
 │ or draw on the  │  │ ghost boxes,     │  │ boxes light up   │  │ tests per box,    │
 │ canvas, then    │  │ changed edges,   │  │ live; any edit   │  │ code only on      │
 │ say what you    │  │ touched symbols  │  │ outside the fence│  │ demand. Approve / │
 │ want            │  │ → you approve    │  │ is flagged       │  │ reject per box    │
 └─────────────────┘  └──────────────────┘  └──────────────────┘  └───────────────────┘
```

**The diagram is an input surface as well as an output.**
- Draw an edge from `Checkout` to `Payments`: "make Checkout call Payments".
- Add an empty box inside `API`: "scaffold a new service here".
- Edit an edge's contract (add a field to a message schema): the IDE computes the impact (every box that produces or consumes it) and builds the task.
- Right-click a box and choose "explain", "add tests" or "refactor". The prompt is pre-scoped to that box.

**Review happens at the level of meaning first.** You see "edge `Auth → Users` gained `refreshToken(): Token`" and "box `Billing` changed behaviour, 3 tests affected, all green". The line diff stays one click away.

## 4. Token reduction and precise targeting

The aim: a typical task should load **10× fewer tokens** than an agent exploring on its own, and land on the right symbol on the first try. Techniques, in order of impact:

### 4.1 Pre-scoped context packs
When you select something and prompt, Viber builds a **context pack** before the agent starts:
- the selected boxes' purpose and contracts,
- signatures (not bodies) of the symbols involved, plus 1-hop callers and callees,
- the relevant edge contracts and types,
- the mapped tests.

The agent starts already pointed at the target, so it doesn't need to explore.

### 4.2 MCP context tools (progressive disclosure)
Agents get tools that return the *smallest useful unit*:

| Tool | Returns |
|---|---|
| `arch.overview(zoom)` | Box/edge summary at a zoom level (~1–2k tokens for a whole system) |
| `arch.box(id)` | Purpose, contracts, public symbols (signatures only), files |
| `code.symbol(id, detail)` | `signature` → `doc` → `body` → `body+deps`; the agent asks for more only when needed |
| `code.find(query)` | Hybrid search: graph match → embeddings within the candidate boxes → ripgrep fallback. Returns symbol IDs, not file dumps |
| `code.impact(symbol)` | Callers, dependents, affected contracts and tests |
| `code.edit(symbol, patch)` | Symbol-addressed edit, so the agent never re-reads a 2,000-line file to change 5 lines |
| `intent.announce(boxes, summary)` | Feeds the "about to change" highlight and the edit fence |

### 4.3 Edit fence
Every task has a scope (the selected boxes, plus whatever the approved plan adds). An edit outside the scope is flagged live, or blocked via agent hooks where the agent supports them (e.g. Claude Code `PreToolUse`). This stops wandering, which is one of the biggest token drains.

### 4.4 Cache-friendly prompts
The architecture overview is deterministic and changes rarely, so it works as a **stable prompt prefix** for provider prompt caching. Per-task context goes after it.

### 4.5 Incremental everything
Content-hashed summaries, incremental re-parse of changed files only, and affected-test selection from the symbol graph. Nothing is recomputed that didn't change.

### 4.6 Steering agents that don't know Viber
Viber generates an `AGENTS.md` / `CLAUDE.md` section that says "use `arch.*` / `code.*` tools before reading files", and registers its MCP server in the agent's config. Agents that ignore the tools still get live highlighting through the watcher.

### 4.7 Measure it (from day one)
Build a **benchmark harness** with a fixed set of tasks on test repos. Run each task with and without Viber and record tokens in/out, tool calls, wall time and success. Without this, "state of the art" is a claim, not a fact.

## 5. Stack

- **Desktop app from day one: Electron** (macOS, Windows, Linux). This is the same approach as VS Code and Cursor. It bundles its own Chromium, so the canvas and Monaco render the same on all three OSes, and its Node main process runs the TypeScript engine directly. Packaged with electron-builder, with auto-update.
- **Engine (Electron utility process): TypeScript.** It handles the watcher, extractor, symbol graph and MCP server, and runs off the UI thread. One language across the app means shared model types, mature tree-sitter bindings and the official MCP TypeScript SDK. The engine can also run headless (`viber serve`) so agents get the MCP tools even when the window is closed.
- **UI (renderer):** React + React Flow, ELK for layout (incremental, with pinned positions), Monaco for code views that stay hidden by default.
- **Storage:** `.arch/model.yaml` (committed; human-readable source of truth) plus `.arch/cache/` (SQLite: symbol graph, summaries, embeddings; git-ignored).
- **Considered:** *Tauri* (much smaller installer, but it uses each OS's own web engine, and Linux's WebKitGTK is noticeably weaker on heavy canvases; the Node engine would also have to ship as a sidecar). *Fully native* (e.g. Rust + GPUI like Zed: fastest, but we'd rebuild a graph editor and a code editor from scratch).

## 6. Status

Everything below is implemented (October 2026). Each item lists how far it goes.

| Area | State |
|---|---|
| Extractor | tree-sitter (WASM, in a worker) for TS/JS, Python, Go, Java, Rust, C#, PHP, Ruby, plus regex for Kotlin, Swift, Vue and Svelte. Imports resolve through tsconfig paths, workspaces, Python packages, go.mod and namespaces. |
| Model | `.arch/model.yaml` holds curated boxes (by path), actors, services and guardrails. Everything derived from code is recomputed on every scan. Proposals are dashed until you accept them. |
| Actors | Proposed from pages, `/admin` routes, uncalled APIs, webhooks, CLIs, cron and queues. You can also declare them yourself, by picking boxes or giving route patterns. The map shows which actors each box faces, and focusing an actor traces what it reaches. |
| Live mode | An always-on watcher plus git checkpoints. Live diff counts and contract diffs, an edit fence, new-box candidates, and revert or commit per box. |
| Agents | Claude Code (headless, stream-json), a built-in loop (Claude SDK, or OpenAI-compatible for Ollama / vLLM / LM Studio), or any external agent over MCP. Plan approval is a blocking MCP tool. |
| Parallel | Isolated sessions get their own git worktree and branch, with merge or discard. |
| Context engine | `arch_overview`, `arch_box`, `code_symbol` (signature → body → body + deps), `code_find`, `code_impact`, `check_fence`, `locate_bug`. The overview is a cached prompt prefix. |
| Run & runtime | Run configs are detected from manifests. Errors are mapped to boxes. An OTLP/HTTP JSON receiver and request-log parsing feed the runtime overlay. |
| Extras | Bug → box, Ctrl+K search, per-box rules, guardrails, history heatmap, explain mode, page thumbnails, Alt+click-to-box live preview, AI descriptions with a content-hash cache, an embedded terminal, branch switching and PR creation (GitHub). |

**Still open:**
- the token benchmark harness: measured savings rather than estimates;
- incremental ELK placement inside deep containers;
- descriptions for edges;
- non-GitHub PR hosts;
- signed installers and auto-update.

Local 14B models can follow the plan → edit loop, but they often produce poor edits. Use them for descriptions, and Claude for editing.

## 7. Risks

| Risk | Mitigation |
|---|---|
| **Granularity:** too few boxes is useless, too many is spaghetti | Zoom levels are mandatory (system → service → component → symbol). Collapse heuristics based on graph clustering, with manual overrides saved to the model. |
| **Layout stability:** boxes jumping around make the live view unwatchable | Positions are pinned in `model.yaml`. New boxes are placed by incremental ELK with existing nodes fixed. Never re-layout the whole graph automatically. |
| **Drift / weak local models** | Structure always comes from static analysis. The LLM writes prose only, and stale prose is flagged by content hash. |
| **Agents ignore MCP tools** | Generated agent instructions plus hooks. The watcher fallback means the visual layer still works. |
| **Unproven token savings** | Benchmark harness in Phase 3, before investing in polish. |
| **Language coverage** | Start with TS/JS + Python. The tree-sitter query packs are per-language plugins. |

## 8. Agentic-first: the map is the spec

Humans own **direction**: the actors, the components, the contracts between them, and whether the architecture makes sense. Agents own **the code**. Humans never write code, so code stays read-only.

**One artifact, two ways to build it.** The architecture model is the *cahier des charges*. Both ways produce and edit the same `.arch/model.yaml`, and they mix freely:
- **Draw → build:** you add actors, components and contracts on the canvas, and agents implement them.
- **Talk → draw → build:** you describe the product in chat. The AI proposes the diagram as a diff (actors, components, contracts) and you edit it. Building starts once you both agree.

**What a box needs to be a spec.**

| Field | Purpose |
|---|---|
| Responsibility | One sentence, plus what is explicitly *not* this box's job |
| Contract | Typed endpoints, events and functions with schemas: the only way in or out |
| Acceptance | Criteria plus generated contract tests: done means green |
| Actor journeys | Ordered paths through boxes ("Gardener logs a watering") that become end-to-end tests |
| Status | `planned → building → built → verified`, so the map is also the roadmap |
| Decisions | Short ADRs attached to the box or edge they shaped |

**The build loop.**
1. **Order.** An orchestrator reads the spec and picks the build order from the contracts: providers before consumers. Independent boxes go to parallel agents in separate worktrees; the fence plus contracts keep them from colliding.
2. **Verify.** Each box is checked against its contract tests and journeys, not against "looks right".
3. **Escalate.** Agents raise **questions** as cards pinned on the relevant box or edge. Humans answer in the map, and the answers become rules or decisions.
4. **Detect drift.** Code that breaks a contract, adds an undeclared edge or crosses a guardrail is flagged on the map.
5. **Autonomy dial per box.** *Ask me* (plan approval), *Tell me* (notify), or *Just do it* (tests are the gate).

**Measuring it.** `bench/` runs the same tasks with and without Viber. Every change to context, tools or prompts is checked against it, so token savings are measured, never assumed.

## 9. Why an agent should be cheaper here than in VS Code (and what's left)

An agent working alone spends most of its tokens **finding** things. Each grep or file read is a turn, and every turn resends the whole conversation. Viber's job is to replace that search with precomputed knowledge.

| Problem for an agent alone | What Viber gives it | Status |
|---|---|---|
| "Where is the code for X?" | `where_to_change(task)`: ranked edit sites (file, function, line range, reasons) from names, docstrings, routes, HTTP call sites, the import graph and git co-change. The top hits are already in the context pack. | built |
| Renaming or changing a contract misses the other side | `find_usages(route\|symbol)`: the server handler plus every client call site and importer, with lines, across languages | built |
| Reading 800-line files to change 5 lines | `code_symbol` / `read_symbols`: bodies only, long ones outlined with line ranges | built |
| Exact-string edits failing | `replace_symbol(name, code)`: rewrite a function by name | built |
| One read per turn | `read_symbols` batches several reads into one call | built |
| No memory of how the code evolves | git co-change ("files that change with this one") | built |
| Rediscovering architecture every task | cached overview prefix, box specs, rules, contracts | built |
| Guessing the intent | the spec (responsibility, contract, acceptance) and `ask_human` | built |
| Agents silently changing contracts | `propose_contract_change` (ACP): human approves or rejects, contract and designed edge update, consumers get follow-up tasks; the first change on an undesigned box adopts current routes and dependencies as the design | built |
| Verifying blindly | impacted tests only (`code_impact`) | built |
| Breaking a contract or adding hidden I/O | typed contracts checked against handlers, models and signatures; declared side effects per box, both reported as drift | built |
| Edits that break the syntax | tree-sitter reparse before writing; refused with the error position | built |
| Guessing references | bundled TypeScript and Python language servers behind `find_usages` | built |
| Hidden coupling | function-level change history in `where_to_change` | built |
| Stale reads | notice when a file the agent read changed since | built |
| Unmeasured targeting | `scripts/edit-site-bench.ts` on real commit history: top-3 93% vs grep 72% on a private FastAPI + React project | built |

Still to do, in order of expected payoff:
1. **More language servers** (Go, Rust, Java) and using them for definitions and types, not only references.
2. **Embeddings** for vocabulary that never appears in identifiers or code, behind a local model.
3. **Benchmark more repos** (the body-text weight was tuned on one).