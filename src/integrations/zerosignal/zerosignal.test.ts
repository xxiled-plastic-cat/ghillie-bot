import assert from "node:assert/strict";
import test from "node:test";

import {
  assertZsProxyHealthy,
  assertZsResponseRequest,
  buildReplayInput,
  extractFunctionCalls,
  finalResponseFromStream,
  formatInferenceCostLine,
  normalizeAgentResponse,
  parseInferenceCostFromHeaders,
  prepareAgentTools,
  readZeroSignalConfig,
  runResponsesToolLoop,
  selectAgentResearchTools,
  summarizeInferenceCosts,
  withStreamTrue,
  zsProxyHealthzUrl,
  type ResponsesClient,
} from "./index.js";

test("readZeroSignalConfig defaults to local zs-proxy", () => {
  const config = readZeroSignalConfig({});
  assert.equal(config.openaiBaseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(config.openaiApiKey, "zerosignal");
  assert.equal(config.openaiModel, "glm-5.2");
  assert.equal(config.openaiReasoningEffort, "medium");
  assert.equal(config.aiMode, "full");
  assert.equal(config.aiMaxToolCalls, 16);
});

test("zsProxyHealthzUrl maps /v1 to /healthz", () => {
  assert.equal(
    zsProxyHealthzUrl("http://127.0.0.1:8080/v1"),
    "http://127.0.0.1:8080/healthz",
  );
});

test("parseInferenceCostFromHeaders reads X-Zs-Inference-Amount", () => {
  const headers = new Headers({
    "X-Zs-Inference-Amount": "0.0042",
    "X-Zs-Other": "meta",
    "Content-Type": "application/json",
  });
  assert.deepEqual(parseInferenceCostFromHeaders(headers), {
    amountUsdc: "0.0042",
    headers: {
      "x-zs-inference-amount": "0.0042",
      "x-zs-other": "meta",
    },
  });
});

test("summarizeInferenceCosts sums charges across requests", () => {
  const summary = summarizeInferenceCosts([
    { amountUsdc: "0.01", headers: { "x-zs-inference-amount": "0.01" } },
    { amountUsdc: "0.0025", headers: { "x-zs-inference-amount": "0.0025" } },
  ]);
  assert.equal(summary?.totalUsdc, "0.0125");
  assert.equal(summary?.requestCount, 2);
  assert.equal(
    formatInferenceCostLine(summary),
    "ZeroSignal inference: 2 request(s), $0.0125 USDC",
  );
});

test("parseInferenceCostFromHeaders skips missing amount", () => {
  assert.equal(
    parseInferenceCostFromHeaders(new Headers({ "x-zs-other": "1" })),
    undefined,
  );
  assert.equal(summarizeInferenceCosts([]), undefined);
  assert.equal(formatInferenceCostLine(undefined), undefined);
});

test("assertZsResponseRequest requires store:false and blocks previous_response_id", () => {
  assert.doesNotThrow(() => assertZsResponseRequest({ store: false, model: "x" }));
  assert.throws(
    () => assertZsResponseRequest({ model: "x" }),
    /store: false/,
  );
  assert.throws(
    () => assertZsResponseRequest({ store: true, model: "x" }),
    /store: false/,
  );
  assert.throws(
    () =>
      assertZsResponseRequest({
        store: false,
        previous_response_id: "resp_1",
      }),
    /previous_response_id/,
  );
});

test("normalizeAgentResponse treats empty id as missing", () => {
  const normalized = normalizeAgentResponse({
    id: "",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "hello" }],
      },
    ],
  });
  assert.equal(normalized.id, undefined);
  assert.equal(normalized.output_text, "hello");
});

test("prepareAgentTools strips payment and wallet fields from schemas", () => {
  const prepared = prepareAgentTools([
    {
      name: "amarok_list_opportunities",
      description: "list",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          paymentSignature: { type: "string" },
          agentAddress: { type: "string" },
        },
        required: ["limit", "paymentSignature", "agentAddress"],
      },
    },
  ]);
  const schema = prepared[0]?.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.equal(schema.properties.paymentSignature, undefined);
  assert.equal(schema.properties.agentAddress, undefined);
  assert.deepEqual(schema.required, ["limit"]);
});

test("selectAgentResearchTools excludes execution quote", () => {
  const selected = selectAgentResearchTools([
    {
      name: "amarok_list_opportunities",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "amarok_get_execution_quote",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "amarok_health",
      inputSchema: { type: "object", properties: {} },
    },
  ]);
  assert.deepEqual(
    selected.map((tool) => tool.name),
    ["amarok_list_opportunities"],
  );
});

test("selectAgentResearchTools lane mode excludes opportunities and keeps lane tools", () => {
  const selected = selectAgentResearchTools(
    [
      { name: "amarok_list_opportunities", inputSchema: { type: "object", properties: {} } },
      { name: "amarok_list_rewards", inputSchema: { type: "object", properties: {} } },
      { name: "amarok_list_spreads", inputSchema: { type: "object", properties: {} } },
      { name: "amarok_get_scan", inputSchema: { type: "object", properties: {} } },
    ],
    { researchMode: "lane" },
  );
  assert.deepEqual(
    selected.map((tool) => tool.name),
    ["amarok_list_rewards", "amarok_list_spreads", "amarok_get_scan"],
  );
});

