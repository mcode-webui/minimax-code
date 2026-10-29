/**
 * A stand-in for the mcode-tools CLI, run as a separate process.
 *
 * The real CLI reads the host-only keys from its environment, projects them
 * into the public contract (`MCODE_AUTH_PROVIDER=shared-broker` plus the
 * broker endpoint and capability file), and leases an access token from the
 * host's broker. This fixture performs exactly that sequence, so a test can
 * prove that the environment a host hands to a child process is sufficient to
 * authenticate — without depending on the mcode-tools artifact itself.
 *
 * The result is printed as one JSON line on stdout. A missing or incomplete
 * host environment exits non-zero, which is what the real CLI does when it
 * refuses to run without a host broker.
 */
import { configureWebuiMcodeToolsChildEnvironment } from "../../src/runtime/mcode-tools-environment.js";
import { createNodeAuthLeaseClient } from "@mavis/oauth-lease-protocol";

const projected = configureWebuiMcodeToolsChildEnvironment();
if (!projected) {
  console.error("The host environment carries no mcode-tools keys.");
  process.exit(2);
}

const endpoint = process.env.MCODE_AUTH_BROKER_ENDPOINT;
const capabilityFile = process.env.MCODE_AUTH_BROKER_CAPABILITY_FILE;
if (!endpoint || !capabilityFile) {
  console.error("The projected host environment is incomplete.");
  process.exit(3);
}

const client = createNodeAuthLeaseClient({ endpoint, capabilityFile });
try {
  const lease = await client.getLease(30_000);
  console.log(
    JSON.stringify({
      provider: process.env.MCODE_AUTH_PROVIDER,
      region: process.env.MCODE_REGION,
      configDir: process.env.MCODE_CONFIG_DIR,
      lease,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(4);
} finally {
  client.close();
}
