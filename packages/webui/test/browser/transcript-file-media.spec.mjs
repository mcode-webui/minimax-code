// A delivered file that is a picture draws in the conversation, not just as a
// link, and survives the one moment its bytes are not ready yet.
//
// The reported shape: the agent finished, the row showed 极简 SVG 花朵 as a link,
// no picture — and a page reload made the picture appear. That points at a
// single failed load being permanent: the asset row renders as soon as the turn
// names the file, and the file is not readable until the write lands, so the
// first request fails and nothing retries it. A reload mounts a fresh element,
// which is why it "fixes itself" only then.
//
// The harness serves no workspace bytes, so this spec intercepts the request
// itself: attempt one fails, every later attempt returns a real SVG. A
// retrying reader therefore ends up with a picture; a reader that remembers the
// first failure ends up with a link and an invisible image.

import { expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { configureFixture, emitAgentMessage, emitStream, liveIndicator, openApp, startTurn, test } from "./harness.mjs";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#e05252"/></svg>';
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

for (const theme of ["light", "dark"]) {
test(`a different equal-length history reply keeps observed media and offers synchronization recovery (${theme})`, async ({ page }) => {
  await page.addInitScript((theme) => window.localStorage.setItem("webui-theme", theme), theme);
  await page.route("**/workspace-file**", (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG }));
  await openApp(page, "#session=A");
  await startTurn(page, "A", "Keep the observed file");
  const observed = 'AAAA<deliver-assets><media src="/synthetic/workspace/flower.svg" name="observed.svg" /></deliver-assets>';
  await emitAgentMessage(page, "A", { msg_id: "identity-check", msg_content: observed });
  await expect(deliveredRow(page).getByText("observed.svg")).toBeVisible();
  await page.evaluate(() => window.__fixture.setPage("A", { messages: [{
    msgId: "identity-check", role: "assistant", msgContent: 'BBBB<deliver-assets><media src="/synthetic/workspace/other.svg" name="replaced.svg" /></deliver-assets>',
  }], hasMore: false }));
  await emitStream(page, "A", { dataJson: "[DONE]" });
  const recovery = page.locator('[data-webui-transcript-sync="failed"]');
  await expect(recovery).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("turn-process-trigger")).toHaveAttribute("aria-expanded", "false");
  await expect(deliveredRow(page).getByText("observed.svg")).toBeVisible();
  await expect(deliveredRow(page).getByText("replaced.svg")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("synchronization-recovery.png"), animations: "disabled" });
  await expect(deliveredRow(page).locator("img")).toBeVisible();
  await page.evaluate((msgContent) => window.__fixture.setPage("A", { messages: [{
    msgId: "identity-check", role: "assistant", msgContent,
  }], hasMore: false }), observed);
  await recovery.getByRole("button", { name: "重试同步" }).click();
  await expect(recovery).toHaveCount(0);
  await expect(deliveredRow(page).getByText("observed.svg")).toHaveCount(1);
  await expect(deliveredRow(page).locator("img")).toHaveJSProperty("naturalWidth", 40);
});
}

/** The transcript row a `<deliver-assets>` block projects into. */
function deliveredRow(page) {
  return page.locator('[data-testid="delivered-assets-list"] .webui-delivered-asset');
}

