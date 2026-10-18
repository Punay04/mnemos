import { cypherLiteral, runCypher } from "./client.js";

function titleFromContent(content: string, max = 60): string {
  const line = content.split("\n").find((part) => part.trim().length > 0) ?? content;
  return line.trim().slice(0, max);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function upsertEpisode(params: {
  id: string;
  type: string;
  title: string;
  content: string;
  sourceType: string;
  sourceId: number | null;
  appName: string | null;
  windowName: string | null;
  salience: number;
  createdAt: string;
}): Promise<string | null> {
  try {
    await runCypher(`
      MERGE (e:Episode {id: ${cypherLiteral(params.id)}})
      SET e.type = ${cypherLiteral(params.type)},
          e.title = ${cypherLiteral(params.title)},
          e.content = ${cypherLiteral(params.content)},
          e.source_type = ${cypherLiteral(params.sourceType)},
          e.source_id = ${params.sourceId ?? "null"},
          e.app_name = ${params.appName ? cypherLiteral(params.appName) : "null"},
          e.window_name = ${params.windowName ? cypherLiteral(params.windowName) : "null"},
          e.salience = ${params.salience},
          e.created_at = ${cypherLiteral(params.createdAt)},
          e.updated_at = ${cypherLiteral(nowIso())}
      RETURN e.id AS id
    `);

    await runCypher(`
      MATCH (prev:Episode)
      WHERE prev.id <> ${cypherLiteral(params.id)}
      WITH prev
      ORDER BY prev.created_at DESC
      LIMIT 1
      MATCH (e:Episode {id: ${cypherLiteral(params.id)}})
      MERGE (prev)-[:FOLLOWS]->(e)
    `);

    return params.id;
  } catch (err) {
    console.warn("[falkordb] ingest failed:", err);
    return null;
  }
}

// Words that carry no identifying weight, so two claims about the same thing
// still land on the same key when the phrasing around them differs.
const KEY_STOPWORDS = new Set([
  "a", "an", "the", "i", "im", "my", "me", "we", "our", "you", "your",
  "is", "am", "are", "was", "were", "be", "been", "now", "currently",
  "to", "of", "in", "on", "at", "for", "from", "with", "and", "or",
  "have", "has", "had", "do", "does", "did", "this", "that", "it",
  "new", "old", "back", "just", "got", "get",
]);

// Verbs/nouns that name the attribute a claim is about. The first one found
// becomes the key, so "I live in Austin" and "I moved to Lisbon" both key on
// "live" and supersede each other instead of coexisting as current facts.
const ATTRIBUTE_SYNONYMS: Array<[string, string[]]> = [
  ["live", ["live", "lives", "living", "reside", "resides", "based", "located", "city", "relocated", "moved", "moving"]],
  ["work", ["work", "works", "working", "job", "employed", "employer", "company", "joined"]],
  ["role", ["role", "title", "position"]],
  ["name", ["name", "called"]],
  ["email", ["email", "mail"]],
  ["phone", ["phone", "number", "mobile"]],
  ["team", ["team", "squad", "group"]],
  ["project", ["project", "building", "build", "shipping"]],
  ["stack", ["stack", "framework", "language", "database", "db"]],
  ["timezone", ["timezone", "tz", "utc"]],
];

/**
 * Collapse a claim to a stable attribute key.
 *
 * Supersession matches on this key, so it has to be the same for two claims
 * about the same attribute even when the wording differs. Falls back to the
 * first few meaningful words when no known attribute is present — narrower
 * than a 48-char prefix, which almost never matched twice.
 */
export function factKey(text: string): string {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !KEY_STOPWORDS.has(word));

  for (const [key, synonyms] of ATTRIBUTE_SYNONYMS) {
    if (words.some((word) => synonyms.includes(word))) return key;
  }

  return words.slice(0, 3).join(" ") || text.trim().slice(0, 48).toLowerCase();
}

async function upsertFact(params: {
  id: string;
  text: string;
  episodeId: string;
  createdAt: string;
}): Promise<void> {
  const key = factKey(params.text);

  await runCypher(`
    MERGE (f:Fact {id: ${cypherLiteral(params.id)}})
    SET f.text = ${cypherLiteral(params.text)},
        f.key = ${cypherLiteral(key)},
        f.current = true,
        f.valid_from = ${cypherLiteral(params.createdAt)},
        f.valid_to = null
    WITH f
    MATCH (e:Episode {id: ${cypherLiteral(params.episodeId)}})
    MERGE (e)-[:RECORDED_AS]->(f)
  `);

  try {
    await runCypher(`
      MATCH (old:Fact)
      WHERE old.current = true
        AND old.id <> ${cypherLiteral(params.id)}
        AND toLower(old.key) = ${cypherLiteral(key)}
      SET old.current = false, old.valid_to = ${cypherLiteral(params.createdAt)}
      WITH old
      MATCH (fresh:Fact {id: ${cypherLiteral(params.id)}})
      MERGE (fresh)-[:SUPERSEDES]->(old)
    `);
  } catch {
    // First fact for this key — no predecessor.
  }
}

