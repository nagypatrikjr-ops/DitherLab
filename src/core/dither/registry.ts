import type { AnyProcessor, ParamBag, ParamSchema, ParamsOf, Processor } from '../types';

const registry = new Map<string, AnyProcessor>();

/**
 * Plugin-style registration. Algorithms are looked up by id at render time,
 * so adding one never means touching a switch statement.
 */
export function register<S extends ParamSchema>(processor: Processor<S>): void {
  if (registry.has(processor.id)) {
    throw new Error(`Duplicate processor id: ${processor.id}`);
  }
  registry.set(processor.id, {
    id: processor.id,
    name: processor.name,
    category: processor.category,
    params: processor.params,
    supportsColor: processor.supportsColor,
    vectorizable: processor.vectorizable,
    apply: (input, params, ctx) =>
      processor.apply(input, params as unknown as ParamsOf<S>, ctx),
  });
}

export function getProcessor(id: string): AnyProcessor | null {
  return registry.get(id) ?? null;
}

export function requireProcessor(id: string): AnyProcessor {
  const p = registry.get(id);
  if (!p) throw new Error(`Unknown processor: ${id}`);
  return p;
}

export function allProcessors(): AnyProcessor[] {
  return [...registry.values()];
}

export function processorsByCategory(category: string): AnyProcessor[] {
  return [...registry.values()].filter((p) => p.category === category);
}

/** Fill in every default from a schema; used when a layer is created. */
export function defaultParams(schema: ParamSchema): ParamBag {
  const out: Record<string, ParamBag[string]> = {};
  for (const key of Object.keys(schema)) {
    const spec = schema[key];
    out[key] = spec.kind === 'matrix' ? [...spec.default] : spec.default;
  }
  return out;
}

/**
 * Merge stored params over the schema defaults, dropping unknown keys and
 * values whose type no longer matches. Keeps old presets loadable.
 */
export function coerceParams(schema: ParamSchema, stored: ParamBag): ParamBag {
  const out: Record<string, ParamBag[string]> = {};
  for (const key of Object.keys(schema)) {
    const spec = schema[key];
    const v = stored[key];
    switch (spec.kind) {
      case 'float':
      case 'int':
      case 'angle':
      case 'seed':
        out[key] = typeof v === 'number' && Number.isFinite(v) ? v : spec.default;
        break;
      case 'bool':
        out[key] = typeof v === 'boolean' ? v : spec.default;
        break;
      case 'enum':
        out[key] =
          typeof v === 'string' && spec.options.some((o) => o.value === v) ? v : spec.default;
        break;
      case 'text':
        out[key] = typeof v === 'string' ? v : spec.default;
        break;
      case 'color':
        out[key] =
          typeof v === 'object' && v !== null && 'r' in v ? v : spec.default;
        break;
      case 'matrix':
        out[key] = Array.isArray(v) ? [...(v as readonly number[])] : [...spec.default];
        break;
    }
  }
  return out;
}

/** Test-only. */
export function _clearRegistry(): void {
  registry.clear();
}
