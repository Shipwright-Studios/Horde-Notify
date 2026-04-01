import { WebClient } from "@slack/web-api";

export interface SlackClientConfig {
  token: string;
  userDirectoryChannel?: string;
}

export class SlackClient {
  private client: WebClient;
  private userIdCache = new Map<string, string>();
  private userDirectoryChannel?: string;
  private directoryChannelId: string | null = null;

  constructor(config: SlackClientConfig) {
    this.client = new WebClient(config.token);
    this.userDirectoryChannel = config.userDirectoryChannel;
  }

  /** Bootstrap the email→userId cache from channel membership. */
  async init(): Promise<void> {
    if (!this.userDirectoryChannel) return;

    this.directoryChannelId = await this.resolveChannelId(this.userDirectoryChannel);
    if (!this.directoryChannelId) {
      console.warn(`Could not resolve channel: ${this.userDirectoryChannel}`);
      return;
    }

    await this.refreshUserDirectory();
  }

  /** Re-enumerate the directory channel and update the cache. */
  private async refreshUserDirectory(): Promise<void> {
    if (!this.directoryChannelId) return;

    console.log(`Refreshing user directory from ${this.userDirectoryChannel}...`);
    const memberIds = await this.getChannelMembers(this.directoryChannelId);
    console.log(`  Found ${memberIds.length} members, fetching profiles...`);

    let mapped = 0;
    for (const userId of memberIds) {
      try {
        const result = await this.client.users.info({ user: userId });
        const email = result.user?.profile?.email;
        if (email) {
          this.userIdCache.set(email.toLowerCase(), userId);
          mapped++;
        }
      } catch (err) {
        // Skip bots, deactivated users, etc.
      }
    }

    console.log(`  Cached ${mapped} email→userId mappings`);
  }

  private async resolveChannelId(channel: string): Promise<string | null> {
    // Already an ID (starts with C or G)
    if (/^[CG][A-Z0-9]+$/.test(channel)) return channel;

    // Strip leading #
    const name = channel.replace(/^#/, "");

    try {
      let cursor: string | undefined;
      do {
        const result = await this.client.conversations.list({
          types: "public_channel,private_channel",
          limit: 200,
          cursor,
        });
        const found = result.channels?.find((c) => c.name === name);
        if (found?.id) return found.id;
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      console.error(`Failed to list channels:`, err);
    }

    return null;
  }

  private async getChannelMembers(channelId: string): Promise<string[]> {
    const members: string[] = [];
    let cursor: string | undefined;

    do {
      try {
        const result = await this.client.conversations.members({
          channel: channelId,
          limit: 200,
          cursor,
        });
        if (result.members) members.push(...result.members);
        cursor = result.response_metadata?.next_cursor || undefined;
      } catch (err) {
        console.error(`Failed to get channel members:`, err);
        break;
      }
    } while (cursor);

    return members;
  }

  /** Resolve an email address to a Slack user ID (cached).
   *  Falls back to lookupByEmail, then refreshes the directory channel on miss. */
  async resolveUserId(email: string): Promise<string | null> {
    const key = email.toLowerCase();

    // 1. Check cache
    const cached = this.userIdCache.get(key);
    if (cached) return cached;

    // 2. Fallback to API lookup (works for direct workspace members)
    try {
      const result = await this.client.users.lookupByEmail({ email });
      const userId = result.user?.id;
      if (userId) {
        this.userIdCache.set(key, userId);
        return userId;
      }
    } catch (err: unknown) {
      const slackErr = err as { data?: { error?: string } };
      if (slackErr.data?.error !== "users_not_found") {
        console.error(`Slack lookupByEmail failed for ${email}:`, err);
      }
    }

    // 3. Refresh directory channel — picks up new employees / Slack Connect users
    if (this.directoryChannelId) {
      console.log(`User ${email} not in cache or lookupByEmail, refreshing directory...`);
      await this.refreshUserDirectory();
      const refreshed = this.userIdCache.get(key);
      if (refreshed) return refreshed;
    }

    console.warn(`Slack user not found for email: ${email}`);
    return null;
  }

  /** Send a DM to a user by email. Returns true if sent. */
  async sendDM(email: string, text: string): Promise<boolean> {
    const userId = await this.resolveUserId(email);
    if (!userId) {
      console.warn(`Cannot DM ${email}: Slack user not found`);
      return false;
    }

    try {
      await this.client.chat.postMessage({
        channel: userId,
        text,
        unfurl_links: false,
      });
      return true;
    } catch (err) {
      console.error(`Failed to send DM to ${email} (${userId}):`, err);
      return false;
    }
  }

  /** Post a message to a channel. Returns the thread timestamp (for replies). */
  async postToChannel(channel: string, text: string): Promise<string | null> {
    try {
      const result = await this.client.chat.postMessage({
        channel,
        text,
        unfurl_links: false,
      });
      return result.ts ?? null;
    } catch (err) {
      console.error(`Failed to post to channel ${channel}:`, err);
      return null;
    }
  }

  /** Reply in a thread. */
  async replyInThread(channel: string, threadTs: string, text: string): Promise<boolean> {
    try {
      await this.client.chat.postMessage({
        channel,
        text,
        thread_ts: threadTs,
        unfurl_links: false,
      });
      return true;
    } catch (err) {
      console.error(`Failed to reply in thread ${threadTs}:`, err);
      return false;
    }
  }
}
