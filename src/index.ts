import { HordeClient } from "./horde.js";
import { SlackClient } from "./slack.js";
import { PreflightHandler } from "./handlers/preflight.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const HORDE_URL = requireEnv("HORDE_URL");
const HORDE_TOKEN = requireEnv("HORDE_TOKEN");
const HORDE_EXTERNAL_URL = requireEnv("HORDE_EXTERNAL_URL");
const SLACK_BOT_TOKEN = requireEnv("SLACK_BOT_TOKEN");
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_SECONDS ?? "30", 10) * 1000;
const SLACK_USER_DIRECTORY_CHANNEL = process.env.SLACK_USER_DIRECTORY_CHANNEL ?? "#tcp_build_testing";

const horde = new HordeClient({ baseUrl: HORDE_URL, token: HORDE_TOKEN });
const slack = new SlackClient({ token: SLACK_BOT_TOKEN, userDirectoryChannel: SLACK_USER_DIRECTORY_CHANNEL });
const preflightHandler = new PreflightHandler(slack, HORDE_EXTERNAL_URL);

async function init(): Promise<void> {
  console.log(`horde-notify starting`);
  console.log(`  Horde API: ${HORDE_URL}`);
  console.log(`  External URL: ${HORDE_EXTERNAL_URL}`);
  console.log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
  console.log(`  User directory channel: ${SLACK_USER_DIRECTORY_CHANNEL}`);

  // Build email→userId cache from channel membership (handles Slack Connect users)
  await slack.init();

  // Seed with current preflights so we don't spam on startup.
  // Retry with backoff — if we give up, every existing preflight gets
  // re-announced on the first poll, which is much worse than waiting for Horde.
  let attempt = 0;
  let delayMs = 5_000;
  for (;;) {
    try {
      const existing = await horde.fetchPreflightJobs(20);
      preflightHandler.seedJobs(existing);
      console.log(`Seeded ${existing.length} existing preflights`);
      return;
    } catch (err) {
      attempt++;
      console.error(`Seed attempt ${attempt} failed, retrying in ${delayMs / 1000}s:`, err);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 60_000);
    }
  }
}

async function poll(): Promise<void> {
  try {
    const jobs = await horde.fetchPreflightJobs(20);
    await preflightHandler.processJobs(jobs);
  } catch (err) {
    console.error("Poll error:", err);
  }
}

async function main(): Promise<void> {
  await init();

  // Run first poll immediately, then on interval
  await poll();
  setInterval(poll, POLL_INTERVAL);

  console.log("horde-notify running");
}

process.on("SIGINT", () => {
  console.log("Shutting down");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("Shutting down");
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
