# UI coverage of the e2e run (rust)

Scenarios: 27, steps: 574, failed steps: 0.

| Measure | Covered | Total | % |
|---|---:|---:|---:|
| Server calls made by a step | 269 | 427 | 63.0 |
| Labelled controls acted on | 431 | 1109 | 38.9 |
| Labelled controls shown | 651 | 1109 | 58.7 |
| Code lines (ui/src) | 99405 | 147385 | 67.5 |
| Code statements (ui/src) | 22685 | 38550 | 58.9 |
| Code branches (ui/src) | 19622 | 40850 | 48.0 |
| Code functions (ui/src) | 7091 | 13177 | 53.8 |
| Code bytes (ui/src) | 4097334 | 5880835 | 69.7 |

Not counted: 14 call sites whose URL is not a literal (listed in api-gaps.md); 0 WebSocket call(s); 5 calls in functions nothing uses (dead code, listed in api-gaps.md); 83 labels that are a plain expression.

Code: 27 recordings, 1 chunk(s) never loaded, 35 source file(s) not in the bundle (type-only modules and the like), 55 script(s) without a source map. HTML report: `measure/code-html/index.html`.

## Code by folder

| Folder | Files | Lines % | Branches % | Functions % |
|---|---:|---:|---:|---:|
| ui/src/components/diagrams | 12 | 40.2 | 29.0 | 32.6 |
| ui/src/components/canvas | 32 | 47.5 | 20.8 | 20.5 |
| ui/src/components/desktop | 3 | 48.4 | 28.2 | 40.7 |
| ui/src/components/assist | 14 | 48.6 | 39.1 | 32.5 |
| ui/src/components/preview | 29 | 54.8 | 28.6 | 46.5 |
| ui/src/components/ideas | 20 | 55.9 | 38.4 | 36.1 |
| ui/src/components/settings | 20 | 58.9 | 35.6 | 47.6 |
| ui/src/components/aiteam | 29 | 59.8 | 40.9 | 50.1 |
| ui/src/components/comments | 2 | 61.2 | 50.2 | 35.4 |
| ui/src/components/notifications | 16 | 61.4 | 37.9 | 46.3 |
| ui/src/components/ai | 89 | 62.4 | 46.6 | 44.8 |
| ui/src/components/sketch | 28 | 63.6 | 21.0 | 31.4 |
| ui/src/components/schedules | 8 | 68.0 | 49.5 | 54.9 |
| ui/src/utils | 28 | 69.7 | 48.1 | 69.1 |
| ui/src | 2 | 71.6 | 71.1 | 55.7 |
| ui/src/components | 53 | 77.4 | 63.7 | 67.8 |
| ui/src/components/docs | 130 | 77.4 | 64.1 | 66.9 |
| ui/src/hooks | 10 | 78.0 | 57.8 | 70.1 |
| ui/src/components/ui | 2 | 83.3 | 51.2 | 75.0 |
| ui/src/api | 52 | 84.4 | 58.7 | 74.1 |
| ui/src/components/notifications-follow | 1 | 95.1 | 82.0 | 80.0 |
| ui/src/components/icons | 3 | 96.6 | 72.0 | 100.0 |
| ui/src/types | 2 | 100.0 | 100.0 | 100.0 |

