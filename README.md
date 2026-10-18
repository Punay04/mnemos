# Mnemos

Mnemos is a local-first AI desktop workspace. It captures screen activity and meetings on your machine, stores them in SQLite, and writes a **property graph of episodes and facts into a local [FalkorDB](https://github.com/FalkorDB/FalkorDB)**. Chat, search, and the Brain view retrieve over that graph with OpenCypher — including current vs superseded facts and explicit abstention when nothing matches.

Built for the [FalkorDB hackathon](https://www.wemakedevs.org/hackathons/falkordb).

## Quick start

Need **Node.js 24**, **npm 11**, **Docker**, and a **Gemini API key**.

```bash
git clone https://github.com/Punay04/mnemos.git
cd mnemos
cp .env.example .env
# set GEMINI_API_KEY in .env
npm install
```

Then start Docker and run the app. `npm run dev` launches FalkorDB, the capture API on `http://127.0.0.1:3030`, and Vite + Electron (`http://localhost:1420`).

```bash
npm run dev
```

The first start pulls `falkordb/falkordb`. FalkorDB listens on `redis://127.0.0.1:6379`. Its browser is at `http://127.0.0.1:3000`.

To pull the image ahead of time:

```bash
npm run memory:bootstrap
npm run memory:start
```

## Why FalkorDB

Vector search cannot tell you whether a fact is still true, what it replaced, or that the answer is not in memory. Mnemos uses [FalkorDB](https://github.com/FalkorDB/FalkorDB) — the graph database from the [WeMakeDevs FalkorDB hackathon](https://www.wemakedevs.org/hackathons/falkordb) — as the memory substrate:

| Graph object | Role |
| --- | --- |
| `Episode` | A screen chunk, transcript, meeting, pinned note, or chat turn |
| `Fact` | A durable claim with `current`, `valid_from`, `valid_to` |
| `Session` | A multi-turn conversation spanning time |
| `FOLLOWS` | Chronological chain of episodes |
| `SUPERSEDES` | Later fact replacing an earlier one |
| `RECORDED_AS` / `IN_SESSION` | Provenance from episode → fact → session |

Chat retrieval runs Cypher against **current** facts first, then superseded facts (labeled so the model must not treat them as live), then related episodes. If the graph has no match, Mnemos injects an `[abstain]` instruction so the model says it does not know instead of inventing history.

FalkorDB is required for memory. Without the local graph, capture still works in SQLite, but the Brain graph, profile, and graph-aware chat context are empty.

## What you can do

- Capture screen frames locally (deduplicated JPEG/MP4, OCR)
- Record meeting audio, transcribe, summarize, and extract action items
- Search history with SQLite FTS5 (`Ctrl/Cmd+K`)
- Chat (typed or live voice) with FalkorDB-retrieved context plus Gemini
- Inspect the memory graph in **Brain**
- Run built-in workflows (daily summary, meeting recap, focus tracker, action items)
- Optionally connect Gmail, Calendar, Slack, and Notion through Composio

## Local data

| Data | Where |
| --- | --- |
| Screenshots, video, audio, OCR, SQLite | `~/.mnemos/` |
| FalkorDB data | `~/.mnemos/falkordb/` |
| Capture API | `http://127.0.0.1:3030` |
| FalkorDB Redis / browser | `6379` / `3000` |
| Chat, STT, summaries | Retrieved graph snippets are sent to Gemini when an API key is set |

## FalkorDB only

```bash
npm run memory:bootstrap   # docker pull, once
npm run memory:start
npm run memory:status
```

Health check is a Redis `PING` on `127.0.0.1:6379`. Data lives under `~/.mnemos/falkordb/`. The graph name is `mnemos`.

## Ingest a chat session (graph memory)

```bash
curl -s http://127.0.0.1:3030/memory/sessions \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"demo-1\",\"turns\":[{\"role\":\"user\",\"content\":\"I live in Austin\"},{\"role\":\"assistant\",\"content\":\"Noted.\"}]}"
```

A later session with a different city writes a new `Fact` and a `SUPERSEDES` edge. Chat questions about the current city should use the new fact; questions about the old city should treat it as replaced.

## Architecture

```
Renderer (React) --IPC--> Electron main
                              |-- scripts/falkordb-start.mjs --> FalkorDB container
                              |-- Hono capture API :3030
                                    |-- Capture engine (screen / OCR / audio)
                                    |-- SQLite + FTS5
                                    |-- FalkorDB Cypher ingest + retrieve
                                    |-- Gemini chat / live / pipes
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | FalkorDB + backend + Vite/Electron |
| `npm run memory:bootstrap` | Pull the FalkorDB Docker image |
| `npm run memory:start` | Start the local FalkorDB container |
| `npm run memory:status` | Redis PING against FalkorDB |
| `npm run typecheck` | Typecheck the desktop app |
| `npm run test:runtime` | Runtime policy tests |
| `npm run build:win` | Windows installer |
| `npm run build:mac` | macOS DMG |
| `npm run build:linux` | Linux AppImage |

## License

MIT. [FalkorDB](https://github.com/FalkorDB/FalkorDB) runs as a separate Docker process and is not vendored into this repository.
