/**
 * The desktop version this product line declares to the cloud marketplace.
 *
 * The cloud filters the marketplace by the desktop version a client declares
 * (`desktop_version`), so a client that is not the desktop declares one to
 * see the entries a desktop would see. This is a copy of the desktop client's
 * current release version, and the two repositories share no release pipeline:
 * changing it needs a sync with the desktop release and a coordinated rollout
 * with the cloud, the same kind of wire constant as the plugin system's
 * signature salt.
 *
 * The runtime never reads this. The host declares it, because the runtime
 * does not know which client it runs for and must not answer for one.
 */
export const MARKETPLACE_VISIBILITY_DESKTOP_VERSION = '3.1.3';
