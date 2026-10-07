interface Counter {
  count: number;
  reset: number;
}

interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

interface DurableObjectStateLike {
  storage: DurableStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface CheckRequest {
  limit: number;
  windowMs: number;
}

/** One object represents one strict limiter + one user/IP key. */
export class StrictRateLimitDurableObject {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }

    let input: CheckRequest;
    try {
      input = await request.json() as CheckRequest;
    } catch {
      return new Response("Invalid request", { status: 400 });
    }
    if (
      !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100_000 ||
      !Number.isSafeInteger(input.windowMs) || input.windowMs < 1 || input.windowMs > 86_400_000
    ) {
      return new Response("Invalid request", { status: 400 });
    }

    const result = await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const counter = await this.state.storage.get<Counter>("counter");
      if (!counter || now >= counter.reset) {
        const next = { count: 1, reset: now + input.windowMs };
        await this.state.storage.put("counter", next);
        await this.state.storage.setAlarm(next.reset);
        return { success: true, remaining: input.limit - 1, reset: next.reset };
      }
      if (counter.count >= input.limit) {
        return { success: false, remaining: 0, reset: counter.reset };
      }

      counter.count += 1;
      await this.state.storage.put("counter", counter);
      return { success: true, remaining: input.limit - counter.count, reset: counter.reset };
    });
    return Response.json(result);
  }

  async alarm(): Promise<void> {
    // Deleting all storage lets Cloudflare retire the otherwise empty object;
    // blockConcurrencyWhile prevents a concurrent request from losing a fresh
    // counter if an old window's alarm is firing at the same time.
    await this.state.blockConcurrencyWhile(async () => {
      const counter = await this.state.storage.get<Counter>("counter");
      if (counter && counter.reset <= Date.now()) {
        await this.state.storage.deleteAll();
      } else if (counter) {
        await this.state.storage.setAlarm(counter.reset);
      }
    });
  }
}