test("runResponsesToolLoop replays transcript and never sends previous_response_id", async () => {
  const creates: unknown[] = [];
  const openai: ResponsesClient = {
    responses: {
      async create(request: unknown) {
        creates.push(request);
        if (creates.length === 1) {
          return {
            data: {
              id: "",
              output: [
                {
                  type: "function_call",
                  call_id: "call-1",
                  name: "amarok_list_opportunities",
                  arguments: JSON.stringify({ limit: 3 }),
                },
              ],
            },
            headers: new Headers({ "X-Zs-Inference-Amount": "0.001" }),
          };
        }
        return {
          data: {
            id: "",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Found 3 opportunities." }],
              },
            ],
            output_text: "Found 3 opportunities.",
          },
          headers: new Headers({ "X-Zs-Inference-Amount": "0.002" }),
        };
      },
    },
  };

  const result = await runResponsesToolLoop({
    openai,
    model: "glm-5.2",
    instructions: "smoke",
    initialInput: "Call amarok_list_opportunities once.",
    tools: [
      {
        type: "function",
        name: "amarok_list_opportunities",
        parameters: { type: "object", properties: {} },
      },
    ],
    maxTurns: 4,
    async runTools(calls) {
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.name, "amarok_list_opportunities");
      return [
        {
          type: "function_call_output",
          call_id: calls[0]!.call_id,
          output: JSON.stringify({ ok: true, count: 3 }),
        },
      ];
    },
  });

  assert.equal(creates.length, 2);
  const first = creates[0] as {
    store?: boolean;
    stream?: boolean;
    previous_response_id?: string;
  };
  assert.equal(first.store, false);
  assert.equal(first.stream, true);
  assert.equal(first.previous_response_id, undefined);

  const followUp = creates[1] as {
    store?: boolean;
    stream?: boolean;
    previous_response_id?: string;
    input: unknown;
  };
  assert.equal(followUp.store, false);
  assert.equal(followUp.stream, true);
  assert.equal(followUp.previous_response_id, undefined);
  assert.ok(Array.isArray(followUp.input));
  const input = followUp.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[0], {
    role: "user",
    content: "Call amarok_list_opportunities once.",
  });
  assert.ok(input.some((item) => item.type === "function_call"));
  assert.ok(input.some((item) => item.type === "function_call_output"));
  assert.equal(result.response.output_text, "Found 3 opportunities.");
  assert.equal(result.inferenceCost?.totalUsdc, "0.003");
  assert.equal(result.inferenceCost?.requestCount, 2);
});

test("buildReplayInput appends optional repair user message", () => {
  const input = buildReplayInput("start", [{ type: "function_call" }], "repair");
  assert.deepEqual(input[0], { role: "user", content: "start" });
  assert.deepEqual(input.at(-1), { role: "user", content: "repair" });
});

test("withStreamTrue forces stream: true and finalResponseFromStream drains SSE", async () => {
  assert.deepEqual(withStreamTrue({ model: "m", store: false }), {
    model: "m",
    store: false,
    stream: true,
  });

  const completed = {
    id: "resp-1",
    output: [{ type: "message", content: [] }],
    output_text: "done",
  };
  async function* events() {
    yield { type: "response.created", response: { id: "resp-1" } };
    yield { type: "response.output_text.delta", delta: "do" };
    yield { type: "response.completed", response: completed };
  }

  assert.deepEqual(await finalResponseFromStream(events()), completed);
  assert.deepEqual(await finalResponseFromStream(completed), completed);
  await assert.rejects(
    () =>
      finalResponseFromStream(
        (async function* () {
          yield {
            type: "response.failed",
            response: { error: { message: "operator down" } },
          };
        })(),
      ),
    /operator down/,
  );
});

test("extractFunctionCalls ignores non-call output", () => {
  assert.deepEqual(
    extractFunctionCalls([
      { type: "message", content: [] },
      {
        type: "function_call",
        call_id: "c1",
        name: "amarok_get_scan",
        arguments: "{}",
      },
    ]),
    [
      {
        type: "function_call",
        call_id: "c1",
        name: "amarok_get_scan",
        arguments: "{}",
      },
    ],
  );
});

test("assertZsProxyHealthy fails closed on non-ok", async () => {
  await assert.rejects(
    () =>
      assertZsProxyHealthy("http://127.0.0.1:8080/v1", {
        fetchImpl: async () => new Response("down", { status: 502 }),
      }),
    /zs-proxy unhealthy/,
  );
});

test("assertZsProxyHealthy fails closed on network error", async () => {
  await assert.rejects(
    () =>
      assertZsProxyHealthy("http://127.0.0.1:8080/v1", {
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    /zs-proxy unreachable/,
  );
});
