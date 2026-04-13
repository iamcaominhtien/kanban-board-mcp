---
title: "Test Plan: IAM-87 Description Image Paste and Upload"
type: test
status: stable
ticket: IAM-87
version: 1.1.0
created: 2026-04-13
updated: 2026-04-13
authors: [GitHub Copilot (QC Agent)]
related:
  - docs/specs/iam-87-description-upload.md
---

# Test Plan: IAM-87 Description Image Paste and Upload

## Scope

Validate the IAM-87 description-editor enhancement in ticket create/edit flows:

- Paste image content from the clipboard into the Description editor
- Upload image files from the editor file picker
- Accept only supported image types: `png`, `jpg`, `jpeg`, `gif`, `webp`
- Insert returned image markdown at the active cursor position without corrupting surrounding markdown
- Preserve existing markdown preview/rendering and description autosave behavior
- Show clear, non-destructive error behavior for invalid file types, MIME/extension mismatch, oversize uploads, and upload failures

Out of scope:

- Drag-and-drop uploads
- Image resizing, compression, or progress-bar behavior beyond the existing uploading indicator
- File lifecycle cleanup after a ticket or image reference is deleted
- Non-image attachment markdown (`[name](url)`) because the current implementation only exposes image uploads

## Assumptions / Preconditions

- Frontend and backend are running and connected to the same environment
- The tester can create or edit a ticket description and reload the page
- Server upload storage is writable and `/uploads/<file>` URLs are publicly reachable from the app
- The description editor is the current `MarkdownEditor` used inside the ticket modal
- Max file size is `5 MB` server-side
- Error messages are surfaced inline in the modal via the existing save/error text area
- Clipboard image availability may vary by OS/app source; at minimum, a pasted screenshot or copied image that resolves to a browser `File` object is available for the clipboard scenarios

## Test Data

