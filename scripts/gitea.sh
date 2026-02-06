#!/bin/bash
# Gitea CLI helper for Claude Code sessions
# Usage: ./scripts/gitea.sh <command> [args]
#
# Commands:
#   issues                  List open issues (compact)
#   issues all              List all issues including closed
#   issue <id>              Get issue details
#   issue-create <title> <body> [labels] [milestone]
#   issue-update <id> <state|labels|milestone> <value>
#   issue-comment <id> <body>
#   labels                  List all labels
#   label-create <name> <color> [description]
#   milestones              List milestones
#   milestone-create <title> [description]
#   search <query>          Search issues

set -euo pipefail

# Load .env from project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -f "$ENV_FILE" ]]; then
  export $(grep -v '^#' "$ENV_FILE" | tr -d '\r' | xargs)
fi

: "${GITEA_URL:?Set GITEA_URL in .env}"
: "${GITEA_TOKEN:?Set GITEA_TOKEN in .env}"
: "${GITEA_OWNER:?Set GITEA_OWNER in .env}"
: "${GITEA_REPO:?Set GITEA_REPO in .env}"

API="$GITEA_URL/api/v1/repos/$GITEA_OWNER/$GITEA_REPO"
AUTH="Authorization: token $GITEA_TOKEN"

# Compact JSON formatter - extracts just the useful fields
fmt_issues() {
  python -c "
import json,sys
data=json.load(sys.stdin)
if not data: print('No issues found'); sys.exit()
for i in data:
  labels=', '.join(l['name'] for l in i.get('labels',[]))
  ms=i.get('milestone',{})
  ms_name=ms['title'] if ms else ''
  state=i['state']
  print(f\"#{i['number']} [{state}] {i['title']}\")
  parts=[]
  if labels: parts.append(f'labels: {labels}')
  if ms_name: parts.append(f'milestone: {ms_name}')
  if parts: print(f\"   {' | '.join(parts)}\")
"
}

fmt_issue() {
  python -c "
import json,sys
i=json.load(sys.stdin)
labels=', '.join(l['name'] for l in i.get('labels',[]))
ms=i.get('milestone',{})
ms_name=ms['title'] if ms else ''
print(f\"#{i['number']} [{i['state']}] {i['title']}\")
parts=[]
if labels: parts.append(f'labels: {labels}')
if ms_name: parts.append(f'milestone: {ms_name}')
if parts: print(' | '.join(parts))
if i.get('body'): print(); print(i['body'])
"
}

fmt_labels() {
  python -c "
import json,sys
data=json.load(sys.stdin)
if not data: print('No labels'); sys.exit()
for l in data:
  desc=l.get('description','')
  print(f\"  {l['name']} (#{l['color']}){' - '+desc if desc else ''}\")
"
}

fmt_milestones() {
  python -c "
import json,sys
data=json.load(sys.stdin)
if not data: print('No milestones'); sys.exit()
for m in data:
  print(f\"  {m['title']} [open:{m['open_issues']}/closed:{m['closed_issues']}]{' - '+m['description'] if m.get('description') else ''}\")
"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  issues)
    state="${1:-open}"
    if [[ "$state" == "all" ]]; then
      curl -s -H "$AUTH" "$API/issues?state=all&type=issues&limit=50" | fmt_issues
    else
      curl -s -H "$AUTH" "$API/issues?state=open&type=issues&limit=50" | fmt_issues
    fi
    ;;

  issue)
    id="${1:?Usage: gitea.sh issue <id>}"
    curl -s -H "$AUTH" "$API/issues/$id" | fmt_issue
    ;;

  issue-create)
    title="${1:?Usage: gitea.sh issue-create <title> <body> [labels] [milestone]}"
    body="${2:-}"
    labels="${3:-}"
    milestone="${4:-}"
    payload="{\"title\":$(python -c "import json; print(json.dumps('$title'))")}"
    # Build JSON payload with python for safety
    python -c "
import json,sys
p={'title':'''$title'''}
body='''$body'''
if body: p['body']=body
labels='$labels'
if labels: p['labels']=[int(x) for x in labels.split(',')]
ms='$milestone'
if ms: p['milestone']=int(ms)
print(json.dumps(p))
" | curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d @- "$API/issues" | fmt_issue
    ;;

  issue-update)
    id="${1:?Usage: gitea.sh issue-update <id> <state|labels|milestone> <value>}"
    field="${2:?Specify field: state, labels, milestone}"
    value="${3:?Specify value}"
    case "$field" in
      state)
        curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
          -d "{\"state\":\"$value\"}" "$API/issues/$id" | fmt_issue
        ;;
      labels)
        # Replace all labels. Value is comma-separated label IDs
        python -c "
import json
ids=[int(x) for x in '$value'.split(',')]
print(json.dumps({'labels':ids}))
" | curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" -d @- "$API/issues/$id" | fmt_issue
        ;;
      milestone)
        curl -s -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
          -d "{\"milestone\":$value}" "$API/issues/$id" | fmt_issue
        ;;
    esac
    ;;

  issue-comment)
    id="${1:?Usage: gitea.sh issue-comment <id> <body>}"
    body="${2:?Specify comment body}"
    python -c "import json; print(json.dumps({'body':'''$body'''}))" | \
      curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d @- "$API/issues/$id/comments" > /dev/null
    echo "Comment added to #$id"
    ;;

  labels)
    curl -s -H "$AUTH" "$API/labels" | fmt_labels
    ;;

  label-create)
    name="${1:?Usage: gitea.sh label-create <name> <color> [description]}"
    color="${2:?Specify color hex (no #)}"
    desc="${3:-}"
    python -c "
import json
p={'name':'$name','color':'#$color'}
if '$desc': p['description']='$desc'
print(json.dumps(p))
" | curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d @- "$API/labels" > /dev/null
    echo "Created label: $name"
    ;;

  milestones)
    curl -s -H "$AUTH" "$API/milestones" | fmt_milestones
    ;;

  milestone-create)
    title="${1:?Usage: gitea.sh milestone-create <title> [description]}"
    desc="${2:-}"
    python -c "
import json
p={'title':'$title'}
if '$desc': p['description']='$desc'
print(json.dumps(p))
" | curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d @- "$API/milestones" > /dev/null
    echo "Created milestone: $title"
    ;;

  search)
    query="${1:?Usage: gitea.sh search <query>}"
    curl -s -H "$AUTH" "$API/issues?state=all&type=issues&q=$(python -c "import urllib.parse; print(urllib.parse.quote('$query'))")&limit=20" | fmt_issues
    ;;

  help|*)
    echo "Usage: ./scripts/gitea.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  issues [all]              List open (or all) issues"
    echo "  issue <id>                Get issue details"
    echo "  issue-create <t> <b> [l] [m]  Create issue"
    echo "  issue-update <id> <f> <v> Update issue field"
    echo "  issue-comment <id> <body> Add comment"
    echo "  labels                    List labels"
    echo "  label-create <n> <c> [d]  Create label"
    echo "  milestones                List milestones"
    echo "  milestone-create <t> [d]  Create milestone"
    echo "  search <query>            Search issues"
    ;;
esac
