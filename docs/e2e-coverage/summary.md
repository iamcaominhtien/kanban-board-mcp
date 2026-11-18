# UI coverage of the e2e run (rust)

Scenarios: 33, steps: 804, failed steps: 0.

| Measure | Covered | Total | % |
|---|---:|---:|---:|
| Server calls made by a step | 323 | 427 | 75.6 |
| Labelled controls acted on | 573 | 1109 | 51.7 |
| Labelled controls shown | 754 | 1109 | 68.0 |
| Code lines (ui/src) | 106649 | 147456 | 72.3 |
| Code statements (ui/src) | 25749 | 38583 | 66.7 |
| Code branches (ui/src) | 22189 | 40881 | 54.3 |
| Code functions (ui/src) | 7993 | 13185 | 60.6 |
| Code bytes (ui/src) | 4384551 | 5884991 | 74.5 |

Not counted: 14 call sites whose URL is not a literal (listed in api-gaps.md); 0 WebSocket call(s); 5 calls in functions nothing uses (dead code, listed in api-gaps.md); 83 labels that are a plain expression.

Code: 33 recordings, 1 chunk(s) never loaded, 35 source file(s) not in the bundle (type-only modules and the like), 68 script(s) without a source map. HTML report: `measure/code-html/index.html`.

## Code by folder

| Folder | Files | Lines % | Branches % | Functions % |
|---|---:|---:|---:|---:|
| ui/src/components/desktop | 3 | 48.4 | 28.2 | 40.7 |
| ui/src/components/assist | 14 | 48.6 | 39.1 | 32.5 |
| ui/src/components/preview | 29 | 54.9 | 28.8 | 46.5 |
| ui/src/components/settings | 20 | 58.9 | 35.6 | 47.6 |
| ui/src/components/aiteam | 29 | 59.8 | 40.9 | 50.1 |
| ui/src/components/comments | 2 | 61.2 | 50.2 | 35.4 |
| ui/src/components/notifications | 16 | 61.9 | 38.9 | 46.3 |
| ui/src/components/ai | 89 | 62.4 | 46.7 | 45.0 |
| ui/src/components/canvas | 32 | 67.0 | 50.7 | 35.6 |
| ui/src/components/schedules | 8 | 68.0 | 49.5 | 54.9 |
| ui/src | 2 | 73.6 | 74.1 | 59.3 |
| ui/src/utils | 28 | 74.9 | 52.4 | 70.6 |
| ui/src/components/docs | 130 | 77.9 | 64.8 | 67.8 |
| ui/src/components | 53 | 78.0 | 64.8 | 68.3 |
| ui/src/hooks | 10 | 78.0 | 57.8 | 70.1 |
| ui/src/components/sketch | 28 | 82.1 | 57.8 | 76.3 |
| ui/src/components/ui | 2 | 85.2 | 53.5 | 79.2 |
| ui/src/components/ideas | 20 | 86.3 | 74.8 | 76.1 |
| ui/src/api | 52 | 90.5 | 68.5 | 81.9 |
| ui/src/components/diagrams | 12 | 90.7 | 73.5 | 91.5 |
| ui/src/components/notifications-follow | 1 | 95.1 | 82.0 | 80.0 |
| ui/src/components/icons | 3 | 96.6 | 72.0 | 100.0 |
| ui/src/types | 2 | 100.0 | 100.0 | 100.0 |

