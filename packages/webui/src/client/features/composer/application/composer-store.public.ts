// The composer's published purge command.
//
// Archiving or deleting a session clears that session's composer draft, so the
// sessions workflow calls this command through the composer store's owner. The
// sessions business reads the composer's purge as a type, not as the whole
// store interface — every other store method is private composer state — so
// the published shape is the narrow command only.
//
// The `.public` suffix is a publication marker; the command itself is unchanged.

/** The composer's purge command: drop one slot's draft and history. */
export type WebuiComposerPurgeSlot = (key: string) => void;