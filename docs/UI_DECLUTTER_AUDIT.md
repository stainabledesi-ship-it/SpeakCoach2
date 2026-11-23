# UI declutter redesign audit

Baseline: `feature/shadowing-fixes-and-ui-cleanup` at `a947b35d234636c07d825c58532689bb284e0e7f`.
Work branch: `redesign/declutter-ui`.

| Screen | First-load competition observed | Presentation direction |
|---|---|---|
| Shadowing | Separate language picker, sentence-set heading/count, difficulty tabs, topic form, generation/history controls, provider badge and voice notice appear before practice; result strip duplicates the score report; translation tools occupy a full card. | Put language/difficulty/set controls behind one context disclosure; keep sentence, playback and recording prominent; remove redundant provider status; retain troubleshooting through compact help. |
| IELTS library | Evaluator tier badge, multiple notices, draft controls, restore action, topic form, random-topic and generation controls compete with mode and question sets. | Remove redundant tier/status labels; group generation/restore tools; keep mode directly above question sets; preserve resume and history. |
| IELTS session | Session heading and source/provider badges compete with the prompt and timer. | Minimize session chrome; emphasize timer, cue card and the single current action. |
| Settings | Six provider forms and secondary configuration make the screen long. | Restyle accordion groups and status hierarchy; preserve provider logic and all controls. |
| Result | Criteria, corrections and vocabulary compete with the overall estimate. | Lead with overall practice estimate; retain all detailed feedback in reachable sections. |
| History | Repeated card frames and action density compete with scores and trends. | Compact rows and neutral separators; preserve retry, repeat, delete and chart behavior. |
| Onboarding / Diagnostics | Dense instructional and technical content. | Improve typography, spacing and surface hierarchy without changing setup or diagnostic behavior. |

## Invariants
- No changes to services, state transitions, providers, API fallback, storage, backup/restore, or scoring.
- Preserve Light/Dark/System, Android Back, in-app confirmation, onboarding languages, and every feature.
- Preserve IDs and data attributes used by handlers and tests.
- CI must run `npm test` and `npm run build`; local git/network access was unavailable during this pass.

## Delivery notes

- Shadowing now has one compact context disclosure, a single score report, and collapsed translation and timing/recognition details. The existing word replay, retry-weak-words, recording, set history and speech-help actions remain wired to their original handlers.
- IELTS generation, topic selection and set restoration are grouped under **New sets**. The test mode remains immediately above the question list. The active session uses a compact part/question header; source and ready-state badges are hidden while the session is active.
- IELTS scoring criteria, speech statistics, grammar corrections, vocabulary upgrades and model answers are collapsed by default. History uses compact rows, expandable criterion details and one chronological band-trend chart when at least two valid scored sessions exist.
- Settings retains all six provider forms, quick setup, Test all APIs, backup/restore, appearance, updates and diagnostics. Provider rows use learner-facing labels; technical configuration remains inside each expanded row.
- The existing onboarding language selection and guide content, diagnostics actions, confirmation flow and theme manager were left intact.
- No app services, storage, scoring, API fallback, provider configuration, session transitions or backup payloads were changed.

## Validation and assets

- Added `src/styles/contrast.test.ts` to enforce WCAG contrast thresholds in both themes.
- Added `.github/workflows/ui-redesign-validation.yml` to run `npm ci`, `npm test` and `npm run build` on the redesign branch and on pull requests targeting the source branch. The GitHub connector did not expose a run record for this push, so the tests/build are **not claimed as passed** yet.
- README screenshots were not regenerated; screenshots depicting the old Shadowing, IELTS library/session, Settings, result and history layouts are outdated.
- The repository did not expose bundled Vazirmatn and Inter WOFF2 assets in the files inspected for this pass. The stylesheet declares those font families with system fallbacks; offline font bundling remains an outstanding visual asset task.
