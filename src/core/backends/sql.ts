/**
 * IR -> DuckDB SQL.
 *
 * Value parameters become **numbered** placeholders (`$1`, `$2`, ...) so the whole stage can
 * be a prepared statement: changing a slider rebinds and re-executes without DuckDB
 * re-planning the query.
 *
 * Numbered rather than positional `?` for a specific reason. Several op templates repeat an
 * argument — `fit` uses its domain-low and range-low twice, `lerp` uses its first argument
 * twice — and each repetition duplicates whatever text that argument produced. With `?` a
 * repeated parameter emitted two placeholders but contributed one bind, so a graph using
 * `fit` with a parameterized domain generated 7 placeholders for 6 binds and DuckDB rejected
 * the statement. Numbering makes repetition free: `$3` can appear five times and still means
 * bind three.
 *
 * A consequence: all emissions that end up in **one statement** must share a `SqlParams`, or
 * their numbering collides. The planner creates one per statement and passes it in.
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
  /** Distinct parameter names, in bind order: index 0 is `$1`. */
  params: string[];
}

/**
 * Placeholder numbering for one SQL statement.
 *
 * Share a single instance across every expression that lands in the same statement — the
 * SELECT list and the WHERE clause of one query — and use a fresh one per statement.
 */
export class SqlParams {
  private index = new Map<string, number>();
  /** Parameter names in bind order; `order[0]` binds `$1`. */
  readonly order: string[] = [];

  /** The placeholder text for a parameter, assigning it a number on first sight. */
  placeholder(name: string): string {
    let at = this.index.get(name);
    if (at === undefined) {
      this.order.push(name);
      at = this.order.length;
      this.index.set(name, at);
    }
    return `$${at}`;
  }
}

interface Ctx {
  params: SqlParams;
}

function emit(e: Expr, ctx: Ctx): string {
  switch (e.kind) {
    case 'num':
      return formatNumber(e.value);

    case 'col':
      return quoteIdent(e.name);

    case 'param':
      // Same name -> same number, so a template that repeats an argument is harmless.
      return ctx.params.placeholder(e.name);

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

/**
 * Compile one scalar expression.
 *
 * Pass `params` when this expression shares a statement with others, so the numbering is
 * consistent across the whole query.
 */
export function toSql(e: Expr, params: SqlParams = new SqlParams()): SqlEmit {
  const code = emit(e, { params });
  return { code, params: params.order };
}

/**
 * Compile a possibly-vector expression into one SELECT item per component,
 * sharing a single parameter bind order across them.
 */
export function toSqlColumns(
  e: Expr,
  baseAlias: string,
  params: SqlParams = new SqlParams(),
): { items: string[]; params: string[] } {
  const ctx: Ctx = { params };
  if (e.kind === 'vec') {
    const items = e.components.map((c, i) => `${emit(c, ctx)} AS ${quoteIdent(`${baseAlias}_${i}`)}`);
    return { items, params: params.order };
  }
  return { items: [`${emit(e, ctx)} AS ${quoteIdent(baseAlias)}`], params: params.order };
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
