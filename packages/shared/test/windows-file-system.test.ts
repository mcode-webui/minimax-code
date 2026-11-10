/**
 * The Windows file-system retry helper.
 *
 * Windows refuses a file operation while another process holds the file
 * open for a moment, and the refusal is transient. The helper turns that
 * refusal into a retry, on Windows only, and only for the error codes that
 * mean "held" rather than "refused".
 */
import { describe, expect, it, vi } from "vitest";

import {
  retryWindowsFileSystemOperation,
  retryWindowsFileSystemOperationAsync,
} from "../src/windows-file-system.js";

function refusal(code: string): Error & { code: string } {
  return Object.assign(new Error(`refused: ${code}`), { code });
}

describe("the Windows file-system retry helper", () => {
  it("retries a transient refusal on Windows", async () => {
    const operation = vi.fn(async () => {
      throw refusal("EPERM");
    });
    const wait = vi.fn(async () => undefined);

    await expect(
      retryWindowsFileSystemOperationAsync(operation, { platform: "win32", wait }),
    ).rejects.toThrow("refused: EPERM");
    expect(operation).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(4);
  });

  it("returns the result once the refusal stops", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(refusal("EBUSY"))
      .mockResolvedValue("written");
    const wait = vi.fn(async () => undefined);

    await expect(
      retryWindowsFileSystemOperationAsync(operation, { platform: "win32", wait }),
    ).resolves.toBe("written");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry off Windows", async () => {
    const operation = vi.fn(async () => {
      throw refusal("EPERM");
    });

    await expect(
      retryWindowsFileSystemOperationAsync(operation, { platform: "linux" }),
    ).rejects.toThrow("refused: EPERM");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error that is not a held file", async () => {
    const operation = vi.fn(async () => {
      throw refusal("ENOENT");
    });

    await expect(
      retryWindowsFileSystemOperationAsync(operation, { platform: "win32" }),
    ).rejects.toThrow("refused: ENOENT");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("waits between attempts without blocking the event loop", async () => {
    const operation = vi.fn(async () => {
      throw refusal("EACCES");
    });
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 0);

    await expect(
      retryWindowsFileSystemOperationAsync(operation, { platform: "win32", retries: 1, retryDelayMs: 1 }),
    ).rejects.toThrow("refused: EACCES");
    clearTimeout(timer);
    expect(ticked).toBe(true);
  });

  it("retries a synchronous refusal the same way", () => {
    const operation = vi.fn(() => {
      throw refusal("EPERM");
    });

    expect(() =>
      retryWindowsFileSystemOperation(operation, { platform: "win32", wait: () => undefined }),
    ).toThrow("refused: EPERM");
    expect(operation).toHaveBeenCalledTimes(5);
  });
});