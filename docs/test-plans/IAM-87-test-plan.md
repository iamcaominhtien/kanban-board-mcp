---
title: "Test Plan: IAM-87 Fix Image Upload and Paste Overflow in MarkdownEditor"
type: test
status: review
ticket: IAM-87
version: 1.0.1
created: 2026-04-13
updated: 2026-04-14
authors: [GitHub Copilot]
related:
  - docs/specs/iam-87-description-upload.md
---

# Test Plan: IAM-87 Fix Image Upload and Paste Overflow in MarkdownEditor

## Scope

This test plan validates the IAM-87 fixes in `MarkdownEditor` for:

- Image upload via the toolbar file picker while the editor must remain mounted
- Image rendering behavior inside the description view area after paste/upload
- Regression coverage for standard markdown authoring and toolbar actions

Out of scope:

- Backend file validation beyond confirming the UI flow succeeds for valid image files
- Drag-and-drop upload behavior
- Cross-browser compatibility beyond the target browser used for QA

## Preconditions

- The UI is running and the tester can open a ticket with an editable Description field
- A test ticket exists and can be safely edited
- The image upload endpoint is available
- The tester has the following fixtures ready:
  - `small-image.png` or equivalent image that is visibly smaller than the description container
  - `large-wide-image.png` or equivalent image wide enough to overflow without responsive styling

## Execution Notes

- Use a dedicated test ticket or test content prefixed with `[TEST] IAM-87`
- For visual checks, verify both the editor behavior and the rendered description state
- For overflow checks, verify there is no horizontal scrollbar caused by the image in the description container

## Test Cases

| Test ID | Description | Steps | Expected Result | Result |
|---|---|---|---|---|
| IAM87-TC-01 | Happy path: upload an image through the toolbar file picker | 1. Open a ticket and enter Description edit mode.<br>2. Type baseline text before and after the intended insertion point.<br>3. Place the caret between the two text blocks.<br>4. Click the `Img` toolbar button.<br>5. In the OS file picker, choose `small-image.png`.<br>6. Wait for upload to complete.<br>7. Exit edit mode and view the rendered description. | The editor stays mounted after the OS file picker opens and closes.<br>The upload succeeds and inserts image markdown at the caret position.<br>The surrounding text remains unchanged.<br>The rendered description shows the uploaded image correctly. | Pass<br>Editor remained mounted; upload inserted markdown and rendered one image in view mode. |
| IAM87-TC-02 | Cancel the file picker without selecting a file | 1. Open a ticket and enter Description edit mode.<br>2. Enter some text in the description.<br>3. Click the `Img` toolbar button.<br>4. Cancel the OS file picker without selecting a file.<br>5. Continue typing in the editor and then exit edit mode. | Cancelling the file picker does not collapse or break the editor.<br>No image markdown is inserted.<br>Existing text remains intact and the editor continues to accept input normally. | Pass<br>Simulated cancel in headless mode by returning focus without selecting a file; no image markdown was inserted and typing continued normally. |
| IAM87-TC-03 | Rapidly click the upload button multiple times | 1. Open Description edit mode.<br>2. Rapidly click the `Img` toolbar button multiple times before the file picker interaction completes.<br>3. Select one valid image file if a picker is shown.<br>4. Observe editor state during and after the interaction. | The editor remains stable.<br>Only one upload flow is effectively processed for the chosen file.<br>No duplicate placeholders or duplicate image insertions appear.<br>The editor does not exit unexpectedly. | Pass<br>The guard allowed one effective file-input invocation and one rendered image insertion. |
| IAM87-TC-04 | Paste a small image into the description | 1. Copy a small image to the clipboard.<br>2. Open Description edit mode and place the caret in the desired location.<br>3. Paste the image.<br>4. Wait for upload/insert behavior to complete.<br>5. Exit edit mode. | The pasted image is inserted successfully.<br>The rendered image appears at a natural size without distortion.<br>No horizontal overflow or scrollbar is introduced by the image. | Pass<br>Rendered width stayed at natural size (`40px / 40px`) and no horizontal overflow was observed. |
| IAM87-TC-05 | Paste a large or wide image and verify responsive scaling | 1. Copy a large or wide image to the clipboard.<br>2. Open Description edit mode and paste the image.<br>3. Exit edit mode after the image is rendered.<br>4. Inspect the description container width and scroll behavior. | The image renders within the description container bounds.<br>The image scales down to fit the available width.<br>No horizontal overflow or horizontal scrollbar appears because of the image. | Pass<br>Rendered width scaled down to fit the container (`572px / 2400px`) with no horizontal overflow. |
| IAM87-TC-06 | Paste an image while the description container is narrow | 1. Reduce the available content width by using a narrow viewport or narrow ticket layout.<br>2. Open Description edit mode.<br>3. Paste a large or wide image.<br>4. Exit edit mode and inspect the rendered description. | The image still scales to the narrower container width.<br>The description remains readable and usable.<br>No horizontal overflow or layout break occurs in the narrow state. | Pass<br>At narrow viewport width the image scaled to `516px / 2400px`; neither the container nor dialog overflowed horizontally. |
| IAM87-TC-07 | Regression: plain markdown text editing still works | 1. Open Description edit mode.<br>2. Enter plain text across multiple lines.<br>3. Move the caret, add text at the beginning, middle, and end.<br>4. Exit and re-enter edit mode if needed. | Plain text editing behavior is unchanged.<br>Caret placement and text updates work normally.<br>No unexpected collapse, lost text, or broken editing flow occurs. | Pass<br>Beginning, middle, end, and multiline edits persisted after save/reopen. |
| IAM87-TC-08 | Regression: text formatting toolbar buttons still work | 1. Open Description edit mode.<br>2. Use toolbar buttons such as `B`, `I`, `H1`, `UL`, and link insertion on sample text.<br>3. Confirm the markdown syntax is inserted in the editor.<br>4. Exit edit mode to inspect rendered output. | Toolbar actions still insert the expected markdown syntax.<br>The rendered description reflects the formatting correctly.<br>The upload-related fix does not break other toolbar actions. | Pass<br>`B`, `I`, `H1`, `UL`, and link insertion all produced the expected markdown syntax when exercised through the component's `mousedown` interaction path, and the rendered output was correct. |
| IAM87-TC-09 | Regression: mixed content editing with image plus markdown formatting | 1. Open Description edit mode.<br>2. Add formatted text using toolbar controls.<br>3. Upload or paste an image between formatted sections.<br>4. Add more text after the image.<br>5. Exit edit mode and inspect the final rendered content. | Formatted text before and after the image remains intact.<br>The image is inserted in the intended location.<br>The rendered description shows correct ordering, formatting, and image display without overflow. | Pass<br>Bold text, pasted image, and trailing text rendered in the expected order without overflow. |

## Exit Criteria

- All IAM87 test cases above execute without blocker-level issues
- Image upload via file picker is stable, including cancel and rapid interaction scenarios
- Pasted images render responsively in normal and narrow container widths
- Existing markdown editing and toolbar formatting behavior show no regression