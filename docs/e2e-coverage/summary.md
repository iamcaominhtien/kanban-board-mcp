# UI coverage of the e2e run (rust)

Scenarios: 39, steps: 944, failed steps: 0.

| Measure | Covered | Total | % |
|---|---:|---:|---:|
| Server calls made by a step | 401 | 427 | 93.9 |
| Labelled controls acted on | 657 | 1104 | 59.5 |
| Labelled controls shown | 845 | 1104 | 76.5 |
| Code lines (ui/src) | 115721 | 147849 | 78.3 |
| Code statements (ui/src) | 28107 | 38677 | 72.7 |
| Code branches (ui/src) | 25083 | 41105 | 61.0 |
| Code functions (ui/src) | 9100 | 13234 | 68.8 |
| Code bytes (ui/src) | 4744590 | 5902413 | 80.4 |

Not counted: 14 call sites whose URL is not a literal (listed in api-gaps.md); 0 WebSocket call(s); 5 calls in functions nothing uses (dead code, listed in api-gaps.md); 83 labels that are a plain expression.

Code: 39 recordings, 1 chunk(s) never loaded, 31 source file(s) not in the bundle (type-only modules and the like), 80 script(s) without a source map. HTML report: `measure/code-html/index.html`.

## Code by folder

| Folder | Files | Lines % | Branches % | Functions % |
|---|---:|---:|---:|---:|
| ui/src/components/desktop | 3 | 48.4 | 28.2 | 40.7 |
| ui/src/components/comments | 2 | 61.2 | 50.2 | 35.4 |
| ui/src/components/assist | 14 | 63.3 | 51.5 | 50.9 |
| ui/src/components/canvas | 32 | 66.2 | 48.9 | 34.6 |
| ui/src/components/aiteam | 29 | 66.7 | 46.0 | 58.8 |
| ui/src/components/schedules | 8 | 74.1 | 55.5 | 60.0 |
| ui/src/components/notifications | 16 | 75.8 | 54.4 | 61.7 |
| ui/src | 2 | 76.0 | 77.4 | 61.1 |
| ui/src/utils | 28 | 76.3 | 55.1 | 74.7 |
| ui/src/components/preview | 29 | 77.8 | 49.8 | 73.2 |
| ui/src/hooks | 10 | 78.0 | 57.8 | 70.1 |
| ui/src/components | 53 | 78.8 | 65.8 | 70.3 |
| ui/src/components/ai | 90 | 78.9 | 64.8 | 67.8 |
| ui/src/components/docs | 130 | 79.2 | 66.6 | 70.0 |
| ui/src/components/sketch | 28 | 81.9 | 57.0 | 76.3 |
| ui/src/components/settings | 20 | 83.1 | 64.5 | 72.4 |
| ui/src/components/ui | 2 | 85.2 | 53.5 | 79.2 |
| ui/src/components/ideas | 20 | 86.3 | 74.8 | 76.1 |
| ui/src/components/diagrams | 12 | 90.7 | 73.5 | 91.5 |
| ui/src/components/notifications-follow | 1 | 95.1 | 82.0 | 80.0 |
| ui/src/api | 52 | 95.1 | 76.5 | 93.7 |
| ui/src/components/icons | 3 | 96.6 | 72.0 | 100.0 |
| ui/src/types | 2 | 100.0 | 100.0 | 100.0 |

