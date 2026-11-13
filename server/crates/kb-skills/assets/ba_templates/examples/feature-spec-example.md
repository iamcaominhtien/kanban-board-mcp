## Summary

Readers can reserve a book that is on loan, so they get it next instead of checking back every day (LIB-41).

## User stories

### P1 · Reserve a book that is on loan

As a reader, I want to reserve a book that is on loan, so that I get it as soon as it comes back.

- **Test on its own:** a reader with no reservation reserves a book on loan and sees it in "My reservations".
- **Acceptance scenarios:**
  1. **Given** "Đất rừng phương Nam" is on loan and I have no reservation, **when** I press "Đặt trước", **then**
     I see "Bạn đứng thứ 1 trong hàng chờ" and the book is in "Sách đặt trước".
  2. **Given** two readers reserved it before me, **when** I reserve it, **then** I see "Bạn đứng thứ 3".

### P2 · Get told when it is ready

As a reader, I want a message when my reserved book is back, so that I can collect it in time.

- **Test on its own:** return a reserved book; the first reader in line gets the message within 5 minutes.
- **Acceptance scenarios:**
  1. **Given** I am first in line, **when** the book is returned, **then** I get "Sách đã sẵn sàng, giữ cho bạn
     đến 18:00 ngày 12/5" by email and in the app.

## Edge cases

- The book is on the shelf: no "Đặt trước" button, "Mượn ngay" instead.
- I already reserved it: the button reads "Đã đặt trước · thứ 2" and is disabled.
- I do not collect it in 3 days: the next reader is told; I see "Đặt trước đã hết hạn".

## Functional requirements

- **FR-001** While a book is on loan, the system shall show "Đặt trước" on its page.
- **FR-002** When a reader reserves a book, the system shall add them to the end of its waiting line.
- **FR-003** The system shall allow at most 5 active reservations per reader.
- **FR-004** If a reader with 5 reservations presses "Đặt trước", then the system shall show "Bạn đã đặt trước
  5 cuốn, tối đa là 5" and add nothing.
- **FR-005** When a reserved book is returned, the system shall hold it 3 days for the first reader in line.
- **FR-006** Readers may cancel a reservation **[NEEDS CLARIFICATION: also once the book is held for them?
  Librarian decides]**

## Copy

| Where | Text |
|---|---|
| Button, on loan | Đặt trước |
| After reserving | Bạn đứng thứ {n} trong hàng chờ |
| Limit reached | Bạn đã đặt trước 5 cuốn, tối đa là 5 |
| Ready | Sách đã sẵn sàng, giữ cho bạn đến {giờ} ngày {ngày} |

## Success criteria

- **SC-001** A reader reserves a book in under 30 seconds the first time.
- **SC-002** Fewer than 1 in 10 held books go uncollected.

## Out of scope

Reserving a book on the shelf, paying a fee, choosing a branch.

## Assumptions and open questions

- Assumption: the hold is 3 days, as for loans today (librarian can change it).
- Question: may a reader cancel once the book is held? A) yes, the next reader is told (recommended) B) no.
  Librarian decides.
