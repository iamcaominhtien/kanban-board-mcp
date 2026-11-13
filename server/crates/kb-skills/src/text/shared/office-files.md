# Office files: Excel, Word, PDF (and looking at a deck)

A file you hand in is opened by a person in Excel, Word or PowerPoint. It has to work there and read well there, and
you have to have seen it, not assumed it.

## Make it with a library, from code you keep
Write a small script in your working folder that builds the file, so a fix is one edit and one run. Python:
`openpyxl` (Excel), `python-docx` (Word), `python-pptx` (PowerPoint), `reportlab` or HTML printed to PDF (PDF). Install
them in the project's environment if they are missing, and say so.

## Look at it before you hand it in
You cannot judge a file you have not seen. Render every sheet, page or slide to an image, open each one, fix what you
see and render again. Use the first way the machine has (check with `command -v`, `ls /Applications`, `Get-Command`):
1. **LibreOffice** (macOS, Windows, Linux): `soffice --headless --convert-to pdf --outdir out file.pptx` (the same for
   .xlsx and .docx; it recalculates formulas). On a Mac it is often only in
   `/Applications/LibreOffice.app/Contents/MacOS/soffice`.
2. **Microsoft Office**, the app the reader will open, driven from a script (no one has to click):
   - Windows, PowerShell: `$a = New-Object -ComObject PowerPoint.Application; $p = $a.Presentations.Open($in, $true,
     $false, $false); $p.SaveAs($outDir, 18); $p.Close(); $a.Quit()` saves one PNG per slide (32 saves a PDF). Excel:
     `$wb = $x.Workbooks.Open($in); $wb.ExportAsFixedFormat(0, $pdf)`; Word: `$d.SaveAs2($pdf, 17)`. Use full paths,
     close and quit the app at the end.
   - macOS, `osascript`: PowerPoint `save active presentation in POSIX file "/full/out" as save as PNG` (or
     `as save as PDF`); Word and Excel save as PDF the same way. Office on a Mac may show a dialog asking for access to
     the folder, which no one sees: give the command a time limit (60 s) and go to the next way if it does not finish.
3. **macOS without either**: `qlmanage -t -s 1600 -o out file.pptx` (Quick Look, on every Mac) gives an image of the
   first slide or page only: enough for the look, not for the whole file.
4. **No app at all**: an approximation from code, said to be one. Excel: compute the formulas in Python (`formulas`)
   and check no cell gives `#REF!`, `#VALUE!` or `#DIV/0!`, then write each sheet as an HTML table with its number
   formats and screenshot it. Word: HTML with `mammoth`, then a screenshot. There is no code that draws a .pptx the way
   PowerPoint does: for a deck go to 5.
5. **Still not seen** (a deck with no app): ask with `ai_run(action='ask')` whether to install LibreOffice, with the
   command (`brew install --cask libreoffice`, `winget install TheDocumentFoundation.LibreOffice`,
   `sudo apt install libreoffice`); installing software on the person's machine is their call. If they say no, hand in
   and say plainly that the file was not looked at.

The `slides` skill's `scripts/render.py FILE --out DIR` does 1 to 3 in one command and says which way it used.
A PDF becomes images with `pdftoppm -png -r 80 out/file.pdf out/page` (poppler) or, where poppler is missing, PyMuPDF
(`pip install pymupdf`; `page.get_pixmap(dpi=80).save(...)`). In the report, say how you looked (LibreOffice,
PowerPoint, Quick Look, an HTML approximation): only an image from LibreOffice or Office counts as "looked at in the
app". Never hand in a screenshot of something else.

## Excel
- **Formulas, not typed results**: `=SUM(B2:B31)`, so the sheet still works when a number changes. Recalculate it
  before you look (LibreOffice recalculates on conversion) and check no cell shows `#REF!`, `#VALUE!` or `#DIV/0!`.
- Numbers as numbers with a format (thousands separator, decimals, dates, %), never as text, in the reader's
  format: for a Vietnamese reader `1.250` and `3,5` and `02/11/2026`, on the sheet, on chart axes and in the slides alike.
- A header row that is bold and frozen, columns wide enough for their content, one table per sheet, sheet names that
  say what is in them. Inputs, calculations and outputs kept apart, inputs marked.
- A chart only when it answers a question; its title says the answer.

## Word and PDF
- Real styles (Title, Heading 1, 2, Normal), not bold text made to look like a heading, so the outline and the table
  of contents work.
- Tables with a header row, numbers right-aligned, page numbers, margins that leave room.

## PowerPoint
A deck is its own craft: open the `slides` skill (the story, themes, the person's own template, pictures, and scripts
that build and render a .pptx).

## Hand it in
Attach the file and the rendered images (or the first pages) to the ticket or Docs page, and say what you checked.
