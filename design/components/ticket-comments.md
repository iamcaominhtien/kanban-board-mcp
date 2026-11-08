# Comments

> Redrawn for AI v2 · source: [`TicketComments.dc.html`](../source/TicketComments.dc.html) · canvas `1794099567-d725` · sha256 `acf1493255024863b29bfb116f8e564791f421ede2ef31c36faf83f6f04d32b7`

> Words, states and conditions follow the code of branch `claude/ai-team-architecture-7a1efc`; the layout is designed here and is not the layout of the current screens. Names, ids, costs and times in the mock-ups are sample data. **Check the code before building from this: the file named in each part is the truth, not the picture.**

## SCREEN — V1

![SCREEN — V1](../images/ticket-comments/01-screen-v1.png)

- Text in this part: "SCREEN — V1" · "Ticket comments" · "A Comments section for the Ticket Detail modal: a plain thread with markdown, inline doc, section and ticket pills (same as Description), @mentions, images, edit and delete, and a one-line trail in Activity. Desktop and web. Sample: KAN-12 “Rate limiting on public endpoints” in Kanban Board; it is Tuesday, Oct 6, 11:24 AM."

---

## Placement in Ticket Detail

![Placement in Ticket Detail](../images/ticket-comments/02-placement-in-ticket-detail.png)

- Text in this part: "A" · "Placement in Ticket Detail" · "Where the section lives and how it relates to Activity. Shown with 3 comments; section B is the same thread after two more replies."

---

## Feature

![Feature](../images/ticket-comments/03-feature.png)

- Text in this part: "Feature" · "KAN-12" · "Rate limiting on public endpoints" · "BACKEND" · "API" · "2" · "DESCRIPTION" · "Rules in" · "Requirements" · "›" · "Auth" · ", contract in" · "Endpoints" · "." · "ACCEPTANCE CRITERIA · 2" · "A client over its limit gets 429 as described in" · "+ 1 more" · "RELATIONS" · "Blocked by" · "KAN-9" · "Token auth on every route" · "ATTACHMENTS · 1" · "limits-draft.png" · "in comment · Tuan Vo" · "NEW SECTION" · "1" · "COMMENTS" · "3" · "Oldest first" · "LP" · "Linh Pham" · "19h ago" · "· edited" · "Scope check before we start. The token rules are in" · "Public routes only (/v1/*), internal ones stay open" · "Limit per token, not per IP" · "The 502s last week came from one sync client retrying in a loop." · "HM" · "Hoa Mai" · "2h ago" · "Agree with the plan. Retry state goes in the" · "Data model" · "so we can replay." · "TV" · "Tuan Vo" · "1h ago" · "@An Nguyen can you review the draft limits? The numbers are in the screenshot." · "limits-draft.png · 182 KB" · "AN" · "Add a comment…" · "STATUS" · "In Progress" · "ASSIGNEE" · "PRIORITY" · "High" · "DUE DATE" · "Oct 12"

---

## Comments is the last section of Details. Order in the modal: Description, Acceptance crite

![Comments is the last section of Details. Order in the modal:](../images/ticket-comments/04-comments-is-the-last-section-of-details-.png)

- Text in this part: "1" · "Comments is the last section of Details. Order in the modal: Description, Acceptance criteria, Relations, Attachments, then Comments. It is the same spot as the one-comment stub in Ticket Detail today. Sub-tickets (parent tickets only) sit above Relations. Count badge shows the live number of non-deleted comments." · "2" · "Activity is not in this column. It is the clock icon in the header (see Activity artboard) and swaps the whole panel. A comment shows there as one line that links back here (section G). Comments never mix into the Activity list." · "Images posted in a comment also list under Attachments, tagged "in comment · Tuan Vo" like the existing Attachments section." · "Oldest first, composer at the end. New comments append above the composer and the view scrolls to them. Dashed outline marks the new section for review only."

---

## The thread

![The thread](../images/ticket-comments/05-the-thread.png)

- Text in this part: "B" · "The thread" · "Five comments on KAN-12: the three from A, then An Nguyen (38m) and Hoa Mai (6m). Hover states shown: time tooltip, others' and own action bars, and a pill with its hover card."

---

## COMMENTS

![COMMENTS](../images/ticket-comments/06-comments.png)