for (const theme of ["light", "dark"]) {
test(`outside-workspace deliveries retain typed links, align labels and open previews (${theme})`, async ({ page }) => {
  await page.addInitScript((value) => window.localStorage.setItem("webui-theme", value), theme);
  await page.route("**/workspace-file**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await configureFixture(page, () => {
    window.__fixture.setResponse("readWorkspaceFile", { type: "text", content: "# Outside architecture" });
    window.__fixture.setPage("A", { messages: [{ msgId: "outside-files", role: "assistant", msgContent: '<deliver-assets><media src="/synthetic/artifacts/architecture.png" caption="架构设计图" /><media src="/synthetic/artifacts/design.md" caption="架构文档" /><media src="https://example.invalid/file.txt" caption="远程文件" /></deliver-assets>' }], hasMore: false });
  });
  await openApp(page, "#session=A");
  const rows = deliveredRow(page);
  const imageLink = rows.getByRole("link", { name: "架构设计图" });
  await expect(imageLink.locator("svg.tabler-icon-file-type-png")).toHaveCount(1);
  await expect(rows.locator("img")).toHaveJSProperty("naturalWidth", 1);
  const imageUrl = new URL(await rows.locator("img").getAttribute("src"), page.url());
  expect(imageUrl.searchParams.get("dir")).toBe("/synthetic/artifacts");
  expect(imageUrl.searchParams.get("path")).toBe("architecture.png");
  for (const text of ["架构设计图", "架构文档", "远程文件"]) {
    const delta = await rows.filter({ hasText: text }).evaluate((row) => {
      const icon = row.querySelector("svg").getBoundingClientRect();
      const label = row.querySelector(".webui-inline > span:last-child").getBoundingClientRect();
      return Math.abs(icon.top + icon.height / 2 - label.top - label.height / 2);
    });
    expect(delta).toBeLessThanOrEqual(1);
  }
  await imageLink.click();
  await expect(page.getByTestId("workspace-file-preview").locator("img")).toHaveJSProperty("naturalWidth", 1);
  await rows.getByRole("link", { name: "架构文档" }).click();
  await expect(page.getByTestId("workspace-file-preview")).toContainText("Outside architecture");
  const reads = await page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "readWorkspaceFile").map((request) => request.body));
  expect(reads).toContainEqual({ workspaceDir: "/synthetic/artifacts", path: "design.md" });
  await page.screenshot({ path: test.info().outputPath(`outside-files-${theme}.png`), animations: "disabled" });
});
}

test("a delivered picture appears after one failed load, without a reload", async ({ page }) => {
  let attempts = 0;
  await page.route("**/workspace-file**", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      // The write has not landed yet: the runtime says the path is not there.
      return route.fulfill({ status: 404, contentType: "text/plain", body: "not written yet" });
    }
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG });
  });

  await configureFixture(page, () => {
    window.__fixture.setPage("A", {
      messages: [
        {
          msgId: "m-flower",
          role: "assistant",
          msgContent: '画好了，见附件。\n\n<deliver-assets><media src="/synthetic/workspace/flower.svg" name="极简 SVG 花朵" /></deliver-assets>',
          timestamp: 1_700_000_000_300,
        },
      ],
      hasMore: false,
    });
  });

  await openApp(page, "#session=A");

  // The link is there from the first paint — that is what the report saw.
  await expect(deliveredRow(page).getByText("极简 SVG 花朵")).toBeVisible();

  // …and the picture must arrive without being reloaded into existence.
  const picture = deliveredRow(page).locator('[data-webui-file-media="image"] img');
  await expect(picture).toBeVisible({ timeout: 10_000 });
  await expect(picture).toHaveJSProperty("naturalWidth", 40);
  await expect.poll(() => attempts).toBeGreaterThan(1);
});

test("a delivered clip decodes and plays inside the transcript", async ({ page }) => {
  const video = await readFile(new URL("./support/composer-mascot-opaque.webm", import.meta.url));
  await page.route("**/workspace-file**", async (route) =>
    route.fulfill({ status: 200, contentType: "video/webm", body: video }),
  );

  await configureFixture(page, () => {
    window.__fixture.setPage("A", {
      messages: [
        {
          msgId: "m-clip",
          role: "assistant",
          msgContent: '录好了。\n\n<deliver-assets><media src="/synthetic/workspace/demo.webm" name="演示" /></deliver-assets>',
          timestamp: 1_700_000_000_301,
        },
      ],
      hasMore: false,
    });
  });

  await openApp(page, "#session=A");
  const player = deliveredRow(page).locator('[data-webui-file-media="video"] video[controls]');
  await expect(player).toBeVisible();
  await expect.poll(() => player.evaluate((node) => node.videoWidth)).toBeGreaterThan(0);
  await player.evaluate(async (node) => { node.muted = true; await node.play(); });
  await expect.poll(() => player.evaluate((node) => node.currentTime)).toBeGreaterThan(0);
});

