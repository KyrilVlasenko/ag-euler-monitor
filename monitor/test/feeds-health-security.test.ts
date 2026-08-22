import assert from "node:assert/strict";
import test from "node:test";
import { canPersistProduction, executionMode } from "../src/config.js";
import { updateHealth } from "../src/collector.js";
import { buildNotificationFeed, notificationEventId } from "../src/format.js";
import { runWithFailover } from "../src/rpc.js";
import { auditPublicContent } from "../src/security.js";
import { emptyState, parseStateText } from "../src/state.js";
import type { CoverageIssue, NotificationEvent } from "../src/types.js";

const NOW = "2026-08-22T12:00:00.000Z";
const ISSUE: CoverageIssue = { chain_id: 1, chain_name: "Ethereum", vault_address: "0x0000000000000000000000000000000000000001", source: "rpc", reason: "risk-stage RPC read failed" };

test("23. monitor degraded after two consecutive incomplete runs", () => {
  const firstPrevious = emptyState();
  const firstNext = structuredClone(firstPrevious);
  const firstNotifications: NotificationEvent[] = [];
  updateHealth(firstPrevious, firstNext, [ISSUE], NOW, 2, firstNotifications);
  assert.equal(firstNotifications.length, 0);
  const secondNext = structuredClone(firstNext);
  const secondNotifications: NotificationEvent[] = [];
  updateHealth(firstNext, secondNext, [ISSUE], NOW, 2, secondNotifications);
  assert.equal(secondNotifications[0]?.type, "monitor_degraded");
  assert.equal(secondNext.health.degraded_alert_active, true);
});

test("24. monitor restored once", () => {
  const previous = emptyState();
  previous.health.degraded_alert_active = true;
  previous.health.consecutive_degraded_runs = 4;
  const next = structuredClone(previous);
  const notifications: NotificationEvent[] = [];
  updateHealth(previous, next, [], NOW, 2, notifications);
  assert.equal(notifications[0]?.type, "monitor_restored");
  assert.equal(next.health.degraded_alert_active, false);
});

test("25. RPC fallback selects the next endpoint without exposing URLs", async () => {
  const attempted: number[] = [];
  const fallbacks: string[] = [];
  const result = await runWithFailover(2, async (index) => {
    attempted.push(index);
    if (index === 0) throw new Error("first failed");
    return "ok";
  }, (failed, next) => fallbacks.push(`${failed}->${next}`), 1);
  assert.equal(result, "ok");
  assert.deepEqual(attempted, [0, 1]);
  assert.deepEqual(fallbacks, ["0->1"]);
});

test("27. test mode isolation", () => {
  assert.equal(executionMode(false, 80), "test");
  assert.equal(canPersistProduction(false, 80), false);
});

test("28. dry-run isolation", () => {
  assert.equal(executionMode(true), "dry-run");
  assert.equal(canPersistProduction(true), false);
  assert.equal(canPersistProduction(false), true);
});

test("29. deterministic notification event IDs", () => {
  const first = notificationEventId("risk_alert", 1, "0x0000000000000000000000000000000000000001", "block:100");
  const second = notificationEventId("risk_alert", 1, "0x0000000000000000000000000000000000000001", "block:100");
  assert.equal(first, second);
  assert.notEqual(first, notificationEventId("risk_alert", 1, "0x0000000000000000000000000000000000000001", "block:101"));
});

test("30. healthy silent run has an empty notification array", () => {
  const feed = buildNotificationFeed("run-1", NOW, NOW, "healthy", []);
  assert.deepEqual(feed.notifications, []);
});

test("32. public feed contains no secret data", () => {
  assert.doesNotThrow(() => auditPublicContent({ message: "Links: https://app.euler.finance/vault/0x0000000000000000000000000000000000000001" }));
  assert.throws(() => auditPublicContent({ endpoint: "https://user:password@rpc.example.invalid/key" }), /non-allowlisted URL/);
  assert.throws(() => auditPublicContent({ authorization: "Bearer top-secret" }), /authorization data|bearer credential/);
  assert.throws(() => auditPublicContent({ value: "RPC_URLS_JSON" }), /RPC environment field/);
});

test("invalid persistent state is not accepted as a baseline", () => {
  assert.equal(parseStateText("not-json"), undefined);
  assert.equal(parseStateText('{"schema_version":999}'), undefined);
  assert.equal(parseStateText(JSON.stringify(emptyState()))?.schema_version, 1);
});
