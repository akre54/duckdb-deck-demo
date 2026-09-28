| rows | sel | engine | drawn | build ms | update ms | frame ms | filter ms | note |
|---:|---:|---|---:|---:|---:|---:|---:|---|
| 100,000 | 0.9 | sql | 89,980 | 20.4 | 5.95 | 0.35 | — | filter in sql, route=requery |
| 100,000 | 0.9 | gpu-mask | 100,000 | 2.63 | 0.57 | 0.25 | — | filter in gpu, route=uniform, mask |
| 100,000 | 0.9 | cost | 100,000 | 2.43 | 0.56 | 0.27 | — | filter in gpu, route=uniform, mask |
| 100,000 | 0.9 | cost+luma | 100,000 | 2.47 | 0.45 | 0.19 | — | filter in gpu, route=uniform, mask |
| 100,000 | 0.9 | luma | 89,980 | 10.1 | 0.86 | 0.68 | 0.52 | 1 batch |
| 100,000 | 0.9 | luma-batched | — | 71.7 | — | — | 3.02 | 49 batches |
| 100,000 | 0.9 | js | 89,980 | 2.61 | 1.18 | 0.16 | 0.67 |  |
| 100,000 | 0.5 | sql | 50,254 | 3.21 | 3.75 | 0.12 | — | filter in sql, route=requery |
| 100,000 | 0.5 | gpu-mask | 100,000 | 2.37 | 0.46 | 0.18 | — | filter in gpu, route=uniform, mask |
| 100,000 | 0.5 | cost | 100,000 | 2.05 | 0.49 | 0.20 | — | filter in gpu, route=uniform, mask |
| 100,000 | 0.5 | cost+luma | 50,254 | 3.87 | 0.64 | 0.10 | — | filter in gpu, route=compact, compacted |
| 100,000 | 0.5 | luma | 50,254 | 4.28 | 0.57 | 0.12 | 0.41 | 1 batch |
| 100,000 | 0.5 | luma-batched | — | 45.8 | — | — | 3.02 | 49 batches |
| 100,000 | 0.5 | js | 50,254 | 3.37 | 1.21 | 0.12 | 0.76 |  |
| 100,000 | 0.05 | sql | 5,027 | 1.89 | 2.17 | 0.06 | — | filter in sql, route=requery |
| 100,000 | 0.05 | gpu-mask | 100,000 | 2.31 | 0.71 | 0.37 | — | filter in gpu, route=uniform, mask |
| 100,000 | 0.05 | cost | 100,000 | 2.06 | 0.64 | 0.32 | — | filter in gpu, route=uniform, mask |
| 100,000 | 0.05 | cost+luma | 5,027 | 3.66 | 0.43 | 0.07 | — | filter in gpu, route=compact, compacted |
| 100,000 | 0.05 | luma | 5,027 | 3.53 | 0.49 | 0.06 | 0.40 | 1 batch |
| 100,000 | 0.05 | luma-batched | — | 45.2 | — | — | 4.59 | 49 batches |
| 100,000 | 0.05 | js | 5,027 | 1.76 | 0.40 | 0.05 | 0.14 |  |
| 1,000,000 | 0.9 | sql | 899,979 | 22.0 | 25.3 | 1.51 | — | filter in sql, route=requery |
| 1,000,000 | 0.9 | gpu-mask | 1,000,000 | 13.2 | 2.18 | 1.47 | — | filter in gpu, route=uniform, mask |
| 1,000,000 | 0.9 | cost | 1,000,000 | 13.1 | 2.20 | 1.45 | — | filter in gpu, route=uniform, mask |
| 1,000,000 | 0.9 | cost+luma | 899,979 | 18.7 | 2.33 | 1.38 | — | filter in gpu, route=compact, compacted |
| 1,000,000 | 0.9 | luma | 899,979 | 10.8 | 2.32 | 1.39 | 0.63 | 1 batch |
| 1,000,000 | 0.9 | luma-batched | — | 545.4 | — | — | 25.0 | 489 batches |
| 1,000,000 | 0.9 | js | 899,979 | 13.7 | 8.32 | 1.43 | 3.84 |  |
| 1,000,000 | 0.5 | sql | 500,527 | 17.4 | 20.1 | 0.72 | — | filter in sql, route=requery |
| 1,000,000 | 0.5 | gpu-mask | 1,000,000 | 13.3 | 2.05 | 1.44 | — | filter in gpu, route=uniform, mask |
| 1,000,000 | 0.5 | cost | 1,000,000 | 12.1 | 2.04 | 1.43 | — | filter in gpu, route=uniform, mask |
| 1,000,000 | 0.5 | cost+luma | 500,527 | 13.9 | 1.58 | 0.76 | — | filter in gpu, route=compact, compacted |
| 1,000,000 | 0.5 | luma | 500,527 | 9.00 | 1.56 | 0.74 | 0.60 | 1 batch |
| 1,000,000 | 0.5 | luma-batched | — | 437.9 | — | — | 25.2 | 489 batches |
| 1,000,000 | 0.5 | js | 500,527 | 13.7 | 9.03 | 0.85 | 5.93 |  |
| 1,000,000 | 0.05 | sql | 50,026 | 8.66 | 8.99 | 0.10 | — | filter in sql, route=requery |
| 1,000,000 | 0.05 | gpu-mask | 1,000,000 | 12.2 | 1.89 | 1.39 | — | filter in gpu, route=uniform, mask |
| 1,000,000 | 0.05 | cost | 50,026 | 7.34 | 7.79 | 0.10 | — | filter in sql, route=requery |
| 1,000,000 | 0.05 | cost+luma | 50,026 | 15.6 | 0.79 | 0.09 | — | filter in gpu, route=compact, compacted |
| 1,000,000 | 0.05 | luma | 50,026 | 8.29 | 0.70 | 0.11 | 0.60 | 1 batch |
| 1,000,000 | 0.05 | luma-batched | — | 423.0 | — | — | 24.3 | 489 batches |
| 1,000,000 | 0.05 | js | 50,026 | 6.93 | 1.80 | 0.13 | 1.28 |  |
| 4,000,000 | 0.9 | sql | 3,600,904 | 72.3 | 85.6 | 5.48 | — | filter in sql, route=requery |
| 4,000,000 | 0.9 | gpu-mask | 4,000,000 | 51.1 | 8.60 | 5.73 | — | filter in gpu, route=uniform, mask |
| 4,000,000 | 0.9 | cost | 4,000,000 | 46.8 | 8.15 | 6.01 | — | filter in gpu, route=uniform, mask |
| 4,000,000 | 0.9 | cost+luma | 3,600,904 | 46.2 | 8.47 | 5.68 | — | filter in gpu, route=compact, compacted |
| 4,000,000 | 0.9 | luma | 3,600,904 | 38.9 | 8.22 | 5.84 | 1.64 | 1 batch |
| 4,000,000 | 0.9 | luma-batched | — | 2478.3 | — | — | 90.1 | 1954 batches |
| 4,000,000 | 0.9 | js | 3,600,904 | 75.8 | 27.7 | 5.46 | 15.3 |  |
| 4,000,000 | 0.5 | sql | 2,002,004 | 67.6 | 76.6 | 3.12 | — | filter in sql, route=requery |
| 4,000,000 | 0.5 | gpu-mask | 4,000,000 | 44.9 | 7.17 | 5.69 | — | filter in gpu, route=uniform, mask |
| 4,000,000 | 0.5 | cost | 4,000,000 | 44.6 | 7.15 | 5.79 | — | filter in gpu, route=uniform, mask |
| 4,000,000 | 0.5 | cost+luma | 2,002,004 | 47.7 | 5.45 | 3.24 | — | filter in gpu, route=compact, compacted |
| 4,000,000 | 0.5 | luma | 2,002,004 | 25.2 | 5.11 | 3.24 | 1.66 | 1 batch |
| 4,000,000 | 0.5 | luma-batched | — | 2258.0 | — | — | 89.1 | 1954 batches |
| 4,000,000 | 0.5 | js | 2,002,004 | 89.7 | 32.3 | 2.98 | 23.8 |  |
| 4,000,000 | 0.05 | sql | 200,312 | 31.5 | 32.1 | 0.32 | — | filter in sql, route=requery |
| 4,000,000 | 0.05 | gpu-mask | 4,000,000 | 48.1 | 6.41 | 5.47 | — | filter in gpu, route=uniform, mask |
| 4,000,000 | 0.05 | cost | 200,312 | 26.3 | 28.8 | 0.32 | — | filter in sql, route=requery |
| 4,000,000 | 0.05 | cost+luma | 200,312 | 48.8 | 2.27 | 0.32 | — | filter in gpu, route=compact, compacted |
| 4,000,000 | 0.05 | luma | 200,312 | 33.7 | 2.04 | 0.31 | 1.91 | 1 batch |
| 4,000,000 | 0.05 | luma-batched | — | 2216.5 | — | — | 90.6 | 1954 batches |
| 4,000,000 | 0.05 | js | 200,312 | 38.9 | 6.68 | 0.54 | 5.10 |  |
