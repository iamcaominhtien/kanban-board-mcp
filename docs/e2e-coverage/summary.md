# UI coverage of the e2e run (rust)

Scenarios: 36, steps: 895, failed steps: 0.

| Measure | Covered | Total | % |
|---|---:|---:|---:|
| Server calls made by a step | 386 | 427 | 90.4 |
| Labelled controls acted on | 637 | 1109 | 57.4 |
| Labelled controls shown | 822 | 1109 | 74.1 |
| Code lines (ui/src) | 111540 | 147486 | 75.6 |
| Code statements (ui/src) | 26795 | 38591 | 69.4 |
| Code branches (ui/src) | 23748 | 40922 | 58.0 |
| Code functions (ui/src) | 8684 | 13187 | 65.8 |
| Code bytes (ui/src) | 4574987 | 5887268 | 77.7 |

Not counted: 14 call sites whose URL is not a literal (listed in api-gaps.md); 0 WebSocket call(s); 5 calls in functions nothing uses (dead code, listed in api-gaps.md); 83 labels that are a plain expression.

Code: 36 recordings, 1 chunk(s) never loaded, 35 source file(s) not in the bundle (type-only modules and the like), 74 script(s) without a source map. HTML report: `measure/code-html/index.html`.

## Code by folder

| Folder | Files | Lines % | Branches % | Functions % |
|---|---:|---:|---:|---:|
| ui/src/components/desktop | 3 | 48.4 | 28.2 | 40.7 |
| ui/src/components/preview | 29 | 54.9 | 28.8 | 46.5 |
| ui/src/components/settings | 20 | 58.9 | 35.6 | 47.6 |
| ui/src/components/comments | 2 | 61.4 | 50.7 | 35.4 |
| ui/src/components/notifications | 16 | 62.0 | 38.9 | 46.3 |
| ui/src/components/assist | 14 | 62.5 | 50.2 | 50.7 |
| ui/src/components/canvas | 32 | 66.2 | 49.0 | 34.6 |
| ui/src/components/aiteam | 29 | 68.1 | 48.4 | 60.2 |
| ui/src/components/schedules | 8 | 74.1 | 55.5 | 60.0 |
| ui/src | 2 | 75.4 | 76.2 | 60.5 |
| ui/src/utils | 28 | 75.8 | 55.1 | 74.7 |
| ui/src/components | 53 | 77.8 | 64.5 | 68.5 |
| ui/src/hooks | 10 | 78.0 | 57.8 | 70.1 |
| ui/src/components/ai | 89 | 78.8 | 64.4 | 67.5 |
| ui/src/components/docs | 130 | 79.2 | 66.7 | 70.0 |
| ui/src/components/sketch | 28 | 81.8 | 56.8 | 76.3 |
| ui/src/components/ui | 2 | 85.2 | 53.5 | 79.2 |
| ui/src/components/ideas | 20 | 86.3 | 74.8 | 76.1 |
| ui/src/components/diagrams | 12 | 90.7 | 73.5 | 91.5 |
| ui/src/api | 52 | 93.8 | 74.5 | 90.4 |
| ui/src/components/notifications-follow | 1 | 95.1 | 82.0 | 80.0 |
| ui/src/components/icons | 3 | 96.6 | 72.0 | 100.0 |
| ui/src/types | 2 | 100.0 | 100.0 | 100.0 |

