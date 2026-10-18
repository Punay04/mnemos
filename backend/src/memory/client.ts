import { FalkorDB } from "falkordb";
import {
  FALKORDB_GRAPH,
  FALKORDB_HOST,
  FALKORDB_PASSWORD,
  FALKORDB_PORT,
  FALKORDB_USERNAME,
} from "../config.js";

export interface CypherRow {
  [key: string]: unknown;
}

type FalkorClient = Awaited<ReturnType<typeof FalkorDB.connect>>;

let clientPromise: Promise<FalkorClient> | null = null;

function connect(): Promise<FalkorClient> {
  if (!clientPromise) {
    clientPromise = FalkorDB.connect({
      username: FALKORDB_USERNAME || undefined,
      password: FALKORDB_PASSWORD || undefined,
      socket: {
        host: FALKORDB_HOST,
        port: FALKORDB_PORT,
        connectTimeout: 2_000,
        // Fail the first attempt instead of retrying while the container is down.
        reconnectStrategy: () => new Error("FalkorDB unreachable"),
      } as NonNullable<Parameters<typeof FalkorDB.connect>[0]>["socket"],
    }).catch((error: unknown) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

export function cypherLiteral(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function normalizeCell(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function rowsFromResult(result: unknown): CypherRow[] {
  if (!result || typeof result !== "object") return [];
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { value: normalizeCell(row) };
    }
    const out: CypherRow = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      out[key] = normalizeCell(value);
    }
    return out;
  });
}

export async function isFalkorReachable(): Promise<boolean> {
  try {
    const db = await connect();
    await db.list();
    return true;
  } catch {
    await resetFalkorClient();
    return false;
  }
}

export async function runCypher(query: string): Promise<CypherRow[]> {
  const db = await connect();
  const graph = db.selectGraph(FALKORDB_GRAPH);
  const result = await graph.query(query);
  return rowsFromResult(result);
}

export async function resetFalkorClient(): Promise<void> {
  const pending = clientPromise;
  clientPromise = null;
  if (!pending) return;
  try {
    const db = await pending;
    await db.close();
  } catch {
    // Connection was already dead.
  }
}
