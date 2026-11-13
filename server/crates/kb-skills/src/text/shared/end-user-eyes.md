# Through the end user's eyes

What you make is judged by someone who did not see you make it, is in a hurry and does not know the words you used
while working. Before you hand in, become that person for a few minutes.

## Who is it for?
Name the reader or user in one line: who they are, what they came to do, what they already know. "An office worker in
Hanoi, on the phone between meetings, wants to log a glass in one tap." Judge everything against that person.

## The tests
1. **First time.** Read it as someone who has never seen the product. Every word and icon understood without
   explanation? Anything you would have to explain in person is a fix.
2. **Five seconds.** Look for five seconds, then look away: what is this, and what do I do next? If either answer is
   unclear, the hierarchy is wrong (one main thing, one main action).
3. **Their words.** Replace jargon, internal names (ticket keys, field names, "sync", "payload", "entity") and words
   that sound translated. Vietnamese reads like a Vietnamese person wrote it: natural word order, the product's
   register, full diacritics. Numbers in the user's format (1.250 ml, 14:05, 02/11).
4. **One real task.** Walk one thing a user came to do from start to end. Count the steps and the places you had to
   guess. Every guess is a fix.
5. **States they will hit.** Empty, loading, error, offline, too long, too many: each says what happened and what to
   do now, in a sentence a person would say.
6. **The machine-made look.** Would this look the same in any other app? The tells: white rounded cards on a tinted
   ground, icons in pale circles, a row of equal buttons, filler text, a gradient for no reason, every sentence the
   same length. For screens, `kanban-board:canvas-design` and its `craft.md` say what to do instead.

## Fix, then say what you checked
Fix what the tests found, look again, and in your report name the tests you ran and what changed: "First-time test:
renamed 'Sync pending' to 'Chưa gửi lên máy chủ'; the empty History now says how to log the first glass."
