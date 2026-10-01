| rows | bins | sel | engine | build ms | update ms | max mean rel err | note |
|---:|---:|---:|---|---:|---:|---:|---|
| 100,000 | 16 | 0.5 | duckdb | 16.0 | 2.26 | 0.0e+0 |  |
| 100,000 | 16 | 0.5 | luma | 40.1 | 6.16 | 2.2e-6 | means differ run to run |
| 100,000 | 16 | 0.5 | luma+readback | 40.1 | 5.59 | 2.2e-6 | means differ run to run |
| 100,000 | 16 | 0.5 | luma count-only | 3.36 | 0.44 | — |  |
| 100,000 | 16 | 0.5 | js | 0.69 | 0.68 | 0.0e+0 | f64 reference |
| 100,000 | 16 | 0.05 | duckdb | 2.17 | 1.31 | 0.0e+0 |  |
| 100,000 | 16 | 0.05 | luma | 5.91 | 0.72 | 5.6e-7 | means differ run to run |
| 100,000 | 16 | 0.05 | luma+readback | 5.91 | 0.68 | 5.6e-7 | means differ run to run |
| 100,000 | 16 | 0.05 | luma count-only | 3.81 | 0.40 | — |  |
| 100,000 | 16 | 0.05 | js | 0.13 | 0.12 | 0.0e+0 | f64 reference |
| 100,000 | 1024 | 0.5 | duckdb | 2.92 | 1.93 | 0.0e+0 |  |
| 100,000 | 1024 | 0.5 | luma | 7.66 | 0.54 | 3.8e-7 | means differ run to run |
| 100,000 | 1024 | 0.5 | luma+readback | 7.66 | 0.57 | 3.8e-7 | means differ run to run |
| 100,000 | 1024 | 0.5 | luma count-only | 3.03 | 0.43 | — |  |
| 100,000 | 1024 | 0.5 | js | 0.63 | 0.61 | 0.0e+0 | f64 reference |
| 100,000 | 1024 | 0.05 | duckdb | 1.85 | 1.14 | 0.0e+0 |  |
| 100,000 | 1024 | 0.05 | luma | 4.76 | 0.48 | 1.7e-7 | means differ run to run |
| 100,000 | 1024 | 0.05 | luma+readback | 4.76 | 0.48 | 1.7e-7 | means differ run to run |
| 100,000 | 1024 | 0.05 | luma count-only | 2.97 | 0.38 | — |  |
| 100,000 | 1024 | 0.05 | js | 0.13 | 0.12 | 0.0e+0 | f64 reference |
| 1,000,000 | 16 | 0.5 | duckdb | 11.6 | 10.7 | 0.0e+0 |  |
| 1,000,000 | 16 | 0.5 | luma | 74.9 | 59.8 | 7.6e-6 | means differ run to run |
| 1,000,000 | 16 | 0.5 | luma+readback | 74.9 | 74.0 | 7.6e-6 | means differ run to run |
| 1,000,000 | 16 | 0.5 | luma count-only | 6.04 | 1.25 | — |  |
| 1,000,000 | 16 | 0.5 | js | 11.5 | 11.4 | 0.0e+0 | f64 reference |
| 1,000,000 | 16 | 0.05 | duckdb | 9.11 | 8.39 | 0.0e+0 |  |
| 1,000,000 | 16 | 0.05 | luma | 12.3 | 5.58 | 1.7e-6 | means differ run to run |
| 1,000,000 | 16 | 0.05 | luma+readback | 12.3 | 5.64 | 1.7e-6 | means differ run to run |
| 1,000,000 | 16 | 0.05 | luma count-only | 5.68 | 1.28 | — |  |
| 1,000,000 | 16 | 0.05 | js | 2.22 | 2.17 | 0.0e+0 | f64 reference |
| 1,000,000 | 1024 | 0.5 | duckdb | 20.4 | 19.0 | 0.0e+0 |  |
| 1,000,000 | 1024 | 0.5 | luma | 11.6 | 2.43 | 1.1e-6 | means differ run to run |
| 1,000,000 | 1024 | 0.5 | luma+readback | 11.6 | 2.67 | 1.1e-6 | means differ run to run |
| 1,000,000 | 1024 | 0.5 | luma count-only | 6.48 | 1.87 | — |  |
| 1,000,000 | 1024 | 0.5 | js | 11.5 | 11.5 | 0.0e+0 | f64 reference |
| 1,000,000 | 1024 | 0.05 | duckdb | 8.78 | 8.34 | 0.0e+0 |  |
| 1,000,000 | 1024 | 0.05 | luma | 10.0 | 2.73 | 3.9e-7 | means differ run to run |
| 1,000,000 | 1024 | 0.05 | luma+readback | 10.0 | 2.55 | 3.9e-7 | means differ run to run |
| 1,000,000 | 1024 | 0.05 | luma count-only | 6.37 | 1.09 | — |  |
| 1,000,000 | 1024 | 0.05 | js | 2.21 | 2.16 | 0.0e+0 | f64 reference |
| 4,000,000 | 16 | 0.5 | duckdb | 65.6 | 55.2 | 0.0e+0 |  |
| 4,000,000 | 16 | 0.5 | luma | 217.6 | 368.1 | 1.2e-5 | means differ run to run |
| 4,000,000 | 16 | 0.5 | luma+readback | 217.6 | 360.1 | 1.2e-5 | means differ run to run |
| 4,000,000 | 16 | 0.5 | luma count-only | 10.2 | 2.78 | — |  |
| 4,000,000 | 16 | 0.5 | js | 46.1 | 45.8 | 0.0e+0 | f64 reference |
| 4,000,000 | 16 | 0.05 | duckdb | 23.8 | 21.3 | 0.0e+0 |  |
| 4,000,000 | 16 | 0.05 | luma | 34.9 | 10.9 | 2.5e-6 | means differ run to run |
| 4,000,000 | 16 | 0.05 | luma+readback | 34.9 | 10.5 | 2.5e-6 | means differ run to run |
| 4,000,000 | 16 | 0.05 | luma count-only | 7.18 | 2.09 | — |  |
| 4,000,000 | 16 | 0.05 | js | 5.71 | 5.53 | 0.0e+0 | f64 reference |
| 4,000,000 | 1024 | 0.5 | duckdb | 41.7 | 37.8 | 0.0e+0 |  |
| 4,000,000 | 1024 | 0.5 | luma | 18.8 | 4.09 | 2.2e-6 | means differ run to run |
| 4,000,000 | 1024 | 0.5 | luma+readback | 18.8 | 3.78 | 2.2e-6 | means differ run to run |
| 4,000,000 | 1024 | 0.5 | luma count-only | 5.94 | 2.01 | — |  |
| 4,000,000 | 1024 | 0.5 | js | 24.1 | 24.3 | 0.0e+0 | f64 reference |
| 4,000,000 | 1024 | 0.05 | duckdb | 15.3 | 14.6 | 0.0e+0 |  |
| 4,000,000 | 1024 | 0.05 | luma | 12.3 | 3.27 | 6.6e-7 | means differ run to run |
| 4,000,000 | 1024 | 0.05 | luma+readback | 12.3 | 3.24 | 6.6e-7 | means differ run to run |
| 4,000,000 | 1024 | 0.05 | luma count-only | 6.04 | 2.21 | — |  |
| 4,000,000 | 1024 | 0.05 | js | 4.56 | 4.55 | 0.0e+0 | f64 reference |