- Text in this part: "COMMENTS" · "5" · "Oldest first" · "LP" · "Linh Pham" · "19h ago" · "Mon, Oct 5 · 4:10 PM" · "· edited" · "Scope check before we start. The token rules are in" · "Requirements" · "›" · "Auth" · "." · "Public routes only (/v1/*), internal ones stay open" · "Limit per token, not per IP" · "The 502s last week came from one sync client retrying in a loop." · "HM" · "Hoa Mai" · "2h ago" · "Agree with the plan. Retry state goes in the" · "Data model" · "so we can replay." · "TV" · "Tuan Vo" · "1h ago" · "@An Nguyen can you review the draft limits? The numbers are in the screenshot." · "limits-draft.png · 182 KB" · "Copy link" · "AN" · "An Nguyen" · "38m ago" · "Looks right." · "KAN-9" · "is done, so we can ship it behind a flag." · "Edit" · "Delete" · "6m ago" · "Thanks. Webhook retries are tracked in" · "KAN-31" · ", and the 429 body should follow" · "API" · "Endpoints" · "Architecture" · "Published · v14" · "from API" · "All endpoints are served under /v1 and need a bearer token. List endpoints are paginated with cursor and limit (max 100). Errors use problem+json with a stable code field, so clients can branch without parsing messages." · "|" · "section edited 1d ago" · "+3 more blocks" · "Open in side panel" · "Open in Docs" · "ANATOMY" · "Avatar, name, time. Relative time (19h ago, 2h ago). Hover the time for the exact stamp, as in Activity." · "edited marker after the time when edited_at is set. No history is kept." · "Hover actions. Your own comment: Edit, Delete, Copy link. Anyone else's: Copy link only. There are no reactions." · "Text is markdown: bold, code, lists, quotes, links. Images show as a thumbnail that opens full size." · "Pills. Doc, section and ticket references are the same pills as in Description; hovering one opens the hover card." · "@mention chip. Blue chip with the member's name; it notifies them (section F)."

---

## Composer

![Composer](../images/ticket-comments/07-composer.png)

- Text in this part: "C" · "Composer" · "Same markdown toolbar and Write / Preview tabs as Description, plus [[ ]] and @ buttons. Each state is one box."

---

## Collapsed

![Collapsed](../images/ticket-comments/08-collapsed.png)

- Text in this part: "1" · "Collapsed" · "AN" · "Add a comment…" · "Resting state. One click or Tab opens the composer; the draft, if any, comes back with it." · "3" · "Typed, ready to send" · "Write" · "Preview" · "B" · "i" · "[[ ]]" · "Thanks. Retry state goes in [[Data model]] and the limits in [[Requirements#Auth]]." · "Attach" · "Cmd" · "+" · "Enter" · "Cancel" · "Comment" · "Draft saved" · "· kept on this device, per ticket" · "Draft saves while typing. Comment is enabled; Cmd+Enter sends (Ctrl+Enter on Windows). Doc references are raw text while writing." · "5" · "Type [[ for docs and sections" · "Details are in [[Dat" · "PAGES" · "Data model" · "Architecture › Data model" · "2h ago" · "2026-09-30 Data sync" · "Meeting notes" · "↑↓" · "move" · "insert" · "Esc" · "close" · "Same suggester as in Description: pages, then sections after #, then tickets. Enter inserts [[Data model]]." · "7" · "KAN- hint" · "This is blocked until KAN-3" · "TICKETS" · "KAN-3…" · "KAN-31" · "Webhook retries" · "KAN-34" · "Audit log export" · "No [[ needed for tickets: typing a key like KAN-31 opens this list and turns into a ticket pill when sent. A pasted key does the same." · "2" · "Focused, empty" · "Comment stays disabled until there is text or an attachment. Esc or Cancel collapses it; Cancel asks nothing when empty." · "4" · "Attachments" · "Draft limits are in the screenshot." · "limits-draft.png" · "Uploading · 62%" · "load-test.csv" · "48 KB" · "Paste or drop an image, or use Attach. Chips show progress; Comment waits for uploads to finish. Images then appear under Attachments." · "6" · "Type @ for members" · "Can you check the numbers, @" · "ON THIS TICKET" · "TV" · "Tuan Vo" · "Assignee" · "LP" · "Linh Pham" · "Reporter" · "HM" · "Hoa Mai" · "Commented" · "EVERYONE ELSE" · "An Nguyen" · "You" · "People on this ticket first (assignee, reporter, anyone who commented), then everyone else in the project. Filters as you type." · "8" · "Preview tab" · "Thanks. Retry state goes in the" · "and the limits in" · "Requirements" · "›" · "Auth" · "." · "KAN-9" · "is done, so" · "can start. cc @Hoa Mai" · "Same render as the posted comment: pills, chip, markdown. The toolbar hides, as in Description. Nothing is saved to the server by previewing."

---

## Editing and deleting

![Editing and deleting](../images/ticket-comments/09-editing-and-deleting.png)

