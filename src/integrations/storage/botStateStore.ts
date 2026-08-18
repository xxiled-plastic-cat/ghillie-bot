import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

export type BotStateStoreConfig = {
  spacesEndpoint?: string;
  spacesRegion: string;
  spacesBucket?: string;
  spacesKey?: string;
  spacesSecret?: string;
  spacesPrefix: string;
  localDataDir: string;
};

export interface BotStateStore {
  /** Object key for a state blob, e.g. `ghillie-bot/bot-states/alpha.json`. */
  objectKey(stateKey: string): string;
  getJson(stateKey: string): Promise<unknown | undefined>;
  putJson(stateKey: string, body: unknown): Promise<string>;
  /** Public-read showcase JSON at `{prefix}/public/{name}.json` (name has no slashes). */
  getPublicJson(name: string): Promise<unknown | undefined>;
  putPublicJson(name: string, body: unknown): Promise<string>;
}

export function isSpacesConfigured(config: BotStateStoreConfig): boolean {
  return Boolean(
    config.spacesEndpoint && config.spacesBucket && config.spacesKey && config.spacesSecret,
  );
}

export function readBotStateStoreConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BotStateStoreConfig {
  const endpoint = env.DO_SPACES_ENDPOINT?.trim() || undefined;
  const bucket = env.DO_SPACES_BUCKET?.trim() || undefined;
  const key = env.DO_SPACES_KEY?.trim() || undefined;
  const secret = env.DO_SPACES_SECRET?.trim() || undefined;
  const present = [endpoint, bucket, key, secret].filter(Boolean).length;
  if (present > 0 && present < 4) {
    throw new Error(
      "DO_SPACES_ENDPOINT, DO_SPACES_BUCKET, DO_SPACES_KEY, and DO_SPACES_SECRET must all be set or all omitted",
    );
  }
  return {
    spacesEndpoint: endpoint,
    spacesRegion: env.DO_SPACES_REGION?.trim() || "nyc3",
    spacesBucket: bucket,
    spacesKey: key,
    spacesSecret: secret,
    spacesPrefix: env.DO_SPACES_PREFIX?.trim() || "ghillie-bot",
    localDataDir: env.BOT_STATE_DATA_DIR?.trim() || "data/bot-states",
  };
}

export function createBotStateStore(
  config: BotStateStoreConfig = readBotStateStoreConfigFromEnv(),
): BotStateStore {
  if (isSpacesConfigured(config)) {
    return new SpacesBotStateStore({
      endpoint: config.spacesEndpoint!,
      region: config.spacesRegion,
      bucket: config.spacesBucket!,
      accessKeyId: config.spacesKey!,
      secretAccessKey: config.spacesSecret!,
      prefix: config.spacesPrefix,
    });
  }
  return new LocalFilesystemBotStateStore({
    rootDir: config.localDataDir,
    prefix: config.spacesPrefix,
  });
}

function objectKeyFor(prefix: string, stateKey: string): string {
  const safeKey = stateKey.trim();
  if (!safeKey || safeKey.includes("/") || safeKey.includes("..")) {
    throw new Error(`Invalid bot state key: ${JSON.stringify(stateKey)}`);
  }
  return joinKey(prefix, "bot-states", `${safeKey}.json`);
}

function publicObjectKeyFor(prefix: string, name: string): string {
  const safeName = name.trim().replace(/\.json$/i, "");
  if (!safeName || safeName.includes("/") || safeName.includes("..")) {
    throw new Error(`Invalid public object name: ${JSON.stringify(name)}`);
  }
  return joinKey(prefix, "public", `${safeName}.json`);
}

export class LocalFilesystemBotStateStore implements BotStateStore {
  private readonly rootDir: string;
  private readonly prefix: string;

  constructor(options: { rootDir: string; prefix?: string }) {
    this.rootDir = options.rootDir;
    this.prefix = trimSlashes(options.prefix ?? "");
  }

  objectKey(stateKey: string): string {
    return objectKeyFor(this.prefix, stateKey);
  }

  async getJson(stateKey: string): Promise<unknown | undefined> {
    const key = this.objectKey(stateKey);
    try {
      const text = await readFile(this.resolvePath(key), "utf8");
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (isErrnoNotFound(error)) return undefined;
      throw error;
    }
  }

  async putJson(stateKey: string, body: unknown): Promise<string> {
    const key = this.objectKey(stateKey);
    const filePath = this.resolvePath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(body), "utf8");
    return key;
  }

  async getPublicJson(name: string): Promise<unknown | undefined> {
    const key = publicObjectKeyFor(this.prefix, name);
    try {
      const text = await readFile(this.resolvePath(key), "utf8");
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (isErrnoNotFound(error)) return undefined;
      throw error;
    }
  }

  async putPublicJson(name: string, body: unknown): Promise<string> {
    const key = publicObjectKeyFor(this.prefix, name);
    const filePath = this.resolvePath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(body), "utf8");
    return key;
  }

  private resolvePath(key: string): string {
    return join(this.rootDir, ...key.split("/").filter((part) => part.length > 0));
  }
}

export type SpacesBotStateStoreOptions = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  client?: S3Client;
};

export class SpacesBotStateStore implements BotStateStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: SpacesBotStateStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = trimSlashes(options.prefix ?? "");
    this.client =
      options.client ??
      new S3Client({
        endpoint: options.endpoint,
        region: options.region,
        forcePathStyle: false,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
      } satisfies S3ClientConfig);
  }

  objectKey(stateKey: string): string {
    return objectKeyFor(this.prefix, stateKey);
  }

  async getJson(stateKey: string): Promise<unknown | undefined> {
    const key = this.objectKey(stateKey);
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      const text = await response.Body?.transformToString();
      if (!text) return undefined;
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async putJson(stateKey: string, body: unknown): Promise<string> {
    const key = this.objectKey(stateKey);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: "application/json",
        CacheControl: "no-store",
      }),
    );
    return key;
  }

  async getPublicJson(name: string): Promise<unknown | undefined> {
    const key = publicObjectKeyFor(this.prefix, name);
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      const text = await response.Body?.transformToString();
      if (!text) return undefined;
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async putPublicJson(name: string, body: unknown): Promise<string> {
    const key = publicObjectKeyFor(this.prefix, name);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: "application/json",
        ACL: "public-read",
        CacheControl: "public, max-age=60",
      }),
    );
    return key;
  }
}

function joinKey(...parts: string[]): string {
  return parts
    .map(trimSlashes)
    .filter((part) => part.length > 0)
    .join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return (
    record.name === "NoSuchKey" ||
    record.Code === "NoSuchKey" ||
    (record.$metadata !== undefined &&
      typeof record.$metadata === "object" &&
      (record.$metadata as { httpStatusCode?: number }).httpStatusCode === 404)
  );
}

function isErrnoNotFound(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
