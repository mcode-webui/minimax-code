/**
 * The six scheduled-task validators, with their messages pinned.
 *
 * The package rule is explicit: a validator's message is what a person reads beside the field, so a
 * test that checks only the error code cannot see it change. Every rejection below is written out in
 * full for that reason.
 */
import { describe, expect, it } from "vitest";

import { WebuiErrorCode } from "../../src/shared/envelope.js";
import {
  createCronTaskOperation,
  deleteCronTaskOperation,
  listCronTaskRunsOperation,
  listCronTasksOperation,
  runCronTaskNowOperation,
  updateCronTaskOperation,
} from "../../src/server/operation/scheduling.js";

function rejected(validate: (body: unknown) => unknown, body: unknown) {
  return validate(body);
}

describe("the scheduled-task validators", () => {
  it("accepts the request each panel action sends", () => {
    expect(listCronTasksOperation.validate(undefined)).toEqual({ ok: true, body: {} });
    expect(listCronTasksOperation.validate({ limit: 10 })).toEqual({ ok: true, body: { limit: 10 } });
    expect(
      createCronTaskOperation.validate({
        name: "digest",
        agentName: "agent-one",
        prompt: "Write it.",
        schedule: { kind: "recurring", expression: "0 9 * * *" },
        sessionTarget: { mode: "new" },
      }),
    ).toMatchObject({ ok: true });
    expect(updateCronTaskOperation.validate({ cronId: "cron-1", enabled: false })).toMatchObject({
      ok: true,
    });
    expect(deleteCronTaskOperation.validate({ cronId: "cron-1" })).toEqual({
      ok: true,
      body: { cronId: "cron-1" },
    });
    expect(runCronTaskNowOperation.validate({ cronId: "cron-1" })).toEqual({
      ok: true,
      body: { cronId: "cron-1" },
    });
    expect(listCronTaskRunsOperation.validate({ cronId: "cron-1", limit: 5 })).toEqual({
      ok: true,
      body: { cronId: "cron-1", limit: 5 },
    });
  });

  it("names the field it rejected, in the words the editor shows", () => {
    expect(rejected(createCronTaskOperation.validate, [])).toEqual({
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "createCronTask需要对象请求体。",
    });
    expect(rejected(createCronTaskOperation.validate, { name: "  " })).toEqual({
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "name不能为空。",
    });
    expect(
      rejected(createCronTaskOperation.validate, {
        name: "digest",
        agentName: "agent-one",
        prompt: "Write it.",
        schedule: { kind: "recurring", expression: "0 9 *" },
        sessionTarget: { mode: "new" },
      }),
    ).toEqual({
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "schedule.expression必须是五段的 cron 表达式。",
    });
    expect(rejected(updateCronTaskOperation.validate, { cronId: "cron-1" })).toEqual({
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "updateCronTask没有要修改的字段。",
    });
    expect(rejected(deleteCronTaskOperation.validate, {})).toEqual({
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "cronId不能为空。",
    });
    expect(rejected(runCronTaskNowOperation.validate, { cronId: "" })).toEqual({
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "cronId不能为空。",
    });
    expect(rejected(listCronTaskRunsOperation.validate, { cronId: "cron-1", limit: 0 })).toEqual({
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "limit must be an integer between 1 and 200",
    });
  });
});
