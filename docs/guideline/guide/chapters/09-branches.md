---
title: Branches and workspace
part: 2
audience: [developer]
summary: Link tickets to real git branches, and keep a scratch folder per ticket.
reading: 6
---
## Link a project to a repository

Open {menu:Settings › Repositories} and set the folder of the project’s git repository. You can also choose worktree defaults.

## Branches on a ticket

On a ticket you can **add** a branch, **checkout** it and see its commits against `main` as a graph. The ticket keeps the link, so the branch shows on the ticket page. Over MCP the same actions are `ticket_branches add`, `update`, `delete` and `checkout`.

!!! warning
    Checking out a branch changes the working files of your repository. Commit or stash your own work first.

## Git worktrees

If you use worktrees, the project settings let you choose where a ticket’s worktree goes, so several tickets can be worked on side by side.

## Workspace

Each ticket has a **Workspace**: a scratch folder with a file manager. Use it for notes, exports and test data that do not belong in the repository. Workspace files live outside the data folder on purpose, so the Export in Settings does not include them ({ch:data}).
