# Debugging Methodology (Quick Reference)

## 1) Isolate First
- Reproduce in the smallest possible environment (unit, function, or local container) before touching the full system.
- Prefer local container runs to validate image contents and runtime behavior.
- Only move to K8s/cloud after the isolated test passes.

## 2) Follow the Execution Thread
- Trace the feature from initiation to end:
  - Entry point
  - Inputs
  - Intermediate transforms
  - Side effects (DB, queue, network)
  - Output
- Add targeted debug logs at each handoff boundary.

## 3) Reduce Variables
- Change one thing at a time.
- Avoid simultaneous code, config, and infrastructure changes.
- Validate each assumption explicitly.

## 4) Short Feedback Loops
- Favor commands and checks that return fast.
- Use local or direct calls to confirm behavior first.
- Only escalate to full-system tests when smaller checks are green.

## 5) Evidence-Driven Decisions
- Log meaningful state (not just “it ran”).
- Capture outputs and errors with context.
- Keep a short timeline of what was tried and what changed.

## 6) Escalate Deliberately
- If isolated tests pass but integrated tests fail, then:
  - Verify environment parity (image digest, env vars, secrets, RBAC)
  - Confirm networking/DNS/permissions
  - Add logs around the integration boundary

## 7) Stop and Summarize When Stuck
- If progress stalls, pause and summarize:
  - What worked
  - What failed
  - What changed
  - The most likely root causes