test("delivered music decodes inside the transcript without opening a file", async ({ page }) => {
  const wav = Buffer.alloc(44 + 16_000);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24); wav.writeUInt32LE(16_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(16_000, 40);
  await page.route("**/workspace-file**", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: wav }));
  await configureFixture(page, () => window.__fixture.setPage("A", {
    messages: [{ msgId: "music", role: "assistant", msgContent: '<deliver-assets><media src="/synthetic/workspace/song.wav" name="音乐" /></deliver-assets>' }],
    hasMore: false,
  }));
  await openApp(page, "#session=A");
  await expect(deliveredRow(page).getByText("音乐", { exact: true })).toBeVisible();
  const player = deliveredRow(page).locator('[data-webui-file-media="audio"] audio[controls]');
  await expect(player).toBeVisible();
  await expect.poll(() => player.evaluate((node) => node.duration)).toBe(1);
  await player.evaluate(async (node) => { node.muted = true; await node.play(); });
  await expect.poll(() => player.evaluate((node) => node.currentTime)).toBeGreaterThan(0);
});

test("a Markdown image displays workspace pixels rather than only its alt text", async ({ page }) => {
  await page.route("**/workspace-file**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await configureFixture(page, () => window.__fixture.setPage("A", {
    messages: [{ msgId: "markdown-image", role: "assistant", msgContent: "![PNG picture](flower.png)" }],
    hasMore: false,
  }));
  await openApp(page, "#session=A");
  const picture = page.locator('[data-webui-file-media="image"] img');
  await expect(picture).toBeVisible();
  await expect(picture).toHaveJSProperty("naturalWidth", 1);
});

test("a bare media filename in inline code displays its workspace image", async ({ page }) => {
  await page.route("**/workspace-file**", (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG }));
  await configureFixture(page, () => window.__fixture.setPage("A", {
    messages: [{ msgId: "inline-image", role: "assistant", msgContent: "See `flower.svg`." }],
    hasMore: false,
  }));
  await openApp(page, "#session=A");
  const picture = page.locator('[data-webui-file-media="image"] img');
  await expect(picture).toBeVisible();
  await expect(picture).toHaveJSProperty("naturalWidth", 40);
});

test("a session present only in the tree still resolves its media workspace", async ({ page }) => {
  await page.route("**/workspace-file**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await configureFixture(page, () => {
    window.__fixture.setSessions([]);
    window.__fixture.setPage("A", { messages: [{ msgId: "tree-image", role: "assistant", msgContent: "[Picture](flower.png)" }], hasMore: false });
  });
  await openApp(page, "#session=A");
  const picture = page.locator('[data-webui-file-media="image"] img');
  await expect(picture).toBeVisible();
  await expect(picture).toHaveJSProperty("naturalWidth", 1);
});

test("a directly opened session outside both catalogue pages acquires its workspace", async ({ page }) => {
  await page.route("**/workspace-file**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await configureFixture(page, () => {
    window.__fixture.setSessions([]);
    window.__fixture.setTree({ sessions: [], hasMore: false });
    window.__fixture.setResponse("getSession", { session: { sessionId: "A", agentName: "external-agent", createdAt: 1, updatedAt: 1, workspaceDir: "/synthetic/workspace" } });
    window.__fixture.setPage("A", { messages: [{ msgId: "direct-image", role: "assistant", msgContent: "[Picture](flower.png)" }], hasMore: false });
  });
  await openApp(page, "#session=A");
  const picture = page.locator('[data-webui-file-media="image"] img');
  await expect(picture).toBeVisible();
  await expect(picture).toHaveJSProperty("naturalWidth", 1);
  expect(await page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "getSession" && request.body.id === "A").length)).toBe(1);
});

