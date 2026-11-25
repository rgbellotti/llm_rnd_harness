#!/bin/sh
# Runs every frontend test file. Each *.test.js is a standalone Node
# script with its own fake DOM; the runner just executes them all and
# reports one line per file. Exit status is non-zero if any file fails.
#
# Testing contract for these files: assert behavior and data, never
# display wording. The UI's sentences are surface the operator rewords
# freely, so a test that matches a label or a help sentence breaks on
# edits that change nothing functional. Text assertions are legitimate
# only where the text IS the function: data the model or a fixture sent
# (commands, tasks, preview text), protocol tokens the model reads
# (<user_comment>, ==== markers), and security markers (the CLOUD
# badge). If a test needs wording to pass, it is testing the wrong
# thing.
#
# Usage, from anywhere:
#   web/js/run_tests.sh
#
# The files are self-contained (no package.json, no bundler). They must
# run from this directory: several of them read sibling sources.
set -u
cd "$(dirname "$0")"

status=0
for test in *.test.js; do
    printf '== %s ' "$test"
    if node "$test" > /dev/null 2>&1; then
        echo "ok"
    else
        echo "FAILED (run: node $test)"
        status=1
    fi
done
exit $status
