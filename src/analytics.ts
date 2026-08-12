import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";

export type AnalyticsProperties = Record<string, boolean | number | string | undefined>;

export class ProductAnalytics {
  private readonly client: PostHog | undefined;

  constructor(apiKey: string | undefined, host: string, private readonly salt: string) {
    if (!apiKey) return;
    this.client = new PostHog(apiKey, {
      host,
      flushAt: 20,
      flushInterval: 5_000,
      requestTimeout: 5_000,
    });
  }

  get enabled(): boolean {
    return Boolean(this.client);
  }

  capture(telegramId: number, event: string, properties: AnalyticsProperties = {}): void {
    this.client?.capture({
      distinctId: this.anonymousId(telegramId),
      event,
      properties: {
        ...properties,
        platform: "telegram",
      },
    });
  }

  async shutdown(): Promise<void> {
    if (this.client) await this.client._shutdown(5_000);
  }

  private anonymousId(telegramId: number): string {
    return createHash("sha256")
      .update(`${this.salt}:${telegramId}`)
      .digest("hex")
      .slice(0, 32);
  }

}
