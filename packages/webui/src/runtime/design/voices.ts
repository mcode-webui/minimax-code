import type { NativeDesignExecution } from "@mavis/local-runtime-v2/process-local";
import type { DesignVoice } from "../../shared/contracts/design.js";
import { decodeHostConnectorValue } from "./host-connector-value.mjs";

/** Same live catalogue operation as AI Node Canvas 1.22.9; capability ownership stays with the host. */
export async function readDesignVoices(execution: NativeDesignExecution | undefined, signal: AbortSignal): Promise<{ voices: DesignVoice[]; voiceSource: string; voiceError?: string }> {
  if (!execution) return { voices: [], voiceSource: "no-connector", voiceError: "当前客户端未授予连接器访问权限。" };
  try {
    const inventory = await execution.hostConnector.list();
    const tool = inventory.tools.find((item) => /matrix.*get_voice_list$/.test(item.name)) ?? inventory.tools.find((item) => /(^|_)get_voice_list$/.test(item.name));
    if (!tool) return { voices: [], voiceSource: "tool-missing", voiceError: "当前连接器没有提供音色清单。" };
    const response = await execution.hostConnector.call(tool.toolRef, {}, { signal });
    const value = decodeHostConnectorValue(response && typeof response === "object" && "value" in response ? response.value : response);
    const list: unknown[] = value && typeof value === "object" && "available_voices" in value && Array.isArray(value.available_voices) ? value.available_voices : [];
    const voices = list.filter((item: unknown): item is { voice_id: string; voice_name?: string } => Boolean(item && typeof item === "object" && "voice_id" in item && typeof item.voice_id === "string")).map((item: { voice_id: string; voice_name?: string }) => ({ value: item.voice_id, label: item.voice_name ?? item.voice_id }));
    return { voices, voiceSource: "connector", ...(!voices.length ? { voiceError: "连接器没有返回可用音色。" } : {}) };
  } catch (error) { return { voices: [], voiceSource: "error", voiceError: `读取音色清单失败：${error instanceof Error ? error.message : String(error)}` }; }
}
