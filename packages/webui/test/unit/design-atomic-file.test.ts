/**
 * The Design runtime's atomic file write.
 *
 * Windows refuses a rename that replaces a file while another process holds
 * that file open for a moment, and the refusal is transient. Every state
 * file of the Design runtime is written that way, so the refusal used to
 * fail a whole Design operation: the canvas document was not written, the
 * run that belonged to it never started, and the node stayed idle for ever.
 */
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { writeFileAtomically } from "../../src/runtime/design/atomic-file.mjs";

function refusal(): Error & { code: string } {
  return Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
}

async function scratch(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "webui-design-atomic-"));
}

describe("the Design runtime's atomic file write", () => {
  it("retries the rename when Windows refuses it", async () => {
    const directory = await scratch();
    try {
      const file = path.join(directory, "design_document.json");
      await writeFile(file, "old", "utf8");
      let attempts = 0;
      await writeFileAtomically(file, "new", {
        platform: "win32",
        wait: async () => undefined,
        move: async (from, to) => {
          attempts += 1;
          if (attempts === 1) throw refusal();
          await rename(from, to);
        },
      });
      expect(attempts).toBe(2);
      expect(await readFile(file, "utf8")).toBe("new");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not retry the refusal away from Windows", async () => {
    const directory = await scratch();
    try {
      const file = path.join(directory, "design_document.json");
      await writeFile(file, "old", "utf8");
      let attempts = 0;
      await expect(
        writeFileAtomically(file, "new", {
          platform: "linux",
          move: async () => {
            attempts += 1;
            throw refusal();
          },
        }),
      ).rejects.toThrow("EPERM");
      expect(attempts).toBe(1);
      expect(await readFile(file, "utf8")).toBe("old");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves the old file and no temporary file behind when the write fails", async () => {
    const directory = await scratch();
    try {
      const file = path.join(directory, "design_document.json");
      await writeFile(file, "old", "utf8");
      await expect(
        writeFileAtomically(file, "new", {
          platform: "win32",
          wait: async () => undefined,
          move: async () => {
            throw refusal();
          },
        }),
      ).rejects.toThrow("EPERM");
      expect(await readdir(directory)).toEqual(["design_document.json"]);
      expect(await readFile(file, "utf8")).toBe("old");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces the file with the bytes it is given and leaves no temporary file", async () => {
    const directory = await scratch();
    try {
      const file = path.join(directory, "design_document.json");
      await writeFile(file, "old", "utf8");
      await writeFileAtomically(file, "new");
      expect(await readFile(file, "utf8")).toBe("new");
      expect(await readdir(directory)).toEqual(["design_document.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
