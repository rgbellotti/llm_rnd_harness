# PDF

Model `grok-4.7`, reasoning effort `low`, fresh tab. Needs `pdfinfo` and `pdftotext`, and a PDF already in the workspace. This checkout has no sample PDF. If the model stops because none is present, that is a pass for this file. Do not download one during the session.

1. **info.** Accept. Metadata comes back without a review dialog.
2. **page.** Accept. The review dialog opens. Delete one line of the extracted text, then Approve & submit content.

Pass: info has no review stage, and the page read returns only the trimmed text.

```text
This is a harness check of read_pdf only. If there is no PDF file already in the workspace, say so and stop. Do not download a PDF and do not create one.

Otherwise make two calls, in order, against the smallest PDF you can name from the workspace. Then stop.

1. [info]
read_pdf with that path and mode "info".

2. [page]
read_pdf with that path, pages "1", layout "reading", mode "text".

When the last result is back, reply with each label and the text you were given. Do not propose another call.
```
