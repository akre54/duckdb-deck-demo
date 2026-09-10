/**
 * IR -> DuckDB SQL.
 *
 * Value parameters become positional `?` placeholders so the whole stage can be a
 * prepared statement: changing a slider rebinds and re-executes without DuckDB
 * re-planning the query. The returned `params` array is the bind order.
 *
 * SQL columns are scalars, so a vector-valued expression can only appear at the top
 * level, where it is split into one column per component (`P_0`, `P_1`, `P_2`).
 * `enginesFor()` in expr.ts already refuses swizzles for SQL, so nested vector math
 * never reaches here.
 */

import { type Expr, FUNCTIONS, SQL_BINARY, ExprError } from '../expr.js';

export interface SqlEmit {
  /** SQL expression text. */
  code: string;
  /** Parameter names in `?` bind order. */
  params: string[];
}

interface Ctx {
  params: string[];
}

function emit(e: Expr, ctx: Ctx): string {
  switch (e.kind) {
    case 'num':
      return formatNumber(e.value);

    case 'col':
      return quoteIdent(e.name);

    case 'param':
      ctx.params.push(e.name);
      return '?';

    case 'unary':
      return e.op === '!'
        ? `(NOT ${emit(e.operand, ctx)})`
        : `(-${emit(e.operand, ctx)})`;

    case 'binary': {
      const op = SQL_BINARY[e.op] ?? e.op;
      return `(${emit(e.left, ctx)} ${op} ${emit(e.right, ctx)})`;
    }

    case 'cond':
      return `(CASE WHEN ${emit(e.test, ctx)} THEN ${emit(e.then, ctx)} ELSE ${emit(e.else, ctx)} END)`;

    case 'call': {
      const spec = FUNCTIONS[e.fn];
      if (!spec.sql) {
        throw new ExprError(`${e.fn}() has no SQL equivalent; this node must run on the GPU`);
      }
      const args = e.args.map((a) => emit(a, ctx));
      return typeof spec.sql === 'function' ? spec.sql(args) : `${spec.sql}(${args.join(', ')})`;
    }

    case 'vec':
      throw new ExprError(
        'Vector expressions cannot be nested in SQL. Split into per-component columns at the top level.',
      );

    case 'swizzle':
      throw new ExprError('Swizzles have no SQL equivalent; this node must run on the GPU');
  }
}

/** Compile one scalar expression. */
export function toSql(e: Expr): SqlEmit {
  const ctx: Ctx = { params: [] };
  const code = emit(e, ctx);
  return { code, params: ctx.params };
}

/**
 * Compile a possibly-vector expression into one SELECT item per component,
 * sharing a single parameter bind order across them.
 */
export function toSqlColumns(e: Expr, baseAlias: string): { items: string[]; params: string[] } {
  const ctx: Ctx = { params: [] };
  if (e.kind === 'vec') {
    const items = e.components.map((c, i) => `${emit(c, ctx)} AS ${quoteIdent(`${baseAlias}_${i}`)}`);
    return { items, params: ctx.params };
  }
  return { items: [`${emit(e, ctx)} AS ${quoteIdent(baseAlias)}`], params: ctx.params };
}

// ---------------------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * DuckDB infers INTEGER for bare integer literals, which makes `1 / 2` return 0.
 * Force a decimal point so graph arithmetic behaves the same in both backends.
 */
function formatNumber(v: number): string {
  if (!Number.isFinite(v)) throw new ExprError(`Cannot emit non-finite literal ${v} to SQL`);
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

export { quoteIdent };
