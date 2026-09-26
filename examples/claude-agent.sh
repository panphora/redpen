#!/bin/bash
REQUEST=$(cat)
OUT=$(mktemp)
claude --permission-mode acceptEdits -p "The file at $HTMLCLAY_WIRE_FILE is an HTML page I have open on my screen.
I left a review comment on it with the redpen review tool. Here is the request, as JSON: $REQUEST
My words are in payload.said. payload.item and payload.region say which part of the page the comment is about, and payload.thread holds any earlier messages about it.
If the comment asks for a change, make it by editing that file directly. Leave everything else in the file exactly as it is, and do not create any other files.
End with one or two plain sentences telling me what you changed, or answering my question." > "$OUT" 2>/dev/null &
agent=$!
while kill -0 "$agent" 2>/dev/null; do
  echo "thinking"
  sleep 5
done
wait "$agent"
status=$?
python3 -c 'import json, sys; print(json.dumps({"redpen": 1, "reply": sys.stdin.read().strip()[-3000:] or "Done."}))' < "$OUT"
rm -f "$OUT"
exit $status