- Text in this part: "D" · "Editing and deleting" · "Only your own comments show Edit and Delete. Admins see Delete on others' comments."

---

## Edit in place

![Edit in place](../images/ticket-comments/10-edit-in-place.png)

- Text in this part: "1" · "Edit in place" · "AN" · "EDITING" · "Write" · "Preview" · "B" · "i" · "[[ ]]" · "Looks right. KAN-9 is done, so we can ship it behind a flag." · "Attach" · "Cmd" · "+" · "Enter" · "Cancel" · "Save" · "Edit replaces the text with the composer in the same spot. Esc or Cancel restores the comment unchanged. Saving sets "edited". No edit window: the author can edit at any time (invented, TODO(backend) to enforce)." · "3" · "Toast with Undo" · "Comment deleted" · "Your comment on KAN-12 was removed." · "Undo" · "Bottom-right toast, as for other undoable actions. Undo puts the comment back in place and the count returns from 4 to 5. It closes after 10 seconds (invented); later restore is an admin task, TODO(backend)." · "2" · "Delete confirm, inline" · "An Nguyen" · "38m ago" · "Looks right." · "KAN-9" · "is done, so we can ship it behind a flag." · "Edit" · "Delete" · "Copy link" · "Delete this comment?" · "It disappears for everyone on this ticket. You get 10 seconds to undo it. Mentions already sent stay sent." · "No dialog: the confirm opens under the comment, like the red-tinted warnings elsewhere, with the same danger button as Docs. Delete in the hover bar is highlighted while it is open." · "4" · ""Comment deleted" rule" · "COMMENTS" · "TV" · "Tuan Vo" · "1h ago" · "@An Nguyen can you review the draft limits? The numbers are in the screenshot." · "limits-draft.png · 182 KB" · "Comment deleted ·" · "HM" · "Hoa Mai" · "6m ago" · "Thanks. Webhook retries are tracked in" · "KAN-31" · ", and the 429 body should follow" · "API" · "›" · "Endpoints" · "." · "The deleted row collapses to a thin rule with Undo, only until the toast closes; then it vanishes, nothing is left behind. The badge drops to 4 at once."

---

## States

![States](../images/ticket-comments/11-states.png)

- Text in this part: "E" · "States" · "Empty, loading, failures, long content and broken references."

---

## Empty

![Empty](../images/ticket-comments/12-empty.png)

- Text in this part: "1" · "Empty" · "COMMENTS" · "0" · "Oldest first" · "No comments yet" · "Start the conversation. Type @ to mention a teammate or [[ to link a doc." · "AN" · "Add a comment…" · "Replaces the thread. The composer stays visible but collapsed." · "2" · "Long thread, middle collapsed (KAN-9, 17 comments)" · "17" · "LP" · "Linh Pham" · "Sep 18" · "Kicking this off. Every route needs the bearer check before we add limits." · "Show 12 older comments" · "TV" · "Tuan Vo" · "3d ago" · "Middleware is in review." · "HM" · "Hoa Mai" · "2d ago" · "Tested on staging, all green." · "An Nguyen" · "5h ago" · "Merged, thanks both." · "1h ago" · "Closing this out." · "First comment and the latest four are shown (1 + 12 + 4 = 17). One click loads all 12 (page size invented, TODO(backend) paging). New comments keep arriving at the bottom." · "3" · "Very long comment" · "Post-mortem notes from last Thursday. The sync client retried every 200 ms when it got a 503, which turned one slow minute into a flood." · "What we changed: backoff with jitter, a hard cap of 5 attempts, and a circuit breaker per token. What we still need: a dashboard for the per-token counters and an alert when a single token goes past 80 percent of its limit for 5 minutes." · "Show more" · "Collapses past about 8 lines or 1,200 characters (invented) with a fade and Show more; Show less folds it back. A deep link to the comment expands it." · "4" · "Loading" · "…" · "Skeleton rows with the Activity pulse. The count shows an ellipsis; the composer is hidden until the first load ends, so nothing is typed into a thread that may fail." · "5" · "Send failed" · "Not sent" · "Shipping behind a flag works for me." · "Data model" · "Couldn't reach the server. Your text is kept; nothing was lost." · "Retry" · "Edit" · "Discard" · "The comment stays in the thread, marked and tinted, with its text intact. Retry resends it as is; Edit reopens it in the composer. No toast: the failure is next to the thing that failed." · "6" · "Offline, queued" · "You are offline. Comments are saved here and sent when the connection returns." · "Queued" · "Cancel send" · "Dashed row = waiting, not sent. It keeps its place, sends in order on reconnect and then becomes a normal comment. Reload keeps the queue on this device." · "7" · "References that no longer resolve" · "4d ago" · "Older notes are in" · "Rate limits v1 and" · "Billing" · "›" · "Limits. Access to" · "Restricted page is still pending. Current rules:" · "." · "Rate limits v1" · "Deleted or broken page. Red dashed, no hover card; click says the page no longer exists. Raw text is kept, so restoring the page fixes the pill." · "Limits" · "Missing section. Amber dashed: the page exists, the heading was renamed or removed." · "Restricted page" · "No permission. Grey with a lock; title and excerpt are hidden from people without access." · "Same states as in Description and Activity (TicketDocRefs). A comment is never blocked or edited because a pill is broken."

