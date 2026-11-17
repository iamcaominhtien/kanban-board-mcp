# UI coverage of the e2e run (rust)

Scenarios: 30, steps: 713, failed steps: 0.

| Measure | Covered | Total | % |
|---|---:|---:|---:|
| Server calls made by a step | 298 | 427 | 69.8 |
| Labelled controls acted on | 514 | 1109 | 46.3 |
| Labelled controls shown | 708 | 1109 | 63.8 |
| Code lines (ui/src) | 103914 | 147420 | 70.5 |
| Code statements (ui/src) | 25135 | 38572 | 65.2 |
| Code branches (ui/src) | 21362 | 40872 | 52.3 |
| Code functions (ui/src) | 7636 | 13178 | 58.0 |
| Code bytes (ui/src) | 4272499 | 5883245 | 72.6 |

Not counted: 14 call sites whose URL is not a literal (listed in api-gaps.md); 0 WebSocket call(s); 5 calls in functions nothing uses (dead code, listed in api-gaps.md); 83 labels that are a plain expression.

Code: 30 recordings, 1 chunk(s) never loaded, 35 source file(s) not in the bundle (type-only modules and the like), 61 script(s) without a source map. HTML report: `measure/code-html/index.html`.

## Code by folder

| Folder | Files | Lines % | Branches % | Functions % |
|---|---:|---:|---:|---:|
| ui/src/components/desktop | 3 | 48.4 | 28.2 | 40.7 |
| ui/src/components/assist | 14 | 48.6 | 39.1 | 32.5 |
| ui/src/components/preview | 29 | 54.8 | 28.7 | 46.1 |
| ui/src/components/ideas | 20 | 55.9 | 38.4 | 36.1 |
| ui/src/components/settings | 20 | 58.9 | 35.6 | 47.6 |
| ui/src/components/aiteam | 29 | 59.9 | 40.8 | 50.1 |
| ui/src/components/comments | 2 | 61.2 | 50.2 | 35.4 |
| ui/src/components/ai | 89 | 61.5 | 45.9 | 44.2 |
| ui/src/components/notifications | 16 | 61.9 | 38.9 | 46.3 |
| ui/src/components/canvas | 32 | 67.0 | 50.5 | 35.6 |
| ui/src/components/schedules | 8 | 68.0 | 49.5 | 54.9 |
| ui/src | 2 | 72.3 | 73.7 | 55.7 |
| ui/src/utils | 28 | 74.8 | 51.9 | 70.6 |
| ui/src/components | 53 | 77.8 | 64.9 | 68.3 |
| ui/src/components/docs | 130 | 77.9 | 64.6 | 67.7 |
| ui/src/hooks | 10 | 78.3 | 57.8 | 71.4 |
| ui/src/components/sketch | 28 | 82.1 | 57.8 | 76.3 |
| ui/src/components/ui | 2 | 83.3 | 51.2 | 75.0 |
| ui/src/api | 52 | 88.3 | 66.8 | 77.8 |
| ui/src/components/diagrams | 12 | 90.7 | 73.5 | 91.5 |
| ui/src/components/notifications-follow | 1 | 95.1 | 82.0 | 80.0 |
| ui/src/components/icons | 3 | 96.6 | 72.0 | 100.0 |
| ui/src/types | 2 | 100.0 | 100.0 | 100.0 |

