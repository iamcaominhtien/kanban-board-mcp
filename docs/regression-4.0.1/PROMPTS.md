# Prompts for the AIs

Every unit of work is a GitHub issue under the umbrella issue of the regression. Give one AI one issue with the prompt below, filled in. The issue says what to do; [`README.md`](README.md) says how (rules, setup, bug format, branches).

```
Read GitHub issue #<N> of this repository and do it.
First read docs/regression-4.0.1/README.md on the branch claude/adoring-ride-jgq060 (all of it) and follow
its "Branches and pull requests": work on your own branch started from that branch, open a PR into it,
merge your PR into it, then close the issue with a comment saying what was done.
Do not do anything the issue does not ask for.
```

Notes for whoever hands the issues out:

- **Order:** the gate first and alone. When its PR is merged and `PINNED.md` has the SHA, all tester issues can run in parallel. The triage issue starts when every tester issue is closed. Fix issues are created by triage; verify issues follow their fix issues. The cleanup issue is last.
- **Fixers** get the issues the triage AI created, each listing its bugs.
- **Verifiers** must be a different AI session than the fixer of the same bugs.
- Nobody merges the umbrella PR except the owner.