---

## Mentions

![Mentions](../images/ticket-comments/13-mentions.png)

- Text in this part: "F" · "Mentions" · "Typing @ suggests members; a mention is a chip in the thread and a notification for the person."

---

## Type @ and a name

![Type @ and a name](../images/ticket-comments/14-type-and-a-name.png)

- Text in this part: "1" · "Type @ and a name" · "AN" · "Write" · "Preview" · "B" · "i" · "[[ ]]" · "Can you take a look, @Li" · "Attach" · "Comment" · "MEMBERS" · "1 match" · "LP" · "Linh Pham" · "Reporter" · "Tab" · "↑↓" · "move" · "Enter" · "insert" · "Esc" · "close" · "Filters by name as you type. Enter or Tab inserts the member." · "2" · "Becomes a chip" · "An Nguyen" · "just now" · "Can you take a look, @Linh Pham? The draft limits are above." · "Stored as text:" · "Can you take a look, @[Linh Pham](member:linh)?" · "Chip is blue to tell it apart from doc and ticket pills. Click opens the member in Members; no hover card." · "3" · "Who is notified" · "Example: Tuan Vo posts his comment from section B, mentioning An Nguyen." · "Notified" · "HM" · "Hoa Mai" · "Commented earlier" · "Mentioned" · "TV" · "Tuan Vo" · "Author, assignee" · "Not notified" · "Rule: reporter, assignee, anyone who already commented and anyone @mentioned, except the author. A mention always notifies. Delivery (in-app, email) is not designed here; TODO(backend)." · "The list is computed on the server when the comment is saved."

---

## Activity interplay

![Activity interplay](../images/ticket-comments/15-activity-interplay.png)

- Text in this part: "G" · "Activity interplay" · "A new comment adds one line to Activity. Following it deep-links to the comment."

---

## Activity timeline, newest first

![Activity timeline, newest first](../images/ticket-comments/16-activity-timeline-newest-first.png)

- Text in this part: "1" · "Activity timeline, newest first" · "14 CHANGES · KAN-12" · "Filter: All" · "TODAY" · "COMMENT" · "Hoa Mai commented" · "View comment" · "6m ago" · "Tue, Oct 6 · 11:18 AM" · "An Nguyen commented" · "38m ago" · "Tuan Vo commented" · "1h ago" · "2h ago" · "STATUS" · "To Do" · "In Progress" · "3h ago" · "One line per comment: "An Nguyen commented" and a View comment link. No text, so long comments and secrets do not leak into the log. Edits and deletions are not logged (invented). It needs an author on every Activity entry, which does not exist yet: TODO(backend)." · "2" · "Deep link #comment-9f3a2c" · ".../projects/kanban/KAN-12" · "#comment-9f3a2c" · "TV" · "Tuan Vo" · "@An Nguyen can you review the draft limits?" · "AN" · "An Nguyen" · "Looks right." · "KAN-9" · "is done, so we can ship it behind a flag." · "HM" · "Hoa Mai" · "Thanks. Webhook retries are tracked in" · "KAN-31" · ", and the 429 body should follow" · "API" · "›" · "Endpoints" · "." · "Click View comment (or open the link) to show Details, scroll the comment to the vertical middle and tint it for about 2 seconds, then it fades to normal. If the comment was deleted: Details open, toast "That comment was deleted", no scroll. Copy link in the hover bar produces this URL; the id is the comment id (TODO(backend))."

---

## Video and files in a comment

![Video and files in a comment](../images/ticket-comments/17-video-and-files-in-a-comment.png)

- Text in this part: "H" · "Video and files in a comment" · "A link to a file the board keeps shows as a small file card. A video plays where it is posted, with its card under it."

---

## A video plays in place

![A video plays in place](../images/ticket-comments/18-a-video-plays-in-place.png)

