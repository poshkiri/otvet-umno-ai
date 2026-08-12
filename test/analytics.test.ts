import assert from "node:assert/strict";
import test from "node:test";
import { ProductAnalytics } from "../src/analytics.js";

test("PostHog analytics stays disabled when no API key is configured", async () => {
  const analytics = new ProductAnalytics(undefined, "https://eu.i.posthog.com", "test-salt");
  assert.equal(analytics.enabled, false);
  analytics.capture(123, "bot_started", { source: "test" });
  await analytics.shutdown();
});
