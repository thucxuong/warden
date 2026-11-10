// warden tools --verify records (#33): proves a project's store keeps the contract the engine and the site rely on.
// It runs against the real database, on a few fixed rows dated 2000 with status "verify", which no page ever asks for.
// There is no delete in the contract, so the rows stay and are overwritten by the next run.
import type { RecordFilters, RecordStore, RunRecord, ToolCheck } from "../types.ts";
import { recordStore } from "./store.ts";

const id = (n: number) => `WARDEN-VERIFY-${n}`;
const IDS = [1, 2, 3].map(id);
const when = (n: number) => `2000-01-01T00:00:0${n}.000Z`;
const rowOf = (n: number, value: string): RunRecord => ({
  ticket: id(n), status: "verify", flow: n === 1 ? "verify-a" : "verify-b", finishedAt: when(n),
  summary: { value, nested: { n } }, detail: { events: [{ seq: n, type: "verify" }], plan: "text" },
});

const sameTime = (a: unknown, b: string) => Date.parse(String(a instanceof Date ? a.toISOString() : a)) === Date.parse(b);

function sameRow(got: RunRecord | null, want: RunRecord): string | null {
  if (!got) return "get found nothing";
  if (got.ticket !== want.ticket || got.status !== want.status || got.flow !== want.flow) return "ticket, status or flow changed";
  if (!sameTime(got.finishedAt, want.finishedAt)) return `finishedAt came back as ${String(got.finishedAt)}`;
  if (!Bun.deepEquals(got.summary, want.summary)) return "summary changed";
  if (!Bun.deepEquals(got.detail, want.detail)) return "detail changed";
  return null;
}

type Step = [label: string, run: (store: RecordStore) => Promise<string | null>];

const tickets = (r: { records: { ticket: string }[] }) => r.records.map((x) => x.ticket).join(",");
const ours: RecordFilters = { status: ["verify"], tickets: IDS };

const STEPS: Step[] = [
  ["save and get", async (s) => {
    for (const n of [1, 2, 3]) await s.save(rowOf(n, "first"));
    return sameRow(await s.get(id(1)), rowOf(1, "first"));
  }],
  ["save replaces the ticket's row", async (s) => {
    await s.save(rowOf(1, "second"));
    return sameRow(await s.get(id(1)), rowOf(1, "second"));
  }],
  ["get of an unknown ticket is null", async (s) => ((await s.get("WARDEN-VERIFY-0")) === null ? null : "must be null")],
  ["list is newest first and has no detail", async (s) => {
    const page = await s.list(ours, 10, null);
    if (tickets(page) !== [id(3), id(2), id(1)].join(",")) return `got ${tickets(page)}`;
    if (page.records.some((r) => "detail" in r)) return "a list row must not have detail";
    return page.cursor === null ? null : "the cursor must be null on the last page";
  }],
  ["list pages with a cursor", async (s) => {
    const first = await s.list(ours, 2, null);
    if (first.records.length !== 2 || first.cursor === null) return "limit 2 must give 2 rows and a cursor";
    const second = await s.list(ours, 2, first.cursor);
    return tickets(second) === id(1) && second.cursor === null ? null : `the next page gave ${tickets(second)}`;
  }],
  ["list filters by flow and dates", async (s) => {
    const flow = await s.list({ ...ours, flow: "verify-a" }, 10, null);
    if (tickets(flow) !== id(1)) return `flow gave ${tickets(flow)}`;
    const range = await s.list({ ...ours, from: when(2), to: when(3) }, 10, null);
    return tickets(range) === id(2) ? null : `from <= finishedAt < to gave ${tickets(range)}`;
  }],
  ["list filters by status", async (s) => {
    const none = await s.list({ status: ["no-such-status"], tickets: IDS }, 10, null);
    return none.records.length === 0 ? null : "a status filter must leave out other rows";
  }],
  ["events returns each ticket's log", async (s) => {
    const list = await s.events([id(2), "WARDEN-VERIFY-0"]);
    if (list.length !== 1 || list[0]!.ticket !== id(2)) return "must have the known ticket only";
    return Bun.deepEquals(list[0]!.events, [{ seq: 2, type: "verify" }]) ? null : "events changed";
  }],
];

export async function verifyRecords(main: string): Promise<ToolCheck[]> {
  let store: RecordStore;
  try {
    store = await recordStore(main);
  } catch (err) {
    return [{ status: "FAIL", label: "records tool", detail: err instanceof Error ? err.message : String(err) }];
  }
  const checks: ToolCheck[] = [{ status: "OK", label: "records tool", detail: "has save, list, get and events" }];
  for (const [label, run] of STEPS) {
    try {
      const problem = await run(store);
      checks.push(problem === null ? { status: "OK", label, detail: "" } : { status: "FAIL", label, detail: problem });
      if (problem !== null) break; // later steps depend on the rows being right
    } catch (err) {
      checks.push({ status: "FAIL", label, detail: err instanceof Error ? err.message.split("\n")[0]! : String(err) });
      break;
    }
  }
  return checks;
}
