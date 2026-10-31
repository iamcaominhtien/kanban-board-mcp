---
title: Testing and debugging
part: 2
audience: [everyone, developer]
summary: Track test cases per ticket, and keep a journal of what you tried while fixing something.
reading: 5
---
## Test cases

Each ticket has a list of test cases with a state: pass, fail or running. Test cases also roll up from child tickets. A ticket can require that every test case passes before it can go to Done. An AI can suggest test cases tied to the acceptance criteria, and shows which criteria are not yet covered ({ch:board-ai}).

## Debug Space

The Debug Space is a journal on the ticket. Write each attempt, blocker and fix as an entry, so anyone who picks the ticket up later can see what was tried. AI agents can write to it over MCP, as `work_log` items ({ch:mcp}).

!!! tip
    Write the journal while you work, not at the end. A line like “tried clearing the cache, no change” saves the next person a day.
