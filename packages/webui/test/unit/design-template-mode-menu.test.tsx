import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignNodeParams } from "../../src/client/features/design/ui/DesignNodeParams.js";
import { createWebuiDesignService } from "../../src/runtime/design/design-service.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const directory of cleanup.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("native Design template mode menu", () => {
  it("renders the image-mimic reverse-prompt node in its real describe mode", async () => {
    const base = join(homedir(), ".cache/minimax-code-test-artifacts/design-template-mode");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "run-"));
    cleanup.push(directory);
    const service = await createWebuiDesignService(directory);
    try {
      const state = await service.apply({
        action: { type: "apply_template", templateId: "image-mimic" },
      });
      const node = state.document?.nodes.find((item) => item.title === "反推提示词");
      expect(node).toBeDefined();
      expect(node?.metadata.mode).toBe("describe");
      const html = renderToStaticMarkup(
        <DesignNodeParams
          node={node!}
          data={state}
          onPatch={vi.fn(async () => undefined)}
          onAction={vi.fn(async () => undefined)}
        />,
      );
      // The actual mode control is the consumer of modeChoice: the current
      // value is describe, so its trigger must name 图生文. A palette passed
      // as caps hides describe/video2text and leaves the trigger unnamed.
      expect(html).toContain("图生文");
    } finally {
      await service.close();
    }
  });
});
