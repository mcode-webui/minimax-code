// The composer-facing plugin catalogue, published.
//
// Two other businesses need to type-check the catalogue: the composer lists
// installed plugins and runtime skills through it, and the composer's `+` menu
// receives the installed-plugin rows. Neither business owns the concept, so
// neither may re-derive the shape, and the types live here where the plugins
// business can keep changing them. The creator and the runtime cache stay
// private to this business; a peer reads the catalogue, it does not build one.
//
// The `.public` suffix changes nothing about what the module is — the classifier
// strips it, so this is still `application/`, still the plugins business's
// catalogue shape.

/** One installed plugin, as the composer's `@` menu needs it. */
export interface WebuiComposerPluginSummary {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
}

/**
 * The read model the composer mounts: the installed-plugin list the `@` menu
 * offers, the runtime skills the slash palette and the skills submenu render
 * from, and the invalidate hooks the assembly calls off a plugin write.
 */
export interface WebuiComposerPluginCatalogue {
  /** False when the runtime exposes no plugin management at all. */
  readonly available: boolean;
  /**
   * The installed plugins the `@` menu offers. Cached per key, so reopening the
   * menu does not re-ask the runtime for the same answer.
   */
  readonly installedPlugins: () => Promise<readonly WebuiComposerPluginSummary[]>;
  /**
   * The runtime skills the slash palette and the skills submenu render from.
   * Keyed by agent, because the runtime answers per agent.
   */
  readonly runtimeSkills: (
    agentName?: string,
  ) => Promise<readonly WebuiComposerSkillSummary[]>;
  /**
   * The installed-plugin read is stale. Every slot goes, because a plugin write
   * can add, remove, rename or reconfigure any of them.
   */
  readonly invalidatePlugins: () => void;
  /**
   * One agent's skill read is stale. Slots for other agents survive: a plugin
   * write does not answer a different agent's runtime, so re-reading them would
   * cost a round trip to learn nothing.
   */
  readonly invalidateSkills: (agentName?: string) => void;
}

/** One runtime skill, as the slash palette and the skills submenu need it. */
export interface WebuiComposerSkillSummary {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
}