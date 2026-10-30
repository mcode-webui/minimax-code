// The name this machine gives the gateway and shows in the panel.
//
// The format is `<hostname>-<OS>` (`fectivnfy-GTi-Ubuntu`), so that machines
// sharing a hostname stay distinguishable in the paired-device list — a host and
// a container beside it, the same laptop booted into another system.
//
// One name decides both surfaces: the WebUI panel reads the local value, and the
// phone reads whatever the gateway stored when this device asked for its pairing
// code (`pairing.ts` sends this same string in `device_name`). A name stored by
// an earlier build is only replaced the next time the device pairs.
import { readFileSync } from "node:fs";
import { type as osType, hostname } from "node:os";

let cachedOsName: string | undefined;

/**
 * Marks the name as this client's.
 *
 * A Desktop install and the WebUI can run on the same machine; the suffix keeps
 * them two devices in the paired-device list instead of one name that changes
 * depending on which client asked last.
 */
const WEBUI_DEVICE_SUFFIX = ".WEBUI";

/** `<hostname>-<OS>.WEBUI`, e.g. `fectivnfy-GTi-Ubuntu.WEBUI`. */
export function remoteControlDeviceName(): string {
  return composeDeviceName(hostname(), operatingSystemName());
}

/**
 * The composed name, from its two parts.
 *
 * Split out so the composition rules are testable without pretending this
 * machine runs another system: the caller supplies both halves.
 */
export function composeDeviceName(host: string, osName: string | undefined): string {
  const trimmed = host.trim();
  // `this computer` is the last resort, for a host that has no name at all.
  const base = trimmed.length > 0 ? trimmed : "this computer";
  // A name that already carries the suffix is composed from its stem, so the
  // suffix is never doubled and the OS is still deduplicated.
  const stem = base.toLowerCase().endsWith(WEBUI_DEVICE_SUFFIX.toLowerCase()) &&
      base.length > WEBUI_DEVICE_SUFFIX.length
    ? base.slice(0, -WEBUI_DEVICE_SUFFIX.length)
    : base;
  const os = osName === undefined ? undefined : sanitize(osName);
  // A host that already says which system it is does not get the OS twice.
  const named =
    os === undefined || stem.toLowerCase().endsWith(`-${os.toLowerCase()}`)
      ? stem
      : `${stem}-${os}`;
  return `${named}${WEBUI_DEVICE_SUFFIX}`;
}

/**
 * The operating system as a user would name it: the distribution on Linux
 * (`Ubuntu`, `Fedora`, `Debian`), `macOS`, `Windows`.
 *
 * Cached for the process's lifetime — this is a displayed label, not a measured
 * fact, and the file it reads cannot change meaningfully while the service runs.
 */
export function operatingSystemName(): string | undefined {
  if (cachedOsName === undefined) cachedOsName = resolveOperatingSystemName() ?? "";
  return cachedOsName.length > 0 ? cachedOsName : undefined;
}

function resolveOperatingSystemName(): string | undefined {
  switch (osType()) {
    case "Linux":
      return linuxDistributionName() ?? "Linux";
    case "Darwin":
      return "macOS";
    case "Windows_NT":
      return "Windows";
    default:
      // `type()` is already a product name on the remaining Unixes (FreeBSD,
      // SunOS). It goes through the same filter as everything else so a device
      // name can never carry a space or a quote.
      return sanitize(osType()) ?? undefined;
  }
}

function linuxDistributionName(): string | undefined {
  const fields = readOsRelease();
  return fields === undefined ? undefined : distributionNameFromOsRelease(fields);
}

/**
 * Which name a distribution's release fields yield.
 *
 * `NAME` is the display string (`Ubuntu`, `Fedora Linux`, `Linux Mint`) and its
 * first word is the name people use — except when that word is the generic
 * `Linux`, where `ID` is the only part that identifies the distribution. A
 * distribution that ships neither field gets `Linux` from the caller.
 */
export function distributionNameFromOsRelease(
  fields: ReadonlyMap<string, string>,
): string | undefined {
  const firstWord = fields.get("NAME")?.split(/\s+/)[0];
  const fromName = firstWord === undefined || firstWord.toLowerCase() === "linux"
    ? undefined
    : sanitize(firstWord);
  if (fromName !== undefined) return fromName;
  const id = fields.get("ID");
  return id === undefined ? undefined : titleCase(sanitize(id));
}

function readOsRelease(): Map<string, string> | undefined {
  let text: string | undefined;
  for (const file of ["/etc/os-release", "/usr/lib/os-release"]) {
    try {
      text = readFileSync(file, "utf8");
      break;
    } catch {
      continue;
    }
  }
  if (text === undefined) return undefined;
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (match === null) continue;
    fields.set(match[1] as string, (match[2] as string).replace(/^"(.*)"$/u, "$1").trim());
  }
  return fields;
}

/** Keep only what a device name may carry; everything else becomes a separator. */
function sanitize(value: string): string | undefined {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

function titleCase(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
