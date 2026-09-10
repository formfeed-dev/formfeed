import type { HelperContext, HelperDefinition, HelperRegistry } from '../types';

/** Registry of helpers shared by all engines (spec 05 §2). */
export class DefaultHelperRegistry implements HelperRegistry {
  private readonly byName = new Map<string, HelperDefinition>();
  private readonly aliasToName = new Map<string, string>();

  constructor(definitions: HelperDefinition[] = []) {
    for (const d of definitions) this.register(d);
  }

  get definitions(): ReadonlyMap<string, HelperDefinition> {
    return this.byName;
  }

  register(definition: HelperDefinition): void {
    this.byName.set(definition.name, definition);
    for (const alias of definition.aliases ?? [])
      this.aliasToName.set(alias, definition.name);
    for (const alias of Object.keys(definition.deprecatedAlias ?? {}))
      this.aliasToName.set(alias, definition.name);
  }

  get(name: string): HelperDefinition | undefined {
    return (
      this.byName.get(name) ?? this.byName.get(this.aliasToName.get(name) ?? '')
    );
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  names(): string[] {
    return [...this.byName.keys(), ...this.aliasToName.keys()];
  }

  /** The preferred name when `name` is a deprecated alias, otherwise undefined. */
  deprecationOf(name: string): string | undefined {
    const def = this.get(name);
    return def?.deprecatedAlias?.[name];
  }

  bind(
    ctx: HelperContext,
  ): Map<string, { fn: (...args: unknown[]) => unknown; html: boolean }> {
    const bound = new Map<
      string,
      { fn: (...args: unknown[]) => unknown; html: boolean }
    >();
    for (const def of this.byName.values()) {
      const entry = {
        fn: (...args: unknown[]) => def.fn(ctx, ...args),
        html: def.html ?? false,
      };
      bound.set(def.name, entry);
      for (const alias of def.aliases ?? []) bound.set(alias, entry);
      for (const alias of Object.keys(def.deprecatedAlias ?? {}))
        bound.set(alias, entry);
    }
    return bound;
  }
}
