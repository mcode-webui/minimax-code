/**
 * The stdio transport must read a message larger than the SDK's default buffer.
 *
 * The SDK closes the connection when one JSON-RPC message exceeds its default
 * 10 MiB buffer, and a single full-resolution image result (a Playwright
 * screenshot, a generated picture) crosses that line easily. The image is
 * re-encoded later, before it reaches a model request — but only if the message
 * arrives at all, so the limit has to be raised on the transport.
 *
 * The control case is the SDK's own default transport: it must still reject the
 * same message, otherwise this gate would pass for the wrong reason.
 */
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

import {
  createStdioTransport,
  MCP_STDIO_MAX_MESSAGE_BYTES,
} from '../src/runtime/transport/stdio.js';

/** Above the SDK default of 10 MiB, below the transport's own limit. */
const OVERSIZED_MESSAGE_BYTES = 12 * 1024 * 1024;

function oversizedWriter(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      '-e',
      `process.stdout.write("x".repeat(${OVERSIZED_MESSAGE_BYTES}) + "\\n")`,
    ],
  };
}

interface ObservableTransport {
  onerror?: (error: unknown) => void;
  onclose?: () => void;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** The first error the transport reports, or undefined when it reports none. */
async function readTransportError(transport: ObservableTransport): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 30_000);
    const settle = (message: string | undefined) => {
      clearTimeout(timer);
      resolve(message);
    };
    transport.onerror = (error: unknown) => {
      settle(error instanceof Error ? error.message : String(error));
    };
    transport.onclose = () => settle(undefined);
  });
}

describe('the stdio transport message limit', () => {
  it('reads a message the SDK default would reject', async () => {
    const writer = oversizedWriter();
    const transport = createStdioTransport({
      type: 'stdio',
      command: writer.command,
      args: writer.args,
    }) as unknown as ObservableTransport;
    const reported = readTransportError(transport);
    await transport.start();
    const error = await reported;
    await transport.close().catch(() => undefined);

    expect(error ?? '').not.toContain('ReadBuffer exceeded maximum size');
    expect(MCP_STDIO_MAX_MESSAGE_BYTES).toBeGreaterThan(OVERSIZED_MESSAGE_BYTES);
  });

  it('the SDK default transport rejects the same message', async () => {
    const writer = oversizedWriter();
    const transport = new StdioClientTransport({
      command: writer.command,
      args: writer.args,
      stderr: 'pipe',
    }) as unknown as ObservableTransport;
    const reported = readTransportError(transport);
    await transport.start();
    const error = await reported;
    await transport.close().catch(() => undefined);

    expect(error ?? '').toContain('ReadBuffer exceeded maximum size');
  });
});
