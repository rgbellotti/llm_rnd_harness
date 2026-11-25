# Shell dialogs

Model `grok-4.7`, reasoning effort `low`, fresh tab. Accept a call only after the check named below.

1. **mkdir.** Accept. This creates `work_directory/prompt_probe/`. Later `cat` calls need that directory.
2. **word diff.** Edit Command. Change `Mar` to `March`. The line is a quiet red, then a quiet green, with the full color on `Mar` and `March`. Add the note `changed Mar to March`. Run command.
3. **character diff.** Edit Command. Change `beta` to `BETA`. The line has no spaces, so the full color is those letters, inside a quiet line. Run command. The output should contain `BETA`.
4. **timeout and review.** The dialog shows 30 seconds. Set the limit to none. Accept. In the output review, delete the line `delete this line in review`, then Approve & submit content.
5. **new file.** The file panel is all inserts and says the file does not exist yet. Accept.
6. **rewrite.** The file panel removes `beta two` and adds `beta TWO`. Accept.
7. **append.** The earlier lines stay and `appended line` is an insert. Accept.
8. **tee.** The path contains a space. The panel shows a new-file diff. Accept. The result prints `hello from tee`.
9. **plain redirect.** No file panel. Alternate Tool Call: `skipped plain redirect`.
10. **unquoted heredoc.** No file panel. Alternate Tool Call: `skipped unquoted heredoc`.

Pass: the file panel appears only on the quoted `cat` and `tee` calls, and `work_directory/prompt_probe/notes.txt` exists only after those accepts.

```text
This is a harness check of run_cmd only. Make the calls one at a time, in this order, and stop when the list is done. Copy each command exactly. Do not wrap a command in bash -lc or sudo. Put the bracketed label in the task field. Do not read harness.db, harness-keys, or secret values. When the last result is back, reply with each label and the text you were given. Do not propose another command.

1. [mkdir]
mkdir -p work_directory/prompt_probe

2. [word diff]
printf '%s\n' 'The location is Ohio.' 'The date is Mar 10.' 'The theme is Spring.'

3. [character diff]
printf beta&&printf gamma

4. [timeout and review]
Set timeout to 30s.
printf '%s\n' 'keep this line' 'delete this line in review' 'keep this line too'

5. [new file]
cat > work_directory/prompt_probe/notes.txt << 'EOF'
alpha one
beta two
gamma three
EOF

6. [rewrite]
cat > work_directory/prompt_probe/notes.txt << 'EOF'
alpha one
beta TWO
gamma three
EOF

7. [append]
cat >> work_directory/prompt_probe/notes.txt << 'EOF'
appended line
EOF

8. [tee]
tee 'work_directory/prompt_probe/my file.txt' << 'EOF'
hello from tee
EOF

9. [plain redirect]
echo hi > work_directory/prompt_probe/skip.txt

10. [unquoted heredoc]
cat > work_directory/prompt_probe/plain.txt << EOF
hello
EOF
```
