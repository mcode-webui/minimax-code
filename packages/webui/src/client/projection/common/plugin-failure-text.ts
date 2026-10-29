// The plugin surfaces' shared reading of a failed plugin request.
//
// The runtime's own code is the fact, and for most refusals the code is all it
// sends — `PLUGIN_AUTH_REQUIRED` is a wire name, not an instruction. This
// module is where a refusal becomes something a person can act on, and it is
// shared by every plugin surface: the marketplace, the management list and the
// Mini App catalogue's apps area all report the same failure the same way.
//
// A code this client does not know keeps the runtime's own text: a refusal
// nobody prepared for is still shown rather than swallowed.

import { MARKETPLACE_VISIBILITY_DESKTOP_VERSION } from "@mavis/shared/marketplace-visibility";

export function webuiPluginFailureText(input: {
  readonly code: string;
  readonly message: string;
}): string {
  switch (input.code) {
    case "CLIENT_VERSION_REJECTED":
      // The cloud refuses to serve a client it does not accept. The declared
      // version is named because the person can act on it: it is the one the
      // cloud answered for, not the one the runtime happened to send.
      return `市场拒绝了当前声明的客户端版本（本客户端声明的是 ${MARKETPLACE_VISIBILITY_DESKTOP_VERSION}）。请更新 WebUI 或联系维护者同步桌面版本。`;
    case "PLUGIN_AUTH_REQUIRED":
      return "官方账号未登录，无法操作市场插件。";
    case "PLUGIN_AUTH_SYNC_TIMEOUT":
      return "官方账号登录状态同步超时，请稍后再试。";
    case "PLUGIN_NOT_FOUND":
      return "找不到该插件，它可能已经被卸载。";
    case "LOCAL_PLUGIN_INSTALL_UNSUPPORTED":
      return "本地插件不能从市场安装。";
    case "PLUGIN_MUTATION_SOURCE_INVALID":
      return "插件来源与这次操作不符，请刷新后重试。";
    case "PLUGIN_MUTATION_PACKAGE_INVALID":
      return "插件包不可用，无法完成这次操作。";
    default:
      return input.message;
  }
}

/**
 * The reading of a failed plugin request, from the error itself.
 *
 * The runtime's code is read when it carries one; the message is the runtime's
 * own text, which is what an unrecognised refusal shows.
 */
export function webuiPluginFailureTextFrom(error: unknown): string {
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "harness_error";
  const message = error instanceof Error ? error.message : String(error);
  return webuiPluginFailureText({ code, message });
}
