// Horde REST API client

export interface UserInfo {
  id: string;
  name: string;
  email: string;
  login: string;
}

export interface JobStep {
  id: string;
  nodeIdx: number;
  name: string;
  state: "Waiting" | "Ready" | "Running" | "Skipped" | "Completed" | "Aborted";
  outcome: "Success" | "Failure" | "Warnings" | "Unspecified";
  error: string;
  startTime?: string;
  finishTime?: string;
  logId?: string;
}

export interface JobBatch {
  id: string;
  groupIdx: number;
  agentType: string;
  state: string;
  steps: JobStep[];
}

export interface HordeJob {
  id: string;
  name: string;
  streamId: string;
  templateId: string;
  state: "Waiting" | "Running" | "Complete";
  change: number;
  preflightChange?: number;
  preflightCommitId?: string;
  preflightDescription?: string;
  startedByUserId?: string;
  startedByUser?: string;
  startedByUserInfo?: UserInfo;
  createTime: string;
  updateTime: string;
  batches: JobBatch[];
  arguments: string[];
}

export interface HordeClientConfig {
  baseUrl: string;
  token: string;
}

export class HordeClient {
  private baseUrl: string;
  private token: string;

  constructor(config: HordeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
  }

  private async fetch<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `ServiceAccount ${this.token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Horde API ${path}: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  async fetchPreflightJobs(count = 20): Promise<HordeJob[]> {
    return this.fetch<HordeJob[]>("/api/v1/jobs", {
      preflightOnly: "true",
      count: count.toString(),
    });
  }

  async fetchJobs(opts: {
    streamId?: string;
    templateId?: string;
    count?: number;
    preflightOnly?: boolean;
  } = {}): Promise<HordeJob[]> {
    const params: Record<string, string> = {};
    if (opts.streamId) params.streamId = opts.streamId;
    if (opts.templateId) params.template = opts.templateId;
    if (opts.count) params.count = opts.count.toString();
    if (opts.preflightOnly) params.preflightOnly = "true";
    return this.fetch<HordeJob[]>("/api/v1/jobs", params);
  }
}
