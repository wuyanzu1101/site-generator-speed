# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/wuyanzu1101/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/wuyanzu1101/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free drop-in for makefun-site 1.0.0, written from scratch for make.fun's
"Build a static site faster" bounty. `solve.js` exports `run(input)`, which returns exactly the
output tree makefun-site returns for a site's input — every page's `index.html`, the index and
tag pages, `build-report.txt` and each static file, byte for byte. `main.ts` is the driver the
harness runs: it reads every case from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

Run it on the practice set with the kit's local grader (from the unpacked kit directory):

    node cli/makefun.mjs grade-local --kit . --bot /path/to/sitegen --driver docker

Pure JavaScript, nothing installed, no WebAssembly, no native addons, no prebuilt binaries.