test("a delivered source file stays a plain link", async ({ page }) => {
  let attempts = 0;
  await page.route("**/workspace-file**", async (route) => {
    attempts += 1;
    return route.fulfill({ status: 200, contentType: "text/plain", body: "export const a = 1;\n" });
  });

  await configureFixture(page, () => {
    window.__fixture.setPage("A", {
      messages: [
        {
          msgId: "m-source",
          role: "assistant",
          msgContent: '改完了。\n\n<deliver-assets><media src="/synthetic/workspace/a.ts" name="a.ts" /></deliver-assets>',
          timestamp: 1_700_000_000_302,
        },
      ],
      hasMore: false,
    });
  });

  await openApp(page, "#session=A");
  await expect(deliveredRow(page).getByText("a.ts")).toBeVisible();
  await expect(page.locator("[data-webui-file-media]")).toHaveCount(0);
  // Nothing asked for bytes: a source file is not a picture.
  expect(attempts).toBe(0);
});

for (const theme of ["light", "dark"]) {
test(`an inline file label shares the surrounding prose baseline (${theme})`, async ({ page }) => {
  await page.addInitScript((value) => window.localStorage.setItem("webui-theme", value), theme);
  await configureFixture(page, () => window.__fixture.setPage("A", {
    messages: [{ msgId: "inline-baseline", role: "assistant", msgContent: "正文 before `runtime/port.ts` after 是唯一能力边界。\n\n### 标题 before `runtime/port.ts` after 是唯一能力边界。" }], hasMore: false,
  }));
  await openApp(page, "#session=A");
  const links = page.locator("a.webui-message-file-link");
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) {
    const geometry = await link.evaluate((anchor) => {
      const text = anchor.previousSibling;
      const index = text.textContent.indexOf("before");
      const prose = document.createRange();
      prose.setStart(text, index); prose.setEnd(text, index + 6);
      const label = document.createRange();
      label.selectNodeContents(anchor.lastElementChild);
      return { prose: prose.getBoundingClientRect().bottom, label: label.getBoundingClientRect().bottom };
    });
    expect(Math.abs(geometry.prose - geometry.label)).toBeLessThanOrEqual(1);
  }
  await page.locator(".webui-markdown").filter({ hasText: "正文 before" }).screenshot({ path: test.info().outputPath(`inline-file-baseline-${theme}.png`), animations: "disabled" });
});
}

test("a file link icon is vertically centered with its label", async ({ page }) => {
  await page.route("**/workspace-file**", async (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG }),
  );

  await configureFixture(page, () => {
    window.__fixture.setPage("A", {
      messages: [{
        msgId: "m-file-link-alignment",
        role: "assistant",
        msgContent: "- [flower.svg — 极简 SVG 花朵](flower.svg)",
        timestamp: 1_700_000_000_303,
      }],
      hasMore: false,
    });
  });

  await openApp(page, "#session=A");
  const link = page.locator("a.webui-message-file-link").filter({ hasText: "flower.svg" });
  await expect(link).toBeVisible();
  const alignment = await link.evaluate((anchor) => {
    const icon = anchor.querySelector("svg");
    const label = anchor.children.item(1);
    if (!icon || !label) throw new Error("File link icon or label is missing");
    const iconRect = icon.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    return {
      iconCenter: iconRect.top + iconRect.height / 2,
      labelCenter: labelRect.top + labelRect.height / 2,
    };
  });
  expect(Math.abs(alignment.iconCenter - alignment.labelCenter)).toBeLessThanOrEqual(1);
});

