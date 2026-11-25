# Questions

Model `grok-4.7`, reasoning effort `low`, fresh tab. Use only `ask_user`. The harness adds Other itself, so the model must not send an option whose label starts with "Other".

1. **note.** Choose Yes.
2. **option.** Choose Blue.
3. **other.** Choose Other and type `Lisbon`.
4. **five.** Choose the first option on every question: One, Three, Five, Seven, Nine.

Pass: the closing report quotes those answers, including `Lisbon`, and the model does not add a sixth question. A call with six questions would be rejected. This prompt stays inside the five-question cap.

```text
This is a harness check of ask_user only. Make the calls one at a time, in this order, and stop when the list is done. Use these arguments. Do not add a question. "other" and any labels that begin with "other" are reserved. When the last answer is back, reply with each label and the answer text you were given. Do not propose another call.

1. [note]
kind note. title "Probe note". message "A note still carries one question."
One question, id "seen", text "Did the note render?", options "Yes" (recommended) and "No".

2. [option]
kind question. title "Pick one".
One question, id "color", text "Which color?", options "Red" and "Blue".

3. [other]
kind question. title "Name a place".
One question, id "city", text "Which city?", options "Paris" and "Rome".

4. [five]
kind question. title "Five checks".
Five questions, ids "q1" through "q5":
q1 "First pair?" options "One" and "Two"
q2 "Second pair?" options "Three" and "Four"
q3 "Third pair?" options "Five" and "Six"
q4 "Fourth pair?" options "Seven" and "Eight"
q5 "Fifth pair?" options "Nine" and "Ten"
```
