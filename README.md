# Study Kit

A free, offline study-prep tool. Load your own lesson plan, handout, notes, essay or PDF and Study Kit turns it into flashcards, fill-in-the-blank cards, multiple choice and true/false quizzes, matching, printable practice tests, a spaced-repetition review schedule, and plain restatements (key points, outline, glossary, simplified text).

Everything runs in the browser with deterministic rules: no AI, no servers, no accounts, no analytics. After the first visit it works with no internet connection.

Two editions from one codebase:

- **Hosted PWA** at `kit.studyspine.org` (installable, offline after first load).
- **Single file** `study-kit.html` in `study-kit-vX.Y.Z.zip` on GitHub Releases. Double-click to run from disk.

## Develop

Requires Node 22.18+ (`.nvmrc`).

```bash
npm ci --ignore-scripts
```

```bash
npm run dev
```

`npm run ci` runs everything CI runs: type-check, tests, both builds and the release gates (license allowlist, size budgets, copy check, CSP consistency).

| Path | What |
|---|---|
| `src/engine/` | Extraction (text, Markdown, DOCX, PPTX, PDF) and rule-based generation. Pure TypeScript; runs in the parse worker and in Node tests. |
| `src/parse.worker.ts` | The only worker. Parsing and generation never run on the main thread; a hung job is terminated after 60 s. |
| `src/store.ts` | IndexedDB (`studykit`), in-memory fallback, FSRS scheduling. |
| `src/io.ts` | Export/import validation, CSV/TSV, `.ics`. |
| `src/sw.js` | Hand-written service worker; the build fills in the precache list. |
| `csp.ts` | The Content-Security-Policy, mirrored into `vercel.json` and the page `<meta>`. |
| `scripts/build-single.ts` | Builds `release/study-kit.html` and the zip. |
| `test/fixtures/` | Invented sample documents, one per document type. |

## Security notes

- Strict CSP with Trusted Types (`studykit` is the only policy); no `eval`, no inline script in the hosted edition, no third-party origins.
- Document text is only ever rendered as text nodes.
- DOCX/PPTX: entry-count, size and compression-ratio caps before inflating; any `<!DOCTYPE` is rejected.
- PDF: pdf.js text extraction only (legacy build for the browser matrix), no fonts, rendering, forms or scripting.
- Progress-file import: `JSON.parse` only, hand-written schema validation, prototype keys rejected, unknown fields dropped.

### Service-worker kill switch

If a bad service worker ever ships, deploy `killswitch/sw.js` as `/sw.js`. It deletes every cache, unregisters itself and reloads open tabs from the network. Then ship a fixed release.

## Releasing

Bump `version` in `package.json`, merge, then publish a GitHub Release tagged `vX.Y.Z`. CI attaches `study-kit.html`, the zip, `SHA256SUMS` and a CycloneDX SBOM.

## License

MIT. Word lists in `src/engine/words.ts` are CC0.
