# UI coverage of the e2e run (rust)

Scenarios: 24, steps: 449, failed steps: 0.

| Measure | Covered | Total | % |
|---|---:|---:|---:|
| Server calls made by a step | 255 | 427 | 59.7 |
| Labelled controls acted on | 331 | 1112 | 29.8 |
| Labelled controls shown | 585 | 1112 | 52.6 |
| Code lines (ui/src) | 92215 | 147307 | 62.6 |
| Code statements (ui/src) | 20956 | 38506 | 54.4 |
| Code branches (ui/src) | 17730 | 40832 | 43.4 |
| Code functions (ui/src) | 6422 | 13171 | 48.8 |
| Code bytes (ui/src) | 3828703 | 5876658 | 65.2 |

Not counted: 14 call sites whose URL is not a literal (listed in api-gaps.md); 0 WebSocket call(s); 5 calls in functions nothing uses (dead code, listed in api-gaps.md); 83 labels that are a plain expression.

Code: 24 recordings, 1 chunk(s) never loaded, 36 source file(s) not in the bundle (type-only modules and the like), 49 script(s) without a source map. HTML report: `measure/code-html/index.html`.

## Code by folder

| Folder | Files | Lines % | Branches % | Functions % |
|---|---:|---:|---:|---:|
| ui/src/components/diagrams | 12 | 40.1 | 27.5 | 31.2 |
| ui/src/components/canvas | 32 | 47.5 | 20.8 | 20.5 |
| ui/src/components/desktop | 3 | 48.4 | 28.2 | 40.7 |
| ui/src/components/assist | 14 | 48.6 | 39.1 | 32.5 |
| ui/src/components/preview | 29 | 54.8 | 28.6 | 46.6 |
| ui/src/components/ideas | 20 | 55.9 | 38.4 | 36.1 |
| ui/src/components/docs | 130 | 56.6 | 43.7 | 45.0 |
| ui/src/components/settings | 20 | 58.9 | 35.6 | 47.6 |
| ui/src/components/aiteam | 29 | 59.8 | 40.9 | 50.1 |
| ui/src/components/comments | 2 | 61.2 | 50.2 | 35.4 |
| ui/src/components/notifications | 16 | 61.4 | 37.9 | 46.3 |
| ui/src/components/ai | 89 | 62.3 | 46.5 | 44.6 |
| ui/src/components/sketch | 28 | 63.6 | 21.0 | 31.4 |
| ui/src/utils | 28 | 67.8 | 45.7 | 66.8 |
| ui/src/components/schedules | 8 | 68.0 | 49.5 | 54.9 |
| ui/src | 2 | 71.3 | 71.1 | 56.0 |
| ui/src/components | 53 | 77.2 | 63.1 | 67.2 |
| ui/src/hooks | 10 | 78.0 | 57.8 | 70.1 |
| ui/src/api | 52 | 82.6 | 56.2 | 72.3 |
| ui/src/components/ui | 2 | 83.3 | 51.2 | 75.0 |
| ui/src/components/notifications-follow | 1 | 95.1 | 82.0 | 80.0 |
| ui/src/components/icons | 3 | 96.6 | 72.0 | 100.0 |
| ui/src/types | 2 | 100.0 | 100.0 | 100.0 |

