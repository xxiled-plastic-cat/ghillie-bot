import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildPlanReviewInstructions,
  PLAN_REVIEW_PROMPT,
} from "../../alpha/planReview/prompt.js";
import { loadOperatorPreferences } from "./operatorPreferences.js";

describe("buildPlanReviewInstructions", () => {
  it("leaves the OS base prompt unchanged when prefs are empty", () => {
    assert.equal(buildPlanReviewInstructions(), PLAN_REVIEW_PROMPT);
    assert.equal(buildPlanReviewInstructions("  \n"), PLAN_REVIEW_PROMPT);
  });

  it("appends OPERATOR PREFERENCES when body is non-empty", () => {
    const withPrefs = buildPlanReviewInstructions(" Prefer reward lane over spread.\n");
    assert.match(withPrefs, /OPERATOR PREFERENCES/);
    assert.match(withPrefs, /Prefer reward lane over spread\./);
    assert.equal(withPrefs.startsWith(PLAN_REVIEW_PROMPT), true);
  });
});

describe("loadOperatorPreferences", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads from Spaces when present", async () => {
    const client = {
      send: async () => ({
        Body: {
          transformToString: async () => "  Prefer rewards, then spread.\n",
        },
      }),
    };

    const body = await loadOperatorPreferences({
      spaces: {
        endpoint: "https://example.digitaloceanspaces.com",
        region: "nyc3",
        bucket: "ghillie",
        accessKeyId: "key",
        secretAccessKey: "secret",
        prefix: "ghillie-bot",
        client: client as never,
      },
    });

    assert.equal(body, "Prefer rewards, then spread.");
  });

  it("returns undefined on Spaces 404", async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error("missing"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
      },
    };

    const body = await loadOperatorPreferences({
      spaces: {
        endpoint: "https://example.digitaloceanspaces.com",
        region: "nyc3",
        bucket: "ghillie",
        accessKeyId: "key",
        secretAccessKey: "secret",
        prefix: "ghillie-bot",
        client: client as never,
      },
    });
    assert.equal(body, undefined);
  });

  it("loads from a local convention path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghillie-prefs-"));
    tempDirs.push(dir);
    const path = join(dir, "operator-preferences.md");
    await writeFile(path, "Focus on maker rewards first.\n", "utf8");

    const body = await loadOperatorPreferences({ localPath: path });
    assert.equal(body, "Focus on maker rewards first.");
  });

  it("returns undefined when local file is missing", async () => {
    const body = await loadOperatorPreferences({
      localPath: join(tmpdir(), `missing-prefs-${Date.now()}.md`),
    });
    assert.equal(body, undefined);
  });
});
