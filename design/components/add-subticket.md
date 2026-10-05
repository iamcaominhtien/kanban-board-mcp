# Add Sub-ticket

> Component · source: [`AddSubticket.dc.html`](../source/AddSubticket.dc.html) · canvas `1789831198-eb58` · sha256 `80a473ddb53c7891b62f00c83e624291c1de4aa3bf4ce88fb9f2cd562a53af26`

The dashed button in Ticket Detail expands into a row inside the sub-ticket list itself, matching its height — so the new row previews right where it'll land. Two ways in: type a new title, or search and link an existing ticket.

---

## 1. Idle

Source: [AddSubticket.dc.html](../source/AddSubticket.dc.html) › `<!-- Idle -->` (L30–38)

![Dashed "Add sub-ticket" button](../images/add-subticket/add-subticket-1-idle.png)

## 2. Expanded — new ticket

Source: [AddSubticket.dc.html](../source/AddSubticket.dc.html) › `<!-- Expanded: new -->` (L39–60)

![Expanded row with New / Existing tabs, New selected, title input](../images/add-subticket/add-subticket-2-expanded-new.png)

- Hint under the row: "Enter to create and add another · Esc to cancel".

## 3. Expanded — link existing

Source: [AddSubticket.dc.html](../source/AddSubticket.dc.html) › `<!-- Expanded: existing -->` (L61–103)

![Existing tab with search "header" and two results KAN-152 and KAN-159](../images/add-subticket/add-subticket-3-expanded-existing.png)

- Result rows highlight on hover.
- Already-linked tickets and the ticket's own parent are filtered out of results.
