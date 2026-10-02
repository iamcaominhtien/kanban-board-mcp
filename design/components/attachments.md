# Attachments

> Component · source: [`Attachments.dc.html`](../source/Attachments.dc.html) · canvas `1789831198-eb58` · sha256 `b061d3cd81252f5356e62ee61ed795cfa3bc71e6399acf78f079a30e1582fee6`

Every file uploaded to a ticket — from Description or from any comment — lands in one consolidated Attachments section at the bottom of the ticket, tagged with where it came from. No duplicate strip under Description and another under each comment: the markdown/comment text already shows the media inline, so a second copy right below it added nothing.

---

## 1. One zone, ticket-wide — placed after Comments

Source: [Attachments.dc.html](../source/Attachments.dc.html) › `<!-- Consolidated attachments zone -->` (L45–112)

![Attachments · 4: two image thumbnails, qa-notes.pdf and safari-repro.zip chips, dashed add tile; each tagged with its origin](../images/attachments/attachments-1-consolidated-zone.png)

Images render as square thumbnails (click to open full-size); anything else falls back to a name + size chip with its own icon per file type. Each item is tagged with where it was uploaded from — Description, or a named comment — so provenance isn't lost by consolidating the display.

## 2. While uploading

Source: [Attachments.dc.html](../source/Attachments.dc.html) › `<!-- Uploading state -->` (L113–145)

![Uploading state: design-spec.pdf with placeholder thumbnail](../images/attachments/attachments-2-uploading.png)

Thumbnail placeholder pulses until the image decodes; non-image files show a thin progress bar under the name instead.

- Animation: the placeholder pulses on a 1.4s ease-in-out infinite loop (`attPulseBg` / `attPulseIcon`); the image shows one static frame.
