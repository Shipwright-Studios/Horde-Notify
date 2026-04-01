import type { HordeJob, JobStep } from "../horde.js";
import type { SlackClient } from "../slack.js";

export interface TrackedPreflight {
  state: string;
  notifiedStart: boolean;
  notifiedComplete: boolean;
  createTime: string;
}

export class PreflightHandler {
  private tracked = new Map<string, TrackedPreflight>();
  private externalUrl: string;

  constructor(
    private slack: SlackClient,
    externalUrl: string,
  ) {
    this.externalUrl = externalUrl.replace(/\/$/, "");
  }

  /** Snapshot current jobs on startup without sending notifications. */
  seedJobs(jobs: HordeJob[]): void {
    for (const job of jobs) {
      this.tracked.set(job.id, {
        state: job.state,
        notifiedStart: true,
        notifiedComplete: job.state === "Complete",
        createTime: job.createTime,
      });
    }
    console.log(`Seeded ${jobs.length} existing preflights`);
  }

  /** Process a batch of preflight jobs. Detects transitions and sends DMs. */
  async processJobs(jobs: HordeJob[]): Promise<void> {
    const currentIds = new Set(jobs.map((j) => j.id));

    for (const job of jobs) {
      const existing = this.tracked.get(job.id);

      if (!existing) {
        // New preflight — send "started" DM
        this.tracked.set(job.id, {
          state: job.state,
          notifiedStart: false,
          notifiedComplete: false,
          createTime: job.createTime,
        });
        await this.notifyStarted(job);
        this.tracked.get(job.id)!.notifiedStart = true;
      }

      if (job.state === "Complete") {
        const track = this.tracked.get(job.id)!;
        if (!track.notifiedComplete) {
          await this.notifyCompleted(job);
          track.notifiedComplete = true;
        }
        track.state = job.state;
      }
    }

    this.cleanup(currentIds);
  }

  private async notifyStarted(job: HordeJob): Promise<void> {
    const email = job.startedByUserInfo?.email;
    if (!email) {
      console.warn(`Preflight ${job.id} has no startedByUserInfo — skipping`);
      return;
    }

    const jobUrl = `${this.externalUrl}/job/${job.id}`;
    const cl = job.preflightChange ?? job.change;
    const desc = job.preflightDescription?.trim();
    const descLine = desc ? `\nCL ${cl} — "${truncate(desc, 100)}"` : `\nCL ${cl}`;

    const text = `:rocket: Your preflight *${job.name}* has started${descLine}\n<${jobUrl}|View in Horde>`;

    console.log(`Notifying ${email}: preflight ${job.id} started`);
    await this.slack.sendDM(email, text);
  }

  private async notifyCompleted(job: HordeJob): Promise<void> {
    const email = job.startedByUserInfo?.email;
    if (!email) return;

    const jobUrl = `${this.externalUrl}/job/${job.id}`;
    const cl = job.preflightChange ?? job.change;
    const desc = job.preflightDescription?.trim();
    const descLine = desc ? `\nCL ${cl} — "${truncate(desc, 100)}"` : `\nCL ${cl}`;

    const outcome = getJobOutcome(job);
    const icon = outcome === "Success" ? ":white_check_mark:" : outcome === "Warnings" ? ":warning:" : ":x:";
    const label = outcome === "Success" ? "succeeded" : outcome === "Warnings" ? "completed with warnings" : "failed";

    let text = `${icon} *${job.name}* ${label}${descLine}`;

    if (outcome === "Failure") {
      const failedSteps = getFailedSteps(job);
      if (failedSteps.length > 0) {
        text += `\nFailed steps: ${failedSteps.join(", ")}`;
      }
    }

    text += `\n<${jobUrl}|View in Horde>`;

    console.log(`Notifying ${email}: preflight ${job.id} ${label}`);
    await this.slack.sendDM(email, text);
  }

  /** Remove tracked jobs that are fully notified, no longer in the API response, and old. */
  private cleanup(currentIds: Set<string>): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, track] of this.tracked) {
      const gone = !currentIds.has(id);
      const old = new Date(track.createTime).getTime() < cutoff;
      const done = track.notifiedStart && track.notifiedComplete;
      if (gone && old && done) {
        this.tracked.delete(id);
      }
    }
  }
}

function getJobOutcome(job: HordeJob): "Success" | "Warnings" | "Failure" {
  let hasWarnings = false;
  for (const batch of job.batches) {
    for (const step of batch.steps) {
      if (step.outcome === "Failure" || step.state === "Aborted") return "Failure";
      if (step.outcome === "Warnings") hasWarnings = true;
    }
  }
  return hasWarnings ? "Warnings" : "Success";
}

function getFailedSteps(job: HordeJob): string[] {
  const failed: string[] = [];
  for (const batch of job.batches) {
    for (const step of batch.steps) {
      if (step.outcome === "Failure" || step.state === "Aborted") {
        failed.push(step.name);
      }
    }
  }
  return failed;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}