export async function ingestScreenCapture(params: {
  frameId: number;
  text: string;
  appName: string | null;
  windowName: string | null;
  timestamp: string;
}): Promise<string | null> {
  const text = params.text.trim();
  if (!text) return null;
  const title = params.windowName ?? params.appName ?? titleFromContent(text);
  const contextLine = [
    params.appName ? `App: ${params.appName}` : null,
    params.windowName ? `Window: ${params.windowName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return upsertEpisode({
    id: `frame_${params.frameId}`,
    type: "screen_chunk",
    title,
    content: contextLine ? `${contextLine}\n\n${text}` : text,
    sourceType: "frame",
    sourceId: params.frameId,
    appName: params.appName,
    windowName: params.windowName,
    salience: 0.55,
    createdAt: params.timestamp,
  });
}

export async function ingestAudioChunk(params: {
  audioId: number;
  transcription: string;
  meetingId?: number | null;
  timestamp: string;
}): Promise<string | null> {
  const text = params.transcription.trim();
  if (!text) return null;
  return upsertEpisode({
    id: `audio_${params.audioId}`,
    type: "audio_chunk",
    title: titleFromContent(text),
    content: text,
    sourceType: "audio",
    sourceId: params.audioId,
    appName: null,
    windowName: null,
    salience: 0.65,
    createdAt: params.timestamp,
  });
}

export async function ingestMeetingSummary(params: {
  meetingId: number;
  title: string;
  summary: string;
  actionItems: string[];
}): Promise<string | null> {
  const content = [
    params.title,
    params.summary,
    params.actionItems.length > 0
      ? `action items:\n${params.actionItems.map((item) => `- ${item}`).join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const id = await upsertEpisode({
    id: `meeting_${params.meetingId}`,
    type: "meeting",
    title: params.title,
    content,
    sourceType: "meeting",
    sourceId: params.meetingId,
    appName: null,
    windowName: null,
    salience: 0.9,
    createdAt: nowIso(),
  });

  if (id) {
    await upsertFact({
      id: `fact_meeting_${params.meetingId}`,
      text: params.summary,
      episodeId: id,
      createdAt: nowIso(),
    });
  }

  return id;
}

export async function ingestUserMemory(params: {
  title: string;
  content: string;
}): Promise<string | null> {
  const createdAt = nowIso();
  const id = `user_${Date.now()}`;
  const episodeId = await upsertEpisode({
    id,
    type: "memory",
    title: params.title,
    content: `${params.title}\n${params.content}`,
    sourceType: "user",
    sourceId: null,
    appName: null,
    windowName: null,
    salience: 0.95,
    createdAt,
  });
  if (episodeId) {
    await upsertFact({
      id: `fact_${id}`,
      text: `${params.title}: ${params.content}`,
      episodeId,
      createdAt,
    });
  }
  return episodeId;
}

export async function ingestChatSession(params: {
  sessionId: string;
  turns: Array<{ role: "user" | "assistant"; content: string }>;
  startedAt?: string;
}): Promise<string | null> {
  const startedAt = params.startedAt ?? nowIso();
  try {
    await runCypher(`
      MERGE (s:Session {id: ${cypherLiteral(params.sessionId)}})
      SET s.started_at = ${cypherLiteral(startedAt)},
          s.turn_count = ${params.turns.length}
      RETURN s.id AS id
    `);

    for (const [index, turn] of params.turns.entries()) {
      const text = turn.content.trim();
      if (!text) continue;
      const episodeId = `${params.sessionId}_t${index}`;
      await upsertEpisode({
        id: episodeId,
        type: "session_turn",
        title: `${turn.role} · ${params.sessionId}`,
        content: text,
        sourceType: "user",
        sourceId: index,
        appName: null,
        windowName: null,
        salience: turn.role === "user" ? 0.85 : 0.4,
        createdAt: startedAt,
      });
      await runCypher(`
        MATCH (s:Session {id: ${cypherLiteral(params.sessionId)}})
        MATCH (e:Episode {id: ${cypherLiteral(episodeId)}})
        MERGE (e)-[:IN_SESSION]->(s)
      `);
      if (turn.role === "user") {
        await upsertFact({
          id: `fact_${episodeId}`,
          text,
          episodeId,
          createdAt: startedAt,
        });
      }
    }

    return params.sessionId;
  } catch (err) {
    console.warn("[falkordb] session ingest failed:", err);
    return null;
  }
}
