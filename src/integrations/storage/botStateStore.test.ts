import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isSpacesConfigured,
  LocalFilesystemBotStateStore,
  readBotStateStoreConfigFromEnv,
} from "./botStateStore.js";

test("readBotStateStoreConfigFromEnv rejects partial Spaces credentials", () => {
  assert.throws(
    () =>
      readBotStateStoreConfigFromEnv({
        DO_SPACES_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
        DO_SPACES_BUCKET: "bucket",
      }),
    /all be set or all omitted/,
  );
});

test("isSpacesConfigured is false when credentials omitted", () => {
  const config = readBotStateStoreConfigFromEnv({});
  assert.equal(isSpacesConfigured(config), false);
  assert.equal(config.spacesPrefix, "ghillie-bot");
  assert.equal(config.localDataDir, "data/bot-states");
});

test("LocalFilesystemBotStateStore round-trips JSON under prefixed key", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "ghillie-bot-state-"));
  try {
    const store = new LocalFilesystemBotStateStore({ rootDir, prefix: "ghillie-bot" });
    assert.equal(store.objectKey("alpha"), "ghillie-bot/bot-states/alpha.json");
    assert.equal(await store.getJson("alpha"), undefined);

    const payload = { lastUpdated: "2026-08-01T00:00:00.000Z", cash: 42 };
    const key = await store.putJson("alpha", payload);
    assert.equal(key, "ghillie-bot/bot-states/alpha.json");
    assert.deepEqual(await store.getJson("alpha"), payload);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("LocalFilesystemBotStateStore rejects unsafe state keys", () => {
  const store = new LocalFilesystemBotStateStore({ rootDir: "/tmp", prefix: "ghillie-bot" });
  assert.throws(() => store.objectKey("../escape"), /Invalid bot state key/);
  assert.throws(() => store.objectKey("a/b"), /Invalid bot state key/);
});

test("LocalFilesystemBotStateStore round-trips public JSON", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "ghillie-public-"));
  try {
    const store = new LocalFilesystemBotStateStore({ rootDir, prefix: "ghillie-bot" });
    assert.equal(await store.getPublicJson("pnl"), undefined);
    const key = await store.putPublicJson("pnl", { schemaVersion: 1, pnlAvailable: false });
    assert.equal(key, "ghillie-bot/public/pnl.json");
    assert.deepEqual(await store.getPublicJson("pnl"), { schemaVersion: 1, pnlAvailable: false });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