| ID | Data | Purpose | Notes |
|---|---|---|---|
| TD-01 | `[TEST] IAM-87 Upload Target` ticket | Stable record for repeated edit/reload validation | Use a non-production test ticket |
| TD-02 | `tiny-diagram.png` (<200 KB) | Baseline happy-path image upload | Clean ASCII filename |
| TD-03 | `photo.jpg` (~500 KB) | Supported `jpg` validation | Real JPEG content |
| TD-04 | `photo-alt.jpeg` (~500 KB) | Supported `jpeg` validation | Same content family, alternate extension |
| TD-05 | `demo.gif` (<1 MB) | Supported `gif` validation | Prefer a small animated GIF if available |
| TD-06 | `preview.webp` (<1 MB) | Supported `webp` validation | Confirm browser renderability |
| TD-07 | `oversized.png` (>5 MB) | Server-side oversize rejection | At least `5 MB + 1 byte` |
| TD-08 | `notes.txt` or `notes.pdf` | Invalid type rejection | Not image/* |
| TD-09 | `fake-image.png` with non-PNG MIME/body | MIME/extension mismatch rejection | Use request tampering or crafted fixture |
| TD-10 | Markdown seed text: `Alpha before\n\nBeta after` | Cursor-position insertion checks | Used to verify no text loss |
| TD-11 | Markdown seed block with heading, list, link, and code fence | Regression coverage for existing rendering | Example below |

Suggested markdown seed for TD-11:

````md
# Evidence

- first item
- second item

[Reference](https://example.com)

```ts
console.log('iam-87');
```
````

## Detailed Test Cases

| ID | Category | Description | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|---|
| IAM87-TC-01 | Happy Path | Paste clipboard image into an empty description | TD-01 exists; editor is in edit mode; clipboard contains a valid image | 1. Open TD-01 in edit mode. 2. Focus Description with an empty value. 3. Paste clipboard image. 4. Wait for upload to complete. 5. Close and reopen the modal. | Upload starts immediately, temporary uploading state appears, final markdown `![alt](/uploads/...)` replaces the placeholder, and the image persists after reopen. | ✅ Pass |
| IAM87-TC-02 | Happy Path | Paste clipboard image at a specific cursor position inside existing markdown | TD-01 contains TD-10 text; clipboard contains a valid image | 1. Place cursor between `Alpha before` and `Beta after`. 2. Paste image. 3. Let upload finish. | Returned markdown is inserted exactly at the caret position, `Alpha before` remains before it, `Beta after` remains after it, and no surrounding markdown is removed or duplicated. | ✅ Pass |
| IAM87-TC-03 | Happy Path | Upload image from the file picker into the description | TD-01 exists; editor is in edit mode | 1. Type TD-10 text. 2. Place cursor between the two paragraphs. 3. Click `Img`. 4. Select TD-02. 5. Wait for upload to complete. | OS file picker opens, file is accepted, uploading indicator appears, markdown is inserted at the cursor position, and surrounding text remains intact. | ✅ Pass |
| IAM87-TC-04 | Compatibility | Validate all supported image types via file picker | Edit mode is open | 1. Repeat TC-03 with TD-02, TD-03, TD-04, TD-05, and TD-06. 2. After each insert, switch out of edit mode or reopen the ticket. | Each supported file uploads successfully, returns image markdown, renders as an image in read/view mode, and remains accessible after reload. | ✅ Pass |
| IAM87-TC-05 | UX / State | Validate upload placeholder lifecycle during successful upload | Edit mode is open; TD-02 available | 1. Trigger upload. 2. Observe editor state while the request is in flight. 3. Inspect final description after completion. | A temporary uploading placeholder/status is visible only while the request is pending; it is fully replaced by the final markdown and is never saved as the final description. | ✅ Pass |
| IAM87-TC-06 | Edge Case | Upload multiple images sequentially in one edit session | Edit mode is open; TD-02 and TD-03 available | 1. Insert TD-02. 2. Move cursor to a different location. 3. Insert TD-03. 4. Close and reopen the modal. | Both images appear in the order inserted, each markdown block lands at its intended position, and the later upload does not overwrite or reorder the earlier one. | ✅ Pass |
| IAM87-TC-07 | Regression | Existing markdown rendering still works with uploaded images mixed into content | TD-11 content prepared; TD-02 available | 1. Populate description with TD-11. 2. Insert TD-02 between sections. 3. Exit edit mode. | Heading, bullet list, link, and code fence still render correctly, and the uploaded image renders inline without exposing raw markdown or breaking surrounding formatting. | ✅ Pass |
| IAM87-TC-08 | Regression | Upload completion still triggers autosave without clicking Save | TD-01 exists; edit mode is open | 1. Upload TD-02. 2. Do not click Save. 3. Wait for request completion. 4. Close modal or reload page. | Uploaded markdown persists after close/reload, proving autosave ran on upload completion. | ✅ Pass |
| IAM87-TC-09 | Regression | Blur-based autosave still works after image insertion and manual edits | TD-01 exists; TD-02 available | 1. Insert TD-02. 2. Add plain text before and after the image. 3. Click outside the editor to blur. 4. Reload page. | Both the uploaded image markdown and the manual text persist after reload; no duplicate save corruption or loss of adjacent text occurs. | ✅ Pass |
| IAM87-TC-10 | Negative | Invalid file type is rejected gracefully | Edit mode is open; TD-08 available | 1. Attempt to select TD-08 through the picker or bypass the `accept` filter using dev tools/test harness. 2. Observe the editor and modal state. | Upload is rejected, a clear error message is shown, no final markdown is inserted, no stale uploading placeholder remains, and existing description text is unchanged. | ✅ Pass |
| IAM87-TC-11 | Negative | MIME/extension mismatch is rejected | Edit mode is open; TD-09 available | 1. Submit TD-09 so the extension and content type do not match the server allowlist. 2. Observe UI response. | Server rejects the upload with unsupported-type behavior, UI surfaces the backend error, no image markdown is persisted, and editor remains usable. | ✅ Pass |
| IAM87-TC-12 | Negative | Oversized image is rejected at the 5 MB limit | Edit mode is open; TD-07 available | 1. Select TD-07. 2. Wait for the server response. | Upload is rejected with the 5 MB limit error, no final markdown is inserted, any temporary placeholder is removed, and previously typed description content remains intact. | ✅ Pass |
| IAM87-TC-13 | Negative | Non-image clipboard paste still behaves as normal text paste | Edit mode is open; clipboard contains plain text | 1. Copy plain text. 2. Paste into the description. | Text pastes normally, no upload is attempted, no upload error appears, and standard editor behavior is preserved. | ✅ Pass |
| IAM87-TC-14 | Negative | Upload failure or network interruption leaves the editor recoverable | Edit mode is open; TD-02 available; backend can be temporarily interrupted or request blocked | 1. Start an image upload. 2. Force the request to fail. 3. Continue typing in the description. 4. Retry with a valid image after recovery. | Failure message is shown, the failed placeholder is removed, the editor does not lock up, manual typing still works, and a later valid upload can succeed in the same session. | ✅ Pass |
| IAM87-TC-15 | Regression | View mode renders uploaded markdown as a safe image, not raw text | TD-01 contains at least one uploaded image markdown entry | 1. Leave edit mode or reopen the ticket in view mode. 2. Inspect the rendered description. | The image displays through markdown rendering, raw `![...]()` syntax is not shown in view mode, and no unsafe HTML rendering is introduced. | ✅ Pass |

## Negative Cases

Primary failure modes that must be covered before sign-off:

- Invalid file type rejected with a user-visible error and no content corruption: IAM87-TC-10
- MIME/extension mismatch rejected server-side: IAM87-TC-11
- Oversized upload rejected at `> 5 MB`: IAM87-TC-12
- Upload transport failure leaves no stuck placeholder and no broken editor state: IAM87-TC-14
- Plain-text paste remains plain-text paste and does not regress into false upload handling: IAM87-TC-13

## Regression Checks

Regression sign-off should explicitly confirm the following after at least one successful upload:

- Description autosave still persists changes triggered by upload completion and by blur: IAM87-TC-08, IAM87-TC-09
- Existing markdown preview/rendering still handles headings, lists, links, code blocks, and images together: IAM87-TC-07, IAM87-TC-15
- Cursor-based insertion does not corrupt pre-existing description text or markdown structure: IAM87-TC-02, IAM87-TC-03, IAM87-TC-06
- Error handling does not leave stale placeholders or broken edit sessions: IAM87-TC-10 through IAM87-TC-14
- Ticket close/reopen and page reload continue to show the latest saved description state after upload operations: IAM87-TC-01, IAM87-TC-04, IAM87-TC-08, IAM87-TC-09

## Exit Criteria

IAM-87 is ready for execution sign-off when:

1. All happy-path upload scenarios pass for clipboard paste and file-picker upload.
2. All supported file types listed in scope pass at least one end-to-end upload and render check.
3. Invalid type, MIME mismatch, oversize, and network-failure scenarios all show controlled error behavior without corrupting saved description content.
4. No regression is observed in markdown rendering, cursor-position insertion, or description autosave.

## Execution Results

Execution date: 2026-04-13

Environment used:

- Branch under test: latest PR #62 workspace state (`pr-62`)
- Frontend: Vite dev server at `http://127.0.0.1:5173`
- Backend: FastAPI via `uv run uvicorn main:app --host 127.0.0.1 --port 8000`
- Data: QC project `QC IAM-87` (`QC87`) with ticket `QC87-1`
- Upload fixtures: `.qc-fixtures/tiny-diagram.png`, `.qc-fixtures/photo.jpg`, `.qc-fixtures/photo-alt.jpeg`, `.qc-fixtures/demo.gif`, `.qc-fixtures/preview.webp`, `.qc-fixtures/notes.txt`, `.qc-fixtures/oversized.png`
- Automation: Playwright MCP for end-to-end UI coverage and `pytest server/tests/test_main.py -q` for backend regression coverage

Execution summary:

- Detailed plan cases executed: `15`
- Detailed plan cases passed: `15`
- Targeted backend regression tests executed: `7`
- Targeted backend regression tests passed: `7`
- Total executed: `22`
- Total passed: `22`
- Total failed: `0`

| Check ID | Area | Result | Notes |
|---|---|---|---|
| IAM87-EXEC-01 | Backend regression suite | ✅ Pass | `pytest server/tests/test_main.py -q` passed `7/7`, covering `/health`, `/mcp`, upload success, served upload retrieval, path resolution, invalid type rejection, and oversize rejection. |
| IAM87-EXEC-02 | Backend MIME/extension mismatch rejection | ✅ Pass | Direct browser `fetch` with `fake-image.png` + `text/plain` returned `400 Unsupported image type...`. |
| IAM87-EXEC-03 | Clipboard image paste | ✅ Pass | Synthetic clipboard-image paste inserted markdown, persisted it, and rendered the uploaded image in preview mode. |
| IAM87-EXEC-04 | Caret-position insertion | ✅ Pass | Clipboard paste and file-picker upload both inserted markdown at the active caret without corrupting surrounding content. |
| IAM87-EXEC-05 | Supported image types | ✅ Pass | `png`, `jpg`, `jpeg`, `gif`, and `webp` uploads all returned `201`, persisted markdown, and rendered as images in view mode. |
| IAM87-EXEC-06 | Upload placeholder lifecycle | ✅ Pass | Delayed upload showed `Uploading image...` only while the request was in flight and removed it after success. |
| IAM87-EXEC-07 | Sequential multi-upload flow | ✅ Pass | Two uploads in one edit session persisted in the order inserted without overwriting each other. |
| IAM87-EXEC-08 | Markdown rendering regression | ✅ Pass | Mixed content with heading, bullets, link, code fence, and uploaded image rendered correctly with no raw markdown leakage. |
| IAM87-EXEC-09 | Autosave after upload completion | ✅ Pass | Reload after upload preserved the inserted image markdown without pressing Save. |
| IAM87-EXEC-10 | Blur-based autosave after upload | ✅ Pass | Manual edits made after image insertion persisted across blur and reload with no save corruption. |
| IAM87-EXEC-11 | Invalid type handling | ✅ Pass | Selecting `notes.txt` surfaced a clear inline error, inserted no markdown, and left existing content untouched. |
| IAM87-EXEC-12 | Oversize handling | ✅ Pass | Selecting a `>5 MB` image surfaced the 5 MB limit error, inserted no markdown, and preserved existing content. |
| IAM87-EXEC-13 | Plain-text paste regression | ✅ Pass | Non-image paste remained plain text and did not trigger any upload request. |
| IAM87-EXEC-14 | Network failure recovery | ✅ Pass | Aborted upload surfaced `Failed to upload image: Network Error`, removed the failed placeholder, and allowed a later retry in the same session. |
| IAM87-EXEC-15 | View-mode safety | ✅ Pass | Uploaded markdown rendered as `<img>` in preview/view mode, not raw `![...]()` text, with safe markdown rendering still intact. |

Remaining bugs / blockers:

- None found on the latest PR #62 branch state during this rerun.

QC decision:

- IAM-87 is **QC-approved** on the current feature branch.
- Approval basis: full `15/15` test-plan coverage passed in the UI plus `7/7` targeted backend regression checks passed.