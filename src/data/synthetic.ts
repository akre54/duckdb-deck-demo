/**
 * Synthetic source, generated inside DuckDB rather than in JS.
 *
 * The column types are chosen deliberately to exercise every upload tier, because a
 * demo where everything happens to be a clean single-batch Float32 column proves
 * nothing about the hard cases:
 *
 *   elevation, hour  FLOAT, no nulls  -> 'arrow' tier, zero-copy
 *   lng, lat, pop    DOUBLE           -> 'cast' tier, f64 has to be narrowed
 *   speed            FLOAT, ~2% NULL  -> 'cast' tier, validity bitmap consumed
 *   id, cluster      INTEGER          -> 'cast' tier
 */

export const SOURCE_TABLE = 'src';

export function syntheticSql(rows: number, seed = 0.42): string {
  const clusters = 9;
  // No `SET threads`: the mvp/eh bundles are compiled without threads and reject it.
  return `
SELECT setseed(${seed});
CREATE OR REPLACE TABLE ${SOURCE_TABLE} AS
WITH base AS (
  SELECT
    i,
    (i % ${clusters})::INTEGER AS cluster,
    random() AS u1, random() AS u2, random() AS u3,
    random() AS u4, random() AS u5, random() AS u6
  FROM range(0, ${rows}) t(i)
), g AS (
  SELECT
    i, cluster, u3, u4, u5, u6,
    -- Box-Muller: two independent normals from two uniforms.
    sqrt(-2.0 * ln(u1 + 1e-12)) * cos(6.283185307179586 * u2) AS n1,
    sqrt(-2.0 * ln(u1 + 1e-12)) * sin(6.283185307179586 * u2) AS n2
  FROM base
)
SELECT
  i::INTEGER AS id,
  cluster,
  -- Mercator blows up near the poles, so keep the clusters inside usable latitudes.
  least(greatest(cos(cluster * 0.6981317) * 96.0 + n1 * (5.0 + cluster * 0.8), -179.0), 179.0)::DOUBLE AS lng,
  least(greatest(sin(cluster * 0.6981317) * 40.0 + n2 * (3.5 + cluster * 0.4), -80.0), 80.0)::DOUBLE AS lat,
  (u3 * u3 * 900.0)::FLOAT AS elevation,
  (CASE WHEN u4 < 0.02 THEN NULL ELSE u4 * 120.0 END)::FLOAT AS speed,
  pow(10.0, 1.0 + u5 * 5.0)::DOUBLE AS pop,
  (u6 * 24.0)::FLOAT AS hour
FROM g;
`;
}
