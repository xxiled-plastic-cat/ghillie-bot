#!/usr/bin/env node
/**
 * Filters zs-proxy stdout/stderr so CDN HTML gateway pages in err_body=
 * become short ZeroSignal summaries (keeps shared container logs readable).
 */
import { createInterface } from "node:readline";

function looksLikeHtml(text) {
  return /<!DOCTYPE\s+html/i.test(text) || /<\s*html\b/i.test(text);
}

function summarizeHtmlBody(status, body) {
  const statusPart = status ? `${status} ` : "";
  if (/504|Gateway Time-out/i.test(`${statusPart}${body}`)) {
    return `${statusPart}ZeroSignal gateway timeout (HTML body omitted)`.trim();
  }
  if (/502|Bad Gateway/i.test(`${statusPart}${body}`)) {
    return `${statusPart}ZeroSignal bad gateway (HTML body omitted)`.trim();
  }
  if (/503|Service Unavailable/i.test(`${statusPart}${body}`)) {
    return `${statusPart}ZeroSignal unavailable (HTML body omitted)`.trim();
  }
  return `${statusPart}ZeroSignal HTTP error (HTML body omitted)`.trim();
}

function sanitizeZsLogLine(line) {
  if (!line.includes("err_body=") || !looksLikeHtml(line)) {
    return line;
  }
  const prefix = line.replace(/\s*err_body=[\s\S]*$/, "").trimEnd();
  const status = /\bstatus=(\d{3})\b/.exec(line)?.[1];
  const bodyStart = line.indexOf("err_body=");
  const body = line
    .slice(bodyStart)
    .replace(/^err_body=/, "")
    .replace(/^"/, "")
    .replace(/"$/, "");
  const summary = summarizeHtmlBody(status, body).replaceAll('"', "'");
  return `${prefix} err_body="${summary}"`;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  process.stdout.write(`${sanitizeZsLogLine(line)}\n`);
});
rl.on("close", () => {
  process.stdout.write("");
});
