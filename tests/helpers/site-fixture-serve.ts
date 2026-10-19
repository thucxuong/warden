// Starts `warden site` on the fixture project (design 7.1), for Playwright and for UI work:
//   bun tests/helpers/site-fixture-serve.ts      (port SITE_FIXTURE_PORT, default 4417)
// The clock is frozen at the fixture's creation, so the signals (Slow, Job gone, ...) do not drift while it runs.
import { resolve } from "node:path";
import { startServer } from "../../plugins/warden/src/site/server.ts";
import { makeSiteFixture } from "./site-fixture.ts";

const port = Number(process.env.SITE_FIXTURE_PORT ?? 4417);
const fixture = makeSiteFixture();
let server: ReturnType<typeof startServer>;
try {
  server = startServer({ main: fixture.main, root: resolve(import.meta.dir, "../../plugins/warden"), data: fixture.data, port, now: () => fixture.now });
} catch (err) {
  fixture.stop();
  throw err;
}
console.log(`warden site: http://127.0.0.1:${port}`);

const stop = () => {
  server.stop(true);
  fixture.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
