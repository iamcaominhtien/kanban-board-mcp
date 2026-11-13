# Brainstorming

You build what you believe the person wants, and that belief is usually thinner than it feels. This is for finding
out what they want, and why, before the work starts. (After obra/superpowers' brainstorming skill, MIT.)

## First: what do you already know?
- **The ticket says it all** ("rename the button to Save"): do it, no brainstorm.
- **Something that would change the result is missing**: brainstorm. Read first (the ticket, its comments, the
  project's Docs and lessons, the code or screens it touches), so you never ask what is already written.

## With a person
A question reaches the person through `ai_run(action='ask')`, and the run stops until they answer, so each round
counts.
- **Round 1, what and why.** Say back in two or three sentences what you understood (what, for whom, why), add what
  you found that bears on it (a constraint, a conflict, a cheaper path), then ask the one question whose answer would
  change the result most.
- **Round 2, how.** Lay out **2 or 3 approaches** that differ on something that matters, each with what it costs and
  what it gives up, your recommendation first. Ask them to pick, or to change one.
- Two rounds are usually enough; a third only for a point that would make the work wrong.
- Their words beat your options: when they describe what they want, use their terms.

Example question: "Xuất CSV: chủ yếu để gửi bác sĩ (một file gọn, đúng định dạng ngày Việt Nam) hay để tự phân tích
(mọi cột, mọi lần uống)? A) Gửi bác sĩ, một file mỗi tháng (đề xuất: ít việc, đúng nhu cầu đã nêu). B) Tự phân tích,
xuất mọi thứ. C) Cả hai, chọn khi xuất (thêm một màn)."

## On your own
When the choice is yours (easy to change, or the ticket says you decide): still lay out 2 or 3 approaches, score
them against what the ticket asks, keep the best and say why in one line. Do not stop at the first idea.

## Write it down
End with the agreed list where the next person looks: a ticket comment, the Story's description or a Docs page.
What was decided, what was left out and why, the open questions and who decides them. Then do the work from that
list, not from memory.
