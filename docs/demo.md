# Recording the Test B demo

The README references `scripts/record-demo`; no such script exists. This document is the instruction set it points to. Do not expect a recorder binary in this repository.

## Sample repository

The repository must have a real refresh-token lifecycle path or a comparable behavioral bug. From [examples/smoke-test.md](../examples/smoke-test.md):

> Use a repository that actually has a refresh-token path. If it does not, name a real behavioral bug in that repository in the same shape: inspect, implement, add regression coverage, verify, do not widen the architecture.

This repository ships no sample app. Pick a project you trust. Record that project's baseline first:

```bash
git status --short
```

## Preconditions

1. AEO is installed into that project. Dry-run, then install. See [install](install.md).
2. `doctor` passes.
3. Start a new Codex or Claude session.
4. `agy` is logged in.

## Prompt

Paste this Test B prompt. Do not mention Antigravity or the tool names. Copied from [examples/smoke-test.md](../examples/smoke-test.md):

```text
Inspect the refresh-token lifecycle problem, implement the necessary
production-ready correction, add appropriate regression coverage, and verify
the result without unnecessarily changing the architecture.
```

## Capture

These are third-party tools. This repository does not ship them.

Run the capture commands from this repository's root so the files land at `docs/assets/`, or copy the finished gif there afterward.

Unix:

```bash
asciinema rec docs/assets/test-b-demo.cast
agg docs/assets/test-b-demo.cast docs/assets/test-b-demo.gif
```

Windows: use Windows Terminal plus a GIF recorder such as ScreenToGif, or run asciinema via WSL with the Unix commands above.

## Output

Save the recording into this repository (not the sample project) as `docs/assets/test-b-demo.gif` (optional `.cast`). That is the path the README placeholder references. Then replace the README comment `<!-- TODO: record with scripts/record-demo instructions in docs/demo.md -->` with the real embed:

```markdown
![Test B demo](docs/assets/test-b-demo.gif)
```

## Transcript excerpt

Select a short real excerpt: the `delegate_antigravity` call, the diff check, and the Team Lead's APPROVED or CHANGES REQUIRED line. Redact paths or secrets. Paste it into the README fenced block. Do not edit the model's words. Do not fabricate an excerpt.
