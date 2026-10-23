import { expect, test } from "@playwright/test";

import {
  call,
  checked,
  control,
  deliveries,
  dispatch,
  scenario,
  seed,
  toolResult,
  type Scenario,
} from "./background-subagents.helpers";
import { sendMessage, typeMessage, SEND_BUTTON, APPROVAL_PANEL } from "./helpers";

test.describe("后台 Subagent：真实前后端与可控 HTTP 模型", () => {
  let current: Scenario | undefined;
  let errors: string[];
  let diagnostics: { level: string; text: string }[];

  test.beforeAll(async ({ request }) => {
    await seed(request);
  });
  test.beforeEach(async ({ page }) => {
    current = undefined;
    errors = [];
    diagnostics = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("crash", () => errors.push("Browser page crashed"));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        diagnostics.push({ level: message.type(), text: message.text() });
      }
    });
  });
  test.afterEach(async ({ page }, testInfo) => {
    await testInfo.attach("browser-diagnostics", {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: "application/json",
    });
    if (current?.sessionId) {
      await testInfo.attach("scenario-state", {
        body: JSON.stringify(await current.state(), null, 2),
        contentType: "application/json",
      });
      await current.cancel();
      expect((await current.state()).checkpoint_errors, "checkpoint cleanup errors").toEqual([]);
    }
    expect(errors, `uncaught browser errors at ${page.url()}`).toEqual([]);
  });

  test("后台调用立即返回，主代理继续调用工具，结果自动汇总且只投递一次", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch()] },
        { tools: [call("independent", "list_notes")] },
        { text: "E2E_WAITING" },
        { text: "E2E_DONE" },
      ],
      children: { one: [{ gate: "hold", text: "子代理独立结论：时间线一致。" }] },
    });
    await current.start();
    await current.until((state) =>
      state.calls.some((item) => item.actor === "parent" && item.step === 2),
    );
    const running = await current.state();
    expect(running.parent_running).toBe(true);
    expect(running.children[0].runtime_running).toBe(true);
    expect(toolResult(running, "one").background).toBe(true);
    expect(toolResult(running, "independent").success).not.toBe(false);
    expect(deliveries(running)).toHaveLength(0);
    await expect(page.getByText("已后台委派", { exact: true }).first()).toBeVisible();
    await current.release();
    const done = await current.finish();
    expect(deliveries(done)).toHaveLength(1);
    expect(deliveries(done)[0].display_channel).toBe("hidden");
    expect(done.requests[0].result_delivered).toBe(true);
    expect(JSON.stringify(done.calls.at(-1)?.messages)).toContain("时间线一致");
    await expect(page.getByText(/后台 Subagent 执行结果/)).toHaveCount(0);
    await page.reload();
    await current.reopen();
    await expect(page.getByText("E2E_DONE").first()).toBeVisible();
    expect(deliveries(await current.state())).toHaveLength(1);
  });
  for (const mode of [false, "omit"] as const) {
    test(`同步兼容：background=${mode} 时父代理等待子任务`, async ({ page }) => {
      current = await scenario(page, {
        parent: [{ tools: [dispatch("one", mode)] }, { text: "E2E_DONE" }],
        children: { one: [{ gate: "hold", text: "同步结果" }] },
      });
      await current.start();
      await current.until((state) =>
        state.calls.some((item) => item.actor === "one" && item.gate === "hold"),
      );
      const before = await current.state();
      expect(before.calls.filter((item) => item.actor === "parent")).toHaveLength(1);
      expect(before.requests[0].background).toBe(false);
      await current.release();
      const done = await current.finish();
      expect(toolResult(done, "one").result).toBe("同步结果");
      expect(deliveries(done)).toHaveLength(0);
    });
  }

  test("子任务瞬间完成仍回传唯一结果，Unicode 与长文本完整保存", async ({ page }) => {
    const text = '时间线𠮷野🌙\\"\n'.repeat(800);
    current = await scenario(page, {
      parent: [{ tools: [dispatch()] }, { until_results: 1, text: "E2E_DONE" }],
      children: { one: [{ text }] },
    });
    await current.start();
    const done = await current.finish();
    expect(done.requests[0].assistant_content).toBe(text.trim());
    expect(deliveries(done)).toHaveLength(1);
    expect(JSON.parse(deliveries(done)[0].content.split("\n").slice(1).join("\n")).result).toBe(
      text.trim(),
    );
  });

  test("多个后台任务逆序完成，逐次唤醒且结果不串线", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch("slow"), dispatch("fast")] },
        { until_results: 2, text: "E2E_DONE" },
      ],
      children: {
        slow: [{ gate: "slow", text: "SLOW_RESULT" }],
        fast: [{ gate: "fast", text: "FAST_RESULT" }],
      },
    });
    await current.start();
    await current.until(
      (state) =>
        state.children.length === 2 && state.calls.filter((item) => item.gate).length === 2,
    );
    await current.release("fast");
    const partial = await current.until((state) => deliveries(state).length === 1);
    expect(partial.parent_running).toBe(true);
    expect(deliveries(partial)[0].content).toContain("FAST_RESULT");
    await current.release("slow");
    const done = await current.finish();
    expect(deliveries(done)).toHaveLength(2);
    expect(new Set(done.requests.map((item) => item.id)).size).toBe(2);
    expect(done.requests.every((item) => item.result_delivered)).toBe(true);
  });

  test("一批十个后台任务全部完成，超限第十一个拒绝且不创建幽灵任务", async ({ page }) => {
    const labels = Array.from({ length: 11 }, (_, index) => `child${index}`);
    current = await scenario(page, {
      parent: [
        { tools: labels.map((label) => dispatch(label)) },
        { until_results: 10, text: "E2E_DONE" },
      ],
      children: Object.fromEntries(
        labels.map((label) => [label, [{ gate: "hold", text: `RESULT_${label}` }]]),
      ),
    });
    await current.start();
    await current.until(
      (state) =>
        state.children.length === 10 && state.calls.filter((item) => item.gate).length === 10,
    );
    const rejected = await current.until((state) =>
      state.calls.some((item) => item.actor === "parent" && item.step === 1),
    );
    const rejection = rejected.calls
      .find((item) => item.actor === "parent" && item.step === 1)!
      .messages.find((item) => item.role === "tool" && item.tool_call_id === "child10");
    expect(rejection?.content).toContain("at most 10 dispatches");
    await current.release();
    const done = await current.finish();
    expect(done.children).toHaveLength(10);
    expect(deliveries(done)).toHaveLength(10);
    expect(new Set(done.children.map((item) => item.metadata_json?.agent_number)).size).toBe(10);
  });

  test("后台通知复用同一会话、顺序排队，每轮结果绑定各自 request_id", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch()] },
        {
          tools: [
            call("notify", "notify_subagent", {
              dispatch_id: "$dispatch:one",
              prompt: "继续同一任务",
              background: true,
            }),
          ],
        },
        { until_results: 2, text: "E2E_DONE" },
      ],
      children: { one: [{ gate: "hold", text: "FIRST_RESULT" }, { text: "SECOND_RESULT" }] },
    });
    await current.start();
    const queued = await current.until(
      (state) =>
        state.requests.length === 2 &&
        state.calls.some((item) => item.actor === "parent" && item.step === 2),
    );
    expect(queued.children).toHaveLength(1);
    expect(toolResult(queued, "notify").background).toBe(true);
    expect(queued.requests.map((item) => item.seq)).toEqual([0, 1]);
    await current.release();
    const done = await current.finish();
    expect(done.requests.map((item) => item.assistant_content)).toEqual([
      "FIRST_RESULT",
      "SECOND_RESULT",
    ]);
    expect(deliveries(done)).toHaveLength(2);
    expect(
      JSON.stringify(done.calls.filter((item) => item.actor === "one").at(-1)?.messages),
    ).toContain("FIRST_RESULT");
  });

  test("同批重复通知只执行第一条，拒绝项不进入队列", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch()] },
        {
          tools: [
            call("notify1", "notify_subagent", {
              dispatch_id: "$dispatch:one",
              prompt: "第一条",
              background: true,
            }),
            call("notify2", "notify_subagent", {
              dispatch_id: "$dispatch:one",
              prompt: "不得执行",
              background: true,
            }),
          ],
        },
        { until_results: 2, text: "E2E_DONE" },
      ],
      children: { one: [{ gate: "hold", text: "FIRST_RESULT" }, { text: "NOTIFIED_RESULT" }] },
    });
    await current.start();
    const queued = await current.until((state) =>
      state.messages.some((item) => item.tool_call_id === "notify2"),
    );
    expect(toolResult(queued, "notify2").code).toBe("conflict");
    expect(queued.requests).toHaveLength(2);
    await current.release();
    const done = await current.finish();
    expect(done.requests.some((item) => item.content === "不得执行")).toBe(false);
  });

  for (const seconds of [0, 0.05]) {
    test(`显式等待 ${seconds} 秒超时，后台任务继续运行并最终回传`, async ({ page }) => {
      current = await scenario(page, {
        parent: [
          { tools: [dispatch()] },
          {
            tools: [
              call("wait", "wait_subagents", {
                dispatch_ids: ["$dispatch:one"],
                timeout_seconds: seconds,
              }),
            ],
          },
          { until_results: 1, text: "E2E_DONE" },
        ],
        children: { one: [{ gate: "hold", text: "AFTER_TIMEOUT" }] },
      });
      await current.start();
      const waiting = await current.until((state) =>
        state.messages.some((item) => item.tool_call_id === "wait"),
      );
      expect(toolResult(waiting, "wait").timed_out).toBe(true);
      expect(waiting.children[0].runtime_running).toBe(true);
      expect(waiting.requests[0].status).toBe("running");
      await current.release();
      expect((await current.finish()).requests[0].assistant_content).toBe("AFTER_TIMEOUT");
    });
  }

  test("等待多个任务时任一完成即可返回，不取消其余任务", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch("first"), dispatch("second")] },
        {
          tools: [
            call("wait", "wait_subagents", {
              dispatch_ids: ["$dispatch:first", "$dispatch:second"],
              timeout_seconds: 30,
            }),
          ],
        },
        { until_results: 2, text: "E2E_DONE" },
      ],
      children: {
        first: [{ gate: "first", text: "FIRST_RESULT" }],
        second: [{ gate: "second", text: "SECOND_RESULT" }],
      },
    });
    await current.start();
    await current.until(
      (state) =>
        state.children.length === 2 &&
        state.calls.some((item) => item.actor === "parent" && item.step === 1),
    );
    await current.release("second");
    const partial = await current.until((state) =>
      state.messages.some((item) => item.tool_call_id === "wait"),
    );
    const result = toolResult(partial, "wait");
    expect(result.timed_out).toBe(false);
    expect(JSON.stringify(result.results)).toContain("SECOND_RESULT");
    expect(partial.children.some((item) => item.runtime_running)).toBe(true);
    await current.release("first");
    await current.finish();
  });

  for (const args of [
    { dispatch_ids: [], timeout_seconds: 0 },
    {
      dispatch_ids: Array.from({ length: 11 }, (_, index) => `missing-${index}`),
      timeout_seconds: 0,
    },
    { dispatch_ids: ["nonexistent"], timeout_seconds: -1 },
    { dispatch_ids: ["nonexistent"], timeout_seconds: 301 },
  ]) {
    test(`非法 wait 参数拒绝而不破坏后台任务：${JSON.stringify(args)}`, async ({ page }) => {
      current = await scenario(page, {
        parent: [
          { tools: [dispatch()] },
          { tools: [call("bad-wait", "wait_subagents", args)] },
          { until_results: 1, text: "E2E_DONE" },
        ],
        children: { one: [{ gate: "hold", text: "VALID_RESULT" }] },
      });
      await current.start();
      const before = await current.until((state) =>
        state.messages.some((item) => item.tool_call_id === "bad-wait"),
      );
      expect(toolResult(before, "bad-wait").code).toBe("validation_error");
      await current.release();
      await current.finish();
    });
  }

  for (const agentType of ["does-not-exist", "writer"]) {
    test(`禁止派发未知或不在白名单的子代理：${agentType}`, async ({ page }) => {
      const invalid = dispatch();
      invalid.args.agent_type = agentType;
      current = await scenario(page, {
        parent: [{ tools: [invalid] }, { text: "E2E_DONE" }],
        children: {},
      });
      await current.start();
      const done = await current.finish();
      expect(done.children).toHaveLength(0);
      expect(toolResult(done, "one").success).toBe(false);
    });
  }

  test("子代理不能嵌套派发其他代理", async ({ page }) => {
    current = await scenario(page, {
      parent: [{ tools: [dispatch()] }, { until_results: 1, text: "E2E_DONE" }],
      children: { one: [{ tools: [dispatch("nested")] }, { text: "NESTED_REJECTED" }] },
    });
    await current.start();
    const done = await current.finish();
    expect(done.children).toHaveLength(1);
    expect(
      JSON.stringify(done.calls.filter((item) => item.actor === "one").at(-1)?.messages),
    ).toContain("未找到工具：dispatch_subagent");
  });

  for (const failure of ["transient", "permanent", "empty", "malformed"] as const) {
    test(`模型异常不会使父代理永久等待：${failure}`, async ({ page }) => {
      const steps =
        failure === "transient"
          ? [{ http_status: 503 }, { text: "RECOVERED_RESULT" }]
          : failure === "permanent"
            ? [{ http_status: 400 }]
            : failure === "empty"
              ? [{ text: "" }, { text: "RECOVERED_RESULT" }]
              : [{ malformed_stream: true }];
      current = await scenario(page, {
        parent: [{ tools: [dispatch()] }, { until_results: 1, text: "E2E_DONE" }],
        children: { one: steps },
      });
      await current.start();
      const done = await current.finish();
      expect(done.requests[0].status).toBe(failure === "transient" ? "completed" : "error");
      expect(deliveries(done)).toHaveLength(1);
      expect(done.children[0].runtime_running).toBe(false);
    });
  }

  for (const approved of [true, false]) {
    test(`子会话真实写入审批${approved ? "通过" : "拒绝"}后正确恢复父代理`, async ({ page }) => {
      current = await scenario(page, {
        parent: [{ tools: [dispatch()] }, { until_results: 1, text: "E2E_DONE" }],
        children: {
          one: [
            {
              tools: [
                call("write", "write_note", { title: "审批笔记", content: "由后台子代理创建" }),
              ],
            },
            { text: "CHILD_FINISHED" },
          ],
        },
      });
      await current.start();
      const waiting = await current.until((state) => state.children[0]?.status === "waiting_user");
      expect(waiting.notes).toHaveLength(0);
      expect(waiting.parent_running).toBe(true);
      await page.locator(".active-subagent-panel-toggle").click();
      await page.locator(".active-subagent-row").click();
      await expect(page.locator(APPROVAL_PANEL)).toBeVisible();
      await page
        .locator(APPROVAL_PANEL)
        .getByRole("button", { name: approved ? "执行" : "拒绝", exact: true })
        .click();
      await current.until((state) => state.requests[0]?.status === "completed");
      await page.getByRole("button", { name: "返回主会话", exact: true }).click();
      const done = await current.finish();
      expect(done.notes).toHaveLength(approved ? 1 : 0);
      expect(deliveries(done)).toHaveLength(1);
      if (approved) expect(done.notes[0].content).toContain("由后台子代理创建");
    });
  }

  test("父会话停止按钮取消整个后台树，新消息不会复活旧请求", async ({ page }) => {
    current = await scenario(page, {
      parent: [{ tools: [dispatch()] }, { text: "E2E_WAITING" }, { text: "NEW_TURN_DONE" }],
      children: {
        one: [{ gate: "hold", partial_text: "子代理流式输出中", text: "MUST_NOT_ARRIVE" }],
      },
    });
    await current.start();
    await current.until(
      (state) =>
        state.calls.some((item) => item.actor === "parent" && item.step === 1) &&
        state.children[0]?.runtime_running,
    );
    await page.locator(SEND_BUTTON).click();
    const cancelled = await current.until(
      (state) => !state.parent_running && !state.children[0].runtime_running,
    );
    expect(cancelled.requests[0].status).toBe("cancelled");
    expect(cancelled.revisions[0].status).toBe("cancelled");
    await current.release();
    await sendMessage(page, `E2E_SCENARIO:${current.id} 回复新轮次。`);
    const done = await current.finish("NEW_TURN_DONE");
    expect(done.requests).toHaveLength(1);
    expect(done.requests[0].status).toBe("cancelled");
    expect(deliveries(done)).toHaveLength(0);
  });

  test("仅取消一个子代理，父代理收到取消结果且其他子代理继续", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch("cancelled"), dispatch("survivor")] },
        { until_results: 2, text: "E2E_DONE" },
      ],
      children: {
        cancelled: [{ gate: "cancelled", text: "NEVER" }],
        survivor: [{ gate: "survivor", text: "SURVIVED" }],
      },
    });
    await current.start();
    const running = await current.until(
      (state) =>
        state.children.length === 2 && state.calls.filter((item) => item.gate).length === 2,
    );
    const cancelled = running.children.find(
      (item) => item.dispatch_id === toolResult(running, "cancelled").dispatch_id,
    )!;
    const response = await page.request.post(
      `/api/v1/agent/sessions/${current.sessionId}/subagents/${cancelled.id}/cancel`,
    );
    expect(response.ok()).toBeTruthy();
    const partial = await current.until(
      (state) =>
        state.requests.some((item) => item.status === "cancelled") &&
        deliveries(state).length === 1,
    );
    expect(partial.parent_running).toBe(true);
    expect(partial.children.some((item) => item.runtime_running)).toBe(true);
    const repeated = await page.request.post(
      `/api/v1/agent/sessions/${current.sessionId}/subagents/${cancelled.id}/cancel`,
    );
    expect(repeated.ok()).toBeTruthy();
    await current.release("survivor");
    const done = await current.finish();
    expect(done.requests.map((item) => item.status).sort()).toEqual(["cancelled", "completed"]);
    expect(deliveries(done)).toHaveLength(2);
  });

  test("取消与后台完成同时发生，不泄漏运行任务或重复投递", async ({ page }) => {
    current = await scenario(page, {
      parent: [{ tools: [dispatch()] }, { text: "E2E_WAITING" }, { text: "E2E_DONE" }],
      children: { one: [{ gate: "hold", text: "RACE_RESULT" }] },
    });
    await current.start();
    await current.until(
      (state) =>
        state.children[0]?.runtime_running &&
        state.calls.some((item) => item.actor === "parent" && item.step === 1),
    );
    await Promise.all([
      current.release(),
      page.request.post(`/api/v1/agent/sessions/${current.sessionId}/cancel`, { data: {} }),
    ]);
    const stopped = await current.until(
      (state) => !state.parent_running && state.children.every((item) => !item.runtime_running),
    );
    expect(stopped.task?.is_running).toBe(false);
    expect(deliveries(stopped).length).toBeLessThanOrEqual(1);
    expect(["completed", "cancelled"]).toContain(stopped.requests[0].status);
  });

  test("运行中刷新并重新打开任务，恢复后台状态和最终结果", async ({ page }) => {
    current = await scenario(page, {
      parent: [{ tools: [dispatch()] }, { until_results: 1, text: "E2E_DONE" }],
      children: { one: [{ gate: "hold", text: "REFRESH_RESULT" }] },
    });
    await current.start();
    await current.until((state) => state.children[0]?.runtime_running);
    await page.reload();
    await current.reopen();
    await expect(page.locator(".active-subagent-panel")).toBeVisible();
    await current.release();
    expect(deliveries(await current.finish())).toHaveLength(1);
  });

  test("浏览器离线期间后台完成，重连通过真实历史恢复结果", async ({ page, context }) => {
    current = await scenario(page, {
      parent: [{ tools: [dispatch()] }, { until_results: 1, text: "E2E_DONE" }],
      children: { one: [{ gate: "hold", text: "OFFLINE_RESULT" }] },
    });
    await current.start();
    await current.until((state) => state.children[0]?.runtime_running);
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    try {
      await current.release();
      await current.until((state) => !state.parent_running);
    } finally {
      await context.setOffline(false);
    }
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    const done = await current.finish();
    expect(deliveries(done)).toHaveLength(1);
  });

  test("两个标签页观察同一会话，不重复创建或执行子任务", async ({ page, context }) => {
    current = await scenario(page, {
      parent: [{ tools: [dispatch()] }, { until_results: 1, text: "E2E_DONE" }],
      children: { one: [{ gate: "hold", text: "TWO_TABS_RESULT" }] },
    });
    await current.start();
    await current.until((state) => state.children[0]?.runtime_running);
    const second = await context.newPage();
    try {
      await second.goto(`/projects/${current.projectId}`);
      const other = new (current.constructor as typeof Scenario)(
        second,
        current.id,
        current.projectId,
      );
      other.sessionId = current.sessionId;
      await other.reopen();
      await expect(second.locator(".active-subagent-panel")).toBeVisible();
      await current.release();
      const done = await current.finish();
      await expect(second.getByText("E2E_DONE").first()).toBeVisible();
      expect(done.children).toHaveLength(1);
      expect(done.calls.filter((item) => item.actor === "one")).toHaveLength(1);
      expect(deliveries(done)).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  test("后台等待期间发送新消息，父代理及时消费且子任务不重启", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch()] },
        { text: "E2E_WAITING" },
        { text: "NEW_INPUT_RECEIVED" },
        { text: "E2E_DONE" },
      ],
      children: { one: [{ gate: "hold", text: "ORIGINAL_CHILD_RESULT" }] },
    });
    await current.start();
    await current.until((state) =>
      state.calls.some((item) => item.actor === "parent" && item.step === 1),
    );
    await typeMessage(page, "新增约束：只检查第三章。");
    const sent = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/sessions/${current!.sessionId}/message`),
    );
    await page.locator(SEND_BUTTON).click();
    expect(((await (await sent).json()) as { queued: boolean }).queued).toBe(true);
    const updated = await current.until((state) =>
      state.calls.some((item) => item.actor === "parent" && item.step === 2),
    );
    expect(
      JSON.stringify(updated.calls.filter((item) => item.actor === "parent").at(-1)?.messages),
    ).toContain("新增约束");
    expect(updated.children[0].runtime_running).toBe(true);
    await current.release();
    const done = await current.finish();
    expect(done.children).toHaveLength(1);
  });

  test("父代理读取结果后遇到模型重试，持久化报告不重复", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch()] },
        { text: "E2E_WAITING" },
        { http_status: 503 },
        { text: "E2E_DONE" },
      ],
      children: { one: [{ gate: "hold", text: "RETRY_RESULT" }] },
    });
    await current.start();
    await current.until((state) =>
      state.calls.some((item) => item.actor === "parent" && item.step === 1),
    );
    await current.release();
    const done = await current.finish();
    expect(deliveries(done)).toHaveLength(1);
    const retried = done.calls.filter((item) => item.actor === "parent" && item.step >= 2);
    expect(retried).toHaveLength(2);
    expect(retried.every((item) => JSON.stringify(item.messages).includes("RETRY_RESULT"))).toBe(
      true,
    );
  });

  test("回收正在运行的子代理后父会话可结束，不再投递旧结果", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch()] },
        {
          tools: [
            call("recycle", "recycle_subagent", {
              dispatch_id: "$dispatch:one",
              reason: "测试回收",
            }),
          ],
        },
        { text: "E2E_DONE" },
      ],
      children: { one: [{ gate: "hold", text: "RECYCLED_RESULT_MUST_NOT_ARRIVE" }] },
    });
    await current.start();
    const done = await current.finish();
    expect(done.children[0].is_active).toBe(false);
    expect(done.requests[0].status).toBe("cancelled");
    expect(deliveries(done)).toHaveLength(0);
    await current.release();
    expect(deliveries(await current.state())).toHaveLength(0);
  });

  test("不同父会话隔离：不能取消其他会话的子任务", async ({ page, context }) => {
    const script = {
      parent: [{ tools: [dispatch()] }, { until_results: 1, text: "E2E_DONE" }],
      children: { one: [{ gate: "hold", text: "ISOLATED_RESULT" }] },
    };
    current = await scenario(page, script);
    await current.start();
    await current.until((state) => state.children[0]?.runtime_running);
    const secondPage = await context.newPage();
    const other = await scenario(secondPage, script);
    try {
      await other.start();
      const otherState = await other.until((state) => state.children[0]?.runtime_running);
      const denied = await page.request.post(
        `/api/v1/agent/sessions/${current.sessionId}/subagents/${otherState.children[0].id}/cancel`,
      );
      expect(denied.status()).toBe(404);
      await current.cancel();
      expect((await other.state()).children[0].runtime_running).toBe(true);
      await other.release();
      const done = await other.finish();
      expect(done.requests[0].status).toBe("completed");
      expect(deliveries(await current.state())).toHaveLength(0);
    } finally {
      await other.cancel();
      await secondPage.close();
    }
  });

  test("回滚父轮次撤销已审批的子代理写入，并清除其后台结果", async ({ page }) => {
    current = await scenario(page, {
      parent: [{ tools: [dispatch()] }, { until_results: 1, text: "E2E_DONE" }],
      children: {
        one: [
          {
            tools: [
              call("write", "write_note", { title: "待回滚笔记", content: "这条写入必须被回滚" }),
            ],
          },
          { text: "CHILD_WRITTEN" },
        ],
      },
    });
    await current.start();
    await current.until((state) => state.children[0]?.status === "waiting_user");
    await page.locator(".active-subagent-panel-toggle").click();
    await page.locator(".active-subagent-row").click();
    await page.locator(APPROVAL_PANEL).getByRole("button", { name: "执行", exact: true }).click();
    await current.until(
      (state) => state.notes.length === 1 && state.requests[0].status === "completed",
    );
    await page.getByRole("button", { name: "返回主会话", exact: true }).click();
    await current.finish();
    await page.locator(".agent-message-block[data-block-type='user']").first().hover();
    await page.getByRole("button", { name: "回滚到此处", exact: true }).first().click();
    await page.getByRole("button", { name: "确认回滚", exact: true }).click();
    const rolledBack = await current.until(
      (state) => state.notes.length === 0 && state.children[0].is_active === false,
    );
    expect(rolledBack.requests[0].status).toBe("cancelled");
    expect(deliveries(rolledBack)).toHaveLength(0);
    await expect(page.locator(".agent-message-scroll-content").getByText("E2E_DONE")).toHaveCount(
      0,
    );
    await expect(page.locator(".ai-sidebar-input-body[data-mode='composer']")).toContainText(
      `E2E_SCENARIO:${current.id}`,
    );
  });

  test("服务进程崩溃重启后取消遗留后台任务，历史恢复且新轮次可继续", async ({ page }) => {
    test.setTimeout(120_000);
    current = await scenario(page, {
      parent: [{ tools: [dispatch()] }, { text: "E2E_WAITING" }],
      children: { one: [{ gate: "hold", text: "MUST_NOT_SURVIVE_RESTART" }] },
    });
    await current.start();
    const running = await current.until(
      (state) =>
        state.children[0]?.runtime_running &&
        state.calls.some((item) => item.actor === "parent" && item.step === 1),
    );
    const originalChildId = running.children[0].id;
    await checked(page.request, "POST", `${control}/restart`);
    await expect
      .poll(
        async () => {
          try {
            const response = await page.request.get(
              `${control}/scenarios/${current!.id}/state?session_id=${current!.sessionId}`,
              { timeout: 2000 },
            );
            return response.status();
          } catch {
            return 0;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(404);
    // In-memory provider scripts disappear with the process; database state does not.
    await checked(page.request, "POST", `${control}/scenarios/${current.id}`, {
      parent: [{ text: "AFTER_RESTART_DONE" }],
      children: {},
    });
    const restarted = await current.state();
    expect(restarted.children[0].id).toBe(originalChildId);
    expect(restarted.requests[0].status).toBe("cancelled");
    expect(restarted.requests[0].error).toBe("server restarted");
    expect(restarted.parent_running).toBe(false);
    expect(restarted.task?.is_running).toBe(false);
    await page.reload();
    await current.reopen();
    await sendMessage(page, `E2E_SCENARIO:${current.id} 重启后请继续。`);
    const done = await current.finish("AFTER_RESTART_DONE");
    expect(done.children).toHaveLength(1);
    expect(done.requests).toHaveLength(1);
    expect(done.calls.every((item) => item.actor === "parent")).toBe(true);
  });

  for (const background of [false, "omit"] as const) {
    test(`通知同步兼容：background=${background} 时阻塞等待新一轮结果`, async ({ page }) => {
      current = await scenario(page, {
        parent: [
          { tools: [dispatch("one", false)] },
          {
            tools: [
              call("notify", "notify_subagent", {
                dispatch_id: "$dispatch:one",
                prompt: "第二轮同步通知",
                ...(background === "omit" ? {} : { background }),
              }),
            ],
          },
          { text: "E2E_DONE" },
        ],
        children: { one: [{ text: "FIRST_SYNC" }, { gate: "hold", text: "SECOND_SYNC" }] },
      });
      await current.start();
      const running = await current.until((state) =>
        state.calls.some((item) => item.actor === "one" && item.step === 1),
      );
      expect(running.calls.filter((item) => item.actor === "parent")).toHaveLength(2);
      expect(running.requests.every((item) => !item.background)).toBe(true);
      await current.release();
      const done = await current.finish();
      expect(toolResult(done, "notify").result).toBe("SECOND_SYNC");
      expect(deliveries(done)).toHaveLength(0);
    });
  }

  test("空闲子会话接受后台通知，等待最新请求不误用旧结果，重复 ID 去重", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch("one", false)] },
        {
          tools: [
            call("notify", "notify_subagent", {
              dispatch_id: "$dispatch:one",
              prompt: "新的后台轮次",
              background: true,
            }),
          ],
        },
        {
          tools: [
            call("wait-new", "wait_subagents", {
              dispatch_ids: ["$dispatch:one", "$dispatch:one"],
              timeout_seconds: 0,
            }),
          ],
        },
        { until_results: 1, text: "E2E_DONE" },
      ],
      children: { one: [{ text: "OLD_RESULT" }, { gate: "hold", text: "NEW_RESULT" }] },
    });
    await current.start();
    const pending = await current.until((state) =>
      state.messages.some((item) => item.tool_call_id === "wait-new"),
    );
    expect(toolResult(pending, "wait-new")).toEqual({ results: [], timed_out: true });
    expect(pending.requests[0].status).toBe("completed");
    expect(toolResult(pending, "notify").request_id).toBe(pending.requests[1].id);
    await current.release();
    const done = await current.finish();
    expect(done.children).toHaveLength(1);
    expect(deliveries(done)).toHaveLength(1);
    expect(deliveries(done)[0].content).toContain("NEW_RESULT");
    expect(deliveries(done)[0].content).not.toContain("OLD_RESULT");
  });

  test("等待不存在的会话返回工具错误，父代理仍可正常结束", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        {
          tools: [
            call("missing", "wait_subagents", {
              dispatch_ids: ["not-a-real-dispatch"],
              timeout_seconds: 0,
            }),
          ],
        },
        { text: "E2E_DONE" },
      ],
      children: {},
    });
    await current.start();
    const done = await current.finish();
    expect(toolResult(done, "missing").success).toBe(false);
    expect(done.children).toHaveLength(0);
  });

  test("已回收的会话拒绝后台通知，不产生新的排队请求", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch("one", false)] },
        { tools: [call("recycle", "recycle_subagent", { dispatch_id: "$dispatch:one" })] },
        {
          tools: [
            call("notify", "notify_subagent", {
              dispatch_id: "$dispatch:one",
              prompt: "不得重启",
              background: true,
            }),
          ],
        },
        { text: "E2E_DONE" },
      ],
      children: { one: [{ text: "FIRST_RESULT" }] },
    });
    await current.start();
    const done = await current.finish();
    expect(toolResult(done, "notify").success).toBe(false);
    expect(done.requests).toHaveLength(1);
    expect(done.calls.filter((item) => item.actor === "one")).toHaveLength(1);
    expect(done.children[0].is_active).toBe(false);
  });

  test("一个子代理模型失败不影响其他后台任务，父代理获得两种结果", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch("failed"), dispatch("survivor")] },
        { until_results: 2, text: "E2E_DONE" },
      ],
      children: {
        failed: [{ http_status: 400 }],
        survivor: [{ gate: "hold", text: "HEALTHY_RESULT" }],
      },
    });
    await current.start();
    const partial = await current.until((state) => deliveries(state).length === 1);
    expect(partial.parent_running).toBe(true);
    expect(deliveries(partial)[0].content).toContain('"status": "error"');
    await current.release();
    const done = await current.finish();
    expect(done.requests.map((item) => item.status).sort()).toEqual(["completed", "error"]);
    expect(deliveries(done)).toHaveLength(2);
  });

  test("父会话取消后提交旧审批返回冲突，不能写入或复活子任务", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch()] },
        {
          gate: "wait-approval",
          tools: [
            call("wait-approval", "wait_subagents", {
              dispatch_ids: ["$dispatch:one"],
              timeout_seconds: 30,
            }),
          ],
        },
        { text: "E2E_DONE" },
      ],
      children: {
        one: [
          { tools: [call("write", "write_note", { title: "不得写入", content: "取消后的写入" })] },
        ],
      },
    });
    await current.start();
    const waiting = await current.until((state) => state.children[0]?.status === "waiting_user");
    const approvalId = waiting.children[0].pending_approval_json!.approval_id;
    await current.release("wait-approval");
    const reported = await current.until((state) =>
      state.messages.some((item) => item.tool_call_id === "wait-approval"),
    );
    const result = toolResult(reported, "wait-approval");
    expect(result.timed_out).toBe(false);
    expect(result.results).toEqual([
      expect.objectContaining({ status: "waiting_user", request_id: waiting.requests[0].id }),
    ]);
    await current.cancel();
    const response = await page.request.post(
      `/api/v1/agent/sessions/${current.sessionId}/tool-approval`,
      {
        data: { approval_id: approvalId, approved: true },
      },
    );
    expect(response.status()).toBe(409);
    const stopped = await current.state();
    expect(stopped.notes).toHaveLength(0);
    expect(stopped.requests[0].status).toBe("cancelled");
    expect(stopped.children[0].runtime_running).toBe(false);
  });

  test("父模型永久错误后子任务完成，手动继续会话恢复未投递结果且不重复派发", async ({ page }) => {
    current = await scenario(page, {
      parent: [
        { tools: [dispatch()] },
        { http_status: 400, error: "E2E_PARENT_FAILURE" },
        { until_results: 1, text: "E2E_DONE" },
      ],
      children: { one: [{ gate: "hold", text: "RESULT_AFTER_PARENT_ERROR" }] },
    });
    await current.start();
    await current.until((state) =>
      state.calls.some((item) => item.actor === "one" && item.gate === "hold"),
    );
    await expect(page.getByRole("img", { name: /E2E_PARENT_FAILURE/ })).toBeVisible();
    await current.release();
    await current.until(
      (state) => !state.parent_running && state.requests[0].status === "completed",
    );
    expect(deliveries(await current.state())).toHaveLength(0);
    await page.getByRole("button", { name: "继续", exact: true }).click();
    const done = await current.finish();
    expect(deliveries(done)).toHaveLength(1);
    expect(done.children).toHaveLength(1);
    expect(JSON.stringify(done.calls.at(-1)?.messages)).toContain("RESULT_AFTER_PARENT_ERROR");
  });
});
