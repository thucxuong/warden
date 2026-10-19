// API client. In `--mode mock` (bun run ui:dev:mock) answers come from src/mocks (design 8.4);
// the production build drops that branch, so the mocks are never bundled.

export class ApiRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

async function errorOf(res: Response): Promise<ApiRequestError> {
  let message = `${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // not JSON: keep the status line
  }
  return new ApiRequestError(res.status, message);
}

export async function getJson<T>(path: string): Promise<T> {
  if (import.meta.env.MODE === "mock") {
    const { mockGet } = await import("../mocks/index.ts");
    return (await mockGet(path)) as T;
  }
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as T;
}

export async function getText(path: string): Promise<string> {
  if (import.meta.env.MODE === "mock") {
    const { mockGetText } = await import("../mocks/index.ts");
    return mockGetText(path);
  }
  const res = await fetch(path);
  if (!res.ok) throw await errorOf(res);
  return res.text();
}