// The reported shape, on the path that actually produces it: the turn ends and
// the transcript swaps the live view for the persisted page. That page is read
// exactly once, at the earliest possible moment, so a runtime that is still
// writing the turn hands back a page without it — and the reply, its file row
// and its picture all stay missing until the reader reloads.
test("a settled turn whose page is still being written is read again, not left blank", async ({ page }) => {
  await page.route("**/workspace-file**", async (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG }),
  );

  await openApp(page, "#session=A");
  await startTurn(page, "A", "画一朵花");
  await expect(liveIndicator(page)).toBeVisible();
  await emitAgentMessage(page, "A", {
    msg_id: "m-live",
    msg_content: '画好了，见附件。\n\n<deliver-assets><media src="/synthetic/workspace/flower.svg" name="极简 SVG 花朵" /></deliver-assets>',
  });

  // While the turn is live the row and its picture are there.
  await expect(deliveredRow(page).getByText("极简 SVG 花朵")).toBeVisible();
  await expect(deliveredRow(page).locator('[data-webui-file-media="image"] img')).toBeVisible();

  // The runtime persists the turn a moment AFTER it says the turn is done —
  // the ordering this client asks the page for. The persisted page therefore
  // arrives late, exactly as it does against a real runtime.
  await page.evaluate(() => {
    window.setTimeout(() => {
      window.__fixture.setPage("A", {
        messages: [
          { msgId: "history-A", role: "user", msgContent: "History A synthetic", timestamp: 1_700_000_000_001 },
          {
            msgId: "m-live",
            role: "assistant",
            msgContent: '画好了，见附件。\n\n<deliver-assets><media src="/synthetic/workspace/flower.svg" name="极简 SVG 花朵" /></deliver-assets>',
            timestamp: 1_700_000_000_310,
          },
        ],
        hasMore: false,
      });
    }, 1_200);
  });

  await emitStream(page, "A", { dataJson: "[DONE]" });

  // The reply must come back without a reload: read again until the page that
  // arrives actually holds the turn.
  await expect(deliveredRow(page).getByText("极简 SVG 花朵")).toBeVisible({ timeout: 15_000 });
  await expect(deliveredRow(page).locator('[data-webui-file-media="image"] img')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-webui-transcript]")).toContainText("画好了");
});

// The second half of the same race, and the shape the reader reported after the
// first fix: the turn is written in two steps. Step one persists the reply's
// text; step two adds the file it delivered. A page read between them carries
// the message, so a reader that only checks "is the message there" accepts it —
// and the file row and picture the reader just saw disappear until a reload.
test("a settled turn keeps its file row when the write lands in two steps", async ({ page }) => {
  await page.route("**/workspace-file**", async (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG }),
  );

  await openApp(page, "#session=A");
  await startTurn(page, "A", "画一朵花");
  await expect(liveIndicator(page)).toBeVisible();
  await emitAgentMessage(page, "A", {
    msg_id: "m-two-step",
    msg_content: '画好了，见附件。\n\n<deliver-assets><media src="/synthetic/workspace/flower.svg" name="极简 SVG 花朵" /></deliver-assets>',
  });
  await expect(deliveredRow(page).getByText("极简 SVG 花朵")).toBeVisible();

  // Step one: the reply's text is persisted, the delivered file is not yet.
  await page.evaluate(() => {
    window.__fixture.setPage("A", {
      messages: [
        { msgId: "history-A", role: "user", msgContent: "History A synthetic", timestamp: 1_700_000_000_001 },
        { msgId: "m-two-step", role: "assistant", msgContent: "画好了，见附件。", timestamp: 1_700_000_000_320 },
      ],
      hasMore: false,
    });
    // Step two: the file lands with it.
    window.setTimeout(() => {
      window.__fixture.setPage("A", {
        messages: [
          { msgId: "history-A", role: "user", msgContent: "History A synthetic", timestamp: 1_700_000_000_001 },
          {
            msgId: "m-two-step",
            role: "assistant",
            msgContent: '画好了，见附件。\n\n<deliver-assets><media src="/synthetic/workspace/flower.svg" name="极简 SVG 花朵" /></deliver-assets>',
            timestamp: 1_700_000_000_320,
          },
        ],
        hasMore: false,
      });
    }, 1_500);
  });

  await emitStream(page, "A", { dataJson: "[DONE]" });

  // The row must survive the swap and stay: never a window where the reader
  // sees the file and then loses it.
  const row = deliveredRow(page).getByText("极简 SVG 花朵");
  await expect(row).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2_000);
  await expect(row).toBeVisible();
  await expect(deliveredRow(page).locator('[data-webui-file-media="image"] img')).toBeVisible();
});

