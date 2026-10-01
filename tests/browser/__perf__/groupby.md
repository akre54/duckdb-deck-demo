| rows | bins | sel | engine | build ms | update ms | max mean rel err | note |
|---:|---:|---:|---|---:|---:|---:|---|
| 100,000 | 16 | 0.5 | duckdb | 41.8 | 6.52 | 0.0e+0 |  |
| 100,000 | 16 | 0.5 | luma | 62.4 | 6.64 | 2.4e-6 | means differ run to run |
| 100,000 | 16 | 0.5 | luma+readback | 62.4 | 6.24 | 2.4e-6 | means differ run to run |
| 100,000 | 16 | 0.5 | luma count-only | 6.29 | 0.82 | — |  |
| 100,000 | 16 | 0.5 | luma (subgroups) | 393.7 | 2.10 | 2.0e-6 | means differ run to run |
| 100,000 | 16 | 0.5 | luma+readback (subgroups) | 393.7 | 2.08 | 2.0e-6 | means differ run to run |
| 100,000 | 16 | 0.5 | luma count-only (subgroups) | 7.90 | 0.80 | — |  |
| 100,000 | 16 | 0.5 | js | 1.40 | 1.00 | 0.0e+0 | f64 reference |
| 100,000 | 16 | 0.05 | duckdb | 9.91 | 5.28 | 0.0e+0 |  |
| 100,000 | 16 | 0.05 | luma | 8.29 | 2.27 | 5.0e-7 | means differ run to run |
| 100,000 | 16 | 0.05 | luma+readback | 8.29 | 1.45 | 5.0e-7 | means differ run to run |
| 100,000 | 16 | 0.05 | luma count-only | 5.51 | 0.95 | — |  |
| 100,000 | 16 | 0.05 | luma (subgroups) | 12.6 | 1.48 | 4.7e-7 | means differ run to run |
| 100,000 | 16 | 0.05 | luma+readback (subgroups) | 12.6 | 1.26 | 4.7e-7 | means differ run to run |
| 100,000 | 16 | 0.05 | luma count-only (subgroups) | 7.06 | 0.98 | — |  |
| 100,000 | 16 | 0.05 | js | 0.22 | 0.20 | 0.0e+0 | f64 reference |
| 100,000 | 1024 | 0.5 | duckdb | 8.43 | 5.58 | 0.0e+0 |  |
| 100,000 | 1024 | 0.5 | luma | 13.3 | 1.03 | 4.7e-7 | means differ run to run |
| 100,000 | 1024 | 0.5 | luma+readback | 13.3 | 1.30 | 4.7e-7 | means differ run to run |
| 100,000 | 1024 | 0.5 | luma count-only | 5.40 | 1.08 | — |  |
| 100,000 | 1024 | 0.5 | luma (subgroups) | 13.9 | 1.28 | 3.6e-7 | means differ run to run |
| 100,000 | 1024 | 0.5 | luma+readback (subgroups) | 13.9 | 1.34 | 3.6e-7 | means differ run to run |
| 100,000 | 1024 | 0.5 | luma count-only (subgroups) | 6.03 | 0.95 | — |  |
| 100,000 | 1024 | 0.5 | js | 1.13 | 1.10 | 0.0e+0 | f64 reference |
| 100,000 | 1024 | 0.05 | duckdb | 6.31 | 4.65 | 0.0e+0 |  |
| 100,000 | 1024 | 0.05 | luma | 8.26 | 1.31 | 1.7e-7 | means differ run to run |
| 100,000 | 1024 | 0.05 | luma+readback | 8.26 | 1.05 | 1.7e-7 | means differ run to run |
| 100,000 | 1024 | 0.05 | luma count-only | 6.37 | 0.92 | — |  |
| 100,000 | 1024 | 0.05 | luma (subgroups) | 7.79 | 1.07 | 1.7e-7 | means differ run to run |
| 100,000 | 1024 | 0.05 | luma+readback (subgroups) | 7.79 | 1.05 | 1.7e-7 | means differ run to run |
| 100,000 | 1024 | 0.05 | luma count-only (subgroups) | 5.90 | 0.79 | — |  |
| 100,000 | 1024 | 0.05 | js | 0.25 | 0.21 | 0.0e+0 | f64 reference |
| 1,000,000 | 16 | 0.5 | duckdb | 30.0 | 28.1 | 0.0e+0 |  |
| 1,000,000 | 16 | 0.5 | luma | 77.7 | 61.2 | 5.6e-6 | means differ run to run |
| 1,000,000 | 16 | 0.5 | luma+readback | 77.7 | 120.4 | 5.6e-6 | means differ run to run |
| 1,000,000 | 16 | 0.5 | luma count-only | 9.19 | 1.68 | — |  |
| 1,000,000 | 16 | 0.5 | luma (subgroups) | 254.6 | 25.2 | 3.2e-6 | means differ run to run |
| 1,000,000 | 16 | 0.5 | luma+readback (subgroups) | 254.6 | 24.6 | 3.2e-6 | means differ run to run |
| 1,000,000 | 16 | 0.5 | luma count-only (subgroups) | 6.97 | 2.59 | — |  |
| 1,000,000 | 16 | 0.5 | js | 11.6 | 11.5 | 0.0e+0 | f64 reference |
| 1,000,000 | 16 | 0.05 | duckdb | 16.8 | 13.1 | 0.0e+0 |  |
| 1,000,000 | 16 | 0.05 | luma | 12.9 | 5.28 | 1.7e-6 | means differ run to run |
| 1,000,000 | 16 | 0.05 | luma+readback | 12.9 | 5.42 | 1.7e-6 | means differ run to run |
| 1,000,000 | 16 | 0.05 | luma count-only | 6.22 | 1.24 | — |  |
| 1,000,000 | 16 | 0.05 | luma (subgroups) | 13.0 | 4.43 | 2.1e-6 | means differ run to run |
| 1,000,000 | 16 | 0.05 | luma+readback (subgroups) | 13.0 | 4.34 | 2.1e-6 | means differ run to run |
| 1,000,000 | 16 | 0.05 | luma count-only (subgroups) | 6.90 | 1.34 | — |  |
| 1,000,000 | 16 | 0.05 | js | 2.20 | 2.11 | 0.0e+0 | f64 reference |
| 1,000,000 | 1024 | 0.5 | duckdb | 28.8 | 23.9 | 0.0e+0 |  |
| 1,000,000 | 1024 | 0.5 | luma | 13.1 | 2.44 | 1.2e-6 | means differ run to run |
| 1,000,000 | 1024 | 0.5 | luma+readback | 13.1 | 2.31 | 1.2e-6 | means differ run to run |
| 1,000,000 | 1024 | 0.5 | luma count-only | 6.99 | 1.25 | — |  |
| 1,000,000 | 1024 | 0.5 | luma (subgroups) | 14.0 | 2.03 | 1.2e-6 | means differ run to run |
| 1,000,000 | 1024 | 0.5 | luma+readback (subgroups) | 14.0 | 2.03 | 1.2e-6 | means differ run to run |
| 1,000,000 | 1024 | 0.5 | luma count-only (subgroups) | 6.57 | 1.32 | — |  |
| 1,000,000 | 1024 | 0.5 | js | 11.5 | 11.4 | 0.0e+0 | f64 reference |
| 1,000,000 | 1024 | 0.05 | duckdb | 10.0 | 12.2 | 0.0e+0 |  |
| 1,000,000 | 1024 | 0.05 | luma | 9.02 | 1.61 | 3.9e-7 | means differ run to run |
| 1,000,000 | 1024 | 0.05 | luma+readback | 9.02 | 1.61 | 3.9e-7 | means differ run to run |
| 1,000,000 | 1024 | 0.05 | luma count-only | 6.13 | 1.09 | — |  |
| 1,000,000 | 1024 | 0.05 | luma (subgroups) | 11.0 | 1.55 | 3.9e-7 | means differ run to run |
| 1,000,000 | 1024 | 0.05 | luma+readback (subgroups) | 11.0 | 1.41 | 3.9e-7 | means differ run to run |
| 1,000,000 | 1024 | 0.05 | luma count-only (subgroups) | 6.74 | 1.11 | — |  |
| 1,000,000 | 1024 | 0.05 | js | 2.13 | 2.13 | 0.0e+0 | f64 reference |
| 4,000,000 | 16 | 0.5 | duckdb | 95.7 | 97.1 | 0.0e+0 |  |
| 4,000,000 | 16 | 0.5 | luma | 228.0 | 366.0 | 1.0e-5 | means differ run to run |
| 4,000,000 | 16 | 0.5 | luma+readback | 228.0 | 328.8 | 1.0e-5 | means differ run to run |
| 4,000,000 | 16 | 0.5 | luma count-only | 10.5 | 2.90 | — |  |
| 4,000,000 | 16 | 0.5 | luma (subgroups) | 295.4 | 54.9 | 9.6e-6 | means differ run to run |
| 4,000,000 | 16 | 0.5 | luma+readback (subgroups) | 295.4 | 60.6 | 9.6e-6 | means differ run to run |
| 4,000,000 | 16 | 0.5 | luma count-only (subgroups) | 12.9 | 4.19 | — |  |
| 4,000,000 | 16 | 0.5 | js | 47.1 | 47.4 | 0.0e+0 | f64 reference |
| 4,000,000 | 16 | 0.05 | duckdb | 52.2 | 58.9 | 0.0e+0 |  |
| 4,000,000 | 16 | 0.05 | luma | 33.7 | 11.5 | 2.8e-6 | means differ run to run |
| 4,000,000 | 16 | 0.05 | luma+readback | 33.7 | 12.8 | 2.8e-6 | means differ run to run |
| 4,000,000 | 16 | 0.05 | luma count-only | 9.18 | 2.47 | — |  |
| 4,000,000 | 16 | 0.05 | luma (subgroups) | 22.4 | 10.4 | 2.8e-6 | means differ run to run |
| 4,000,000 | 16 | 0.05 | luma+readback (subgroups) | 22.4 | 11.9 | 2.8e-6 | means differ run to run |
| 4,000,000 | 16 | 0.05 | luma count-only (subgroups) | 12.0 | 2.45 | — |  |
| 4,000,000 | 16 | 0.05 | js | 8.89 | 8.99 | 0.0e+0 | f64 reference |
| 4,000,000 | 1024 | 0.5 | duckdb | 101.2 | 102.1 | 0.0e+0 |  |
| 4,000,000 | 1024 | 0.5 | luma | 26.3 | 4.40 | 2.1e-6 | means differ run to run |
| 4,000,000 | 1024 | 0.5 | luma+readback | 26.3 | 4.38 | 2.1e-6 | means differ run to run |
| 4,000,000 | 1024 | 0.5 | luma count-only | 9.39 | 2.54 | — |  |
| 4,000,000 | 1024 | 0.5 | luma (subgroups) | 16.5 | 4.19 | 2.0e-6 | means differ run to run |
| 4,000,000 | 1024 | 0.5 | luma+readback (subgroups) | 16.5 | 4.38 | 2.0e-6 | means differ run to run |
| 4,000,000 | 1024 | 0.5 | luma count-only (subgroups) | 11.4 | 2.47 | — |  |
| 4,000,000 | 1024 | 0.5 | js | 46.0 | 46.7 | 0.0e+0 | f64 reference |
| 4,000,000 | 1024 | 0.05 | duckdb | 53.5 | 46.0 | 0.0e+0 |  |
| 4,000,000 | 1024 | 0.05 | luma | 12.4 | 3.51 | 6.6e-7 | means differ run to run |
| 4,000,000 | 1024 | 0.05 | luma+readback | 12.4 | 3.89 | 6.6e-7 | means differ run to run |
| 4,000,000 | 1024 | 0.05 | luma count-only | 10.7 | 2.64 | — |  |
| 4,000,000 | 1024 | 0.05 | luma (subgroups) | 14.5 | 3.96 | 6.6e-7 | means differ run to run |
| 4,000,000 | 1024 | 0.05 | luma+readback (subgroups) | 14.5 | 3.89 | 6.6e-7 | means differ run to run |
| 4,000,000 | 1024 | 0.05 | luma count-only (subgroups) | 11.9 | 2.59 | — |  |
| 4,000,000 | 1024 | 0.05 | js | 8.73 | 9.15 | 0.0e+0 | f64 reference |
