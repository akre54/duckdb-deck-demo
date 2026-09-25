/**
 * The program runtime: executes a `compileProgram` plan against DuckDB and hands each layer's
 * attributes to deck.gl. GPU-free — the target is deck's WebGL2 path — so it needs a SQL
 * engine and nothing else.
 */
export {
  MaterializingCatalog, type CatalogCounters, type CatalogOptions,
} from './catalog.js';
