# Lossless PNG squeeze for screenshots

[![make.fun bounty](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Mishter-J/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Mishter-J/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A Node 22 program (`main.ts`, built-in modules only) that re-encodes each
1280x720 RGBA screenshot as the smallest lossless PNG it can find within a
fixed, deterministic work budget. It tries colour-type reduction (palette,
grey, grey+alpha, RGB, RGBA, with tRNS where that stays exact), several
per-row filter searches (None/Sub/Up/Avg/Paeth), and several zlib settings,
then writes the smallest valid result for every instance.

Run: `node main.ts` reads `/input/i001..i008/image.png` and writes
`/output/i001..i008/image.png`.

Built for make.fun's "Squeeze screenshots into the smallest PNG,
27 November 2026" bounty: https://make.fun/bounty/png-squeeze-01-run-20261127
