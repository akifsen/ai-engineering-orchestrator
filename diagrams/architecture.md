# Diagrams

These figures match the runtime in this repository. The Team Lead is Codex or Claude Code. The Implementation Engineer is Antigravity. Boxes are roles, not extra services.

## Overall architecture

```mermaid
flowchart LR
  user[User]
  policy[Policy file]
  lead[Team Lead]
  explorer[Explorer]
  architect[Architect]
  worker[fast-worker]
  reviewer[Reviewer]
  bridge[MCP bridge]
  engineer[Antigravity]
  repo[Repository and tests]

  user --> lead
  policy --> lead
  lead --> explorer
  lead --> architect
  lead --> worker
  lead --> bridge
  bridge --> engineer
  engineer --> repo
  explorer --> lead
  architect --> lead
  worker --> repo
  repo --> lead
  lead --> reviewer
  reviewer --> lead
```

The policy file is an AEO managed block in the project `AGENTS.md` for Codex, and `.claude/rules/aeo-orchestration.md` for Claude Code. Existing project instructions stay in place. The bridges expose `delegate_antigravity` on `aeo-antigravity` and `delegate_cursor` on `aeo-cursor`. The diagram still uses the job names. Installed ids are `aeo_explorer` / `aeo-explorer`, `aeo_architect` / `aeo-architect`, `aeo_reviewer` / `aeo-reviewer`, and `aeo_fast_worker` / `aeo-fast-worker`. fast-worker is drawn beside the bridge because it is a different, narrower path: trivial edits only.

## Substantive implementation

```mermaid
flowchart TD
  user[User] --> lead[Team Lead]
  lead --> explore[Explorer when the location is unknown]
  explore --> lead
  lead --> design[Architect when the design is consequential]
  design --> lead
  lead --> contract[Implementation contract]
  contract --> engineer[Antigravity]
  engineer --> work[Implementation and tests]
  work --> gate[Team Lead quality gate]
  gate --> approved[APPROVED]
  gate --> required[CHANGES REQUIRED]
  required --> revision[Antigravity revision]
  revision --> gate
```

## Revision loop

```mermaid
flowchart TD
  implement[Implement] --> verify[Team Lead verifies diff and tests]
  verify --> reviewer[Reviewer when the risk justifies it]
  reviewer --> decide{APPROVED or CHANGES REQUIRED}
  verify --> decide
  decide -->|APPROVED| done[Done]
  decide -->|CHANGES REQUIRED| revise[Antigravity revises]
  revise --> verify
```

Reviewer is optional. The decision stays with the Team Lead either way.

## Cost-aware routing

```mermaid
flowchart TD
  start[Request] --> evidence{Need repository evidence?}
  evidence -->|yes| explorer[Explorer]
  evidence -->|no| design{Consequential design?}
  explorer --> design
  design -->|yes| architect[Architect]
  design -->|no| size{Trivial or substantive?}
  architect --> size
  size -->|trivial| local[Team Lead or fast-worker]
  size -->|substantive| contract[Contract then Antigravity]
  local --> check[Team Lead verification]
  contract --> check
  check --> risk{Independent challenge worth the cost?}
  risk -->|yes| reviewer[Reviewer]
  risk -->|no| gate{Quality gate}
  reviewer --> gate
  gate -->|APPROVED| done[Final response]
  gate -->|CHANGES REQUIRED| revise[Antigravity revision]
  revise --> check
```

A trivial edit does not enter the Antigravity path. A substantive edit does not stay on the Team Lead or on fast-worker. Uncertain size is substantive.