test("a delivered PNG stays visible after settle while history is still catching up", async ({ page }) => {
  await page.route("**/workspace-file**", async (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );

  await openApp(page, "#session=A");
  await startTurn(page, "A", "画一张 PNG");
  await expect(liveIndicator(page)).toBeVisible();
  const pngMessage = '画好了。\n\n<deliver-assets><media src="/synthetic/workspace/flower.png" name="PNG 花朵" /></deliver-assets>';
  await emitAgentMessage(page, "A", {
    msg_id: "m-png-late-history",
    msg_content: pngMessage,
  });
  const picture = deliveredRow(page).locator('[data-webui-file-media="image"] img');
  await expect(picture).toBeVisible();
  await expect(picture).toHaveJSProperty("naturalWidth", 1);

  // The first persisted read after [DONE] sees the assistant text, but not its
  // delivered PNG. A later write eventually supplies the complete page.
  await page.evaluate((message) => {
    window.__fixture.setPage("A", {
      messages: [
        { msgId: "history-A", role: "user", msgContent: "画一张 PNG", timestamp: 1_700_000_000_001 },
        { msgId: "m-png-late-history", role: "assistant", msgContent: "画好了。", timestamp: 1_700_000_000_330 },
      ],
      hasMore: false,
    });
    window.setTimeout(() => {
      window.__fixture.setPage("A", {
        messages: [
          { msgId: "history-A", role: "user", msgContent: "画一张 PNG", timestamp: 1_700_000_000_001 },
          { msgId: "history-caught-up", role: "user", msgContent: "历史页已完整写入", timestamp: 1_700_000_000_329 },
          { msgId: "m-png-late-history", role: "assistant", msgContent: message, timestamp: 1_700_000_000_330 },
        ],
        hasMore: false,
      });
    }, 5_000);
  }, pngMessage);
  await emitStream(page, "A", { dataJson: "[DONE]" });

  // The lag exceeds the current bounded reread budget. The live PNG must stay
  // on screen during that gap and must converge to history when it arrives.
  await page.waitForTimeout(4_000);
  await expect(deliveredRow(page).getByText("PNG 花朵")).toBeVisible();
  await expect(picture).toBeVisible();
  await expect(picture).toHaveJSProperty("naturalWidth", 1);
  await expect(page.locator("[data-webui-transcript]")).toContainText("历史页已完整写入", { timeout: 8_000 });
  await expect(deliveredRow(page).getByText("PNG 花朵")).toBeVisible();
  await expect(picture).toBeVisible();
});

test("a file link in the final frame survives when the stream settles in the same task", async ({ page }) => {
  await page.route("**/workspace-file**", async (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );

  await openApp(page, "#session=A");
  await startTurn(page, "A", "画一朵花");
  await expect(liveIndicator(page)).toBeVisible();
  const finalAnswer = "画好了。\n\n- [flower.png — 极简五瓣花](flower.png)";

  // The runtime can publish its completed assistant message and [DONE] back to
  // back. Keep history stale until after the client has settled the stream.
  await page.evaluate((answer) => {
    window.__fixture.emitStream("A", {
      dataJson: JSON.stringify({
        type: "agent_message",
        agent_message: { msg_id: "m-same-task", msg_content: answer },
      }),
    });
    window.__fixture.emitStream("A", { dataJson: "[DONE]" });
    window.setTimeout(() => {
      window.__fixture.setPage("A", {
        messages: [
          { msgId: "history-A", role: "user", msgContent: "画一朵花", timestamp: 1_700_000_000_001 },
          { msgId: "m-same-task", role: "assistant", msgContent: answer, timestamp: 1_700_000_000_340 },
        ],
        hasMore: false,
      });
    }, 1_500);
  }, finalAnswer);

  const preview = page.locator('[data-webui-file-media="image"] img');
  await expect(preview).toBeVisible({ timeout: 10_000 });
  await expect(preview).toHaveJSProperty("naturalWidth", 1);
  await page.waitForTimeout(2_000);
  await expect(preview).toBeVisible();
});