- Text in this part: "1" · "A video plays in place" · "TV" · "Tuan Vo" · "3m ago" · "Here is the drag handle working in Safari." · "0:00 / 0:42" · "drag-demo.mp4" · "2.1 MB" · "MP4" · "The first frame shows until you press play. The controls are the browser’s own. Clicking the card opens the large viewer." · "2" · "A video the player cannot take" · "Recorded on the desktop." · "screen-capture.mkv" · "48 MB" · "MKV" · "Only .mp4, .webm and .mov get the player. Any other video shows its file card alone, which opens the preview and downloads."

---

## For comparison: a picture and two documents

![For comparison: a picture and two documents](../images/ticket-comments/19-for-comparison-a-picture-and-two-documen.png)

- Text in this part: "3" · "For comparison: a picture and two documents" · "TV" · "Tuan Vo" · "3m ago" · "Numbers for the review:" · "handle-footer.png · 94 KB" · "limits-draft.pdf" · "182 KB" · "PDF" · "budget.xlsx" · "86 KB" · "XLSX" · "A picture shows as a thumbnail that opens full size. Documents are cards without a player." · "4" · "An .mp4 the browser cannot play" · "Exported from the phone." · "0:00" · "phone-clip.mp4" · "31 MB" · "MP4" · "The player is still there but has nothing to play (what it shows is the browser’s). The card under it still opens the preview and downloads."

---

## A report that carries the files

![A report that carries the files](../images/ticket-comments/20-a-report-that-carries-the-files.png)

- Text in this part: "I" · "A report that carries the files" · "The team attaches each file without a comment of its own and links it in its closing report, so the report shows the pictures, the video and the file cards in place."

---

## A report with one picture

![A report with one picture](../images/ticket-comments/21-a-report-with-one-picture.png)

- Text in this part: "1" · "A report with one picture" · "Backend team" · "AI" · "AI summary" · "just now" · "Done. The drag handle is in the card footer; keyboard order is unchanged." · "handle-footer.png · 94 KB" · "Run #3 · 8,412 tokens · claude-sonnet-4-5" · "2" · "A report with a video" · "0:00 / 0:18" · "drag-demo.mp4" · "2.1 MB" · "MP4"

---

## A report with three files of different types

![A report with three files of different types](../images/ticket-comments/22-a-report-with-three-files-of-different-t.png)

- Text in this part: "3" · "A report with three files of different types" · "Backend team" · "AI" · "AI summary" · "just now" · "Done. The drag handle is in the card footer; keyboard order is unchanged." · "handle-spec.pdf" · "184 KB" · "PDF" · "timings.xlsx" · "36 KB" · "XLSX" · "review-notes.docx" · "52 KB" · "DOCX" · "Run #3 · 8,412 tokens · claude-sonnet-4-5" · "4" · "A report with no files" · "Open: Safari 17 focus order is not checked."

---

## Notes

![Notes](../images/ticket-comments/23-notes.png)

- Text in this part: "Notes" · "Comments are stored as markdown text (body_md). Pills, chips and image thumbnails are rendered on the client; Edit shows the raw text." · "Doc references are detected when the comment is saved, from [[Page]], [[Page#Section]] and ticket keys. They feed the ticket's "Linked docs" with origin "comment" (see TicketDocRefs); deleting the comment removes them." · "Limits (invented): 10,000 characters per comment, 10 attachments per comment, images up to 10 MB. Past the limit Comment stays disabled; a counter shows from 9,000 characters." · "Order is oldest first (created_at, then id). New comments from others append live without moving what you read; a "1 new comment" pill shows if you are scrolled up (invented)." · "No edit window: authors edit or delete their own comments at any time (invented). Admins can delete any comment but not edit it (invented). Read-only members see the thread without a composer. No reactions, no replies, no resolve state." · "Deleting is soft (deleted_at); the ten-second Undo clears it and the list endpoint never returns deleted rows." · "TODO(backend): table comments (id, ticket_id, author_id, body_md, created_at, edited_at, deleted_at). Not in the current data model; invented here." · "TODO(backend): endpoints GET /tickets/:id/comments (paged, oldest first), POST, PATCH /comments/:id, DELETE /comments/:id (soft), POST /comments/:id/restore for Undo." · "TODO(backend): mention parsing for @[Name](member:id), recipients (reporter, assignee, earlier commenters, mentions, minus the author) and notification delivery." · "TODO(backend): Activity event "comment_added" with author_id and comment_id so the timeline line can link to #comment-id (ActivityEntry has no author today)." · "TODO(backend): MCP tools to read and add comments, e.g. list_comments(ticket_id) and add_comment(ticket_id, body_md); names invented."

---

Rows, differences from the code and open points for this group are in [idea-ai-help.md](idea-ai-help.md).
