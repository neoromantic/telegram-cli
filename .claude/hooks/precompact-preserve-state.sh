#!/bin/bash
# PreCompact hook: Preserves state before context compaction
# This hook updates CLAUDE.md and progress.md with session state

set -euo pipefail

INPUT=$(cat)
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Create log directory if needed
mkdir -p "$PROJECT_DIR/.claude"

# Log compaction event
LOG_FILE="$PROJECT_DIR/.claude/compaction.log"
echo "[$TIMESTAMP] Compaction triggered: $TRIGGER" >> "$LOG_FILE"

# Count messages if transcript exists
MESSAGE_COUNT="unknown"
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  MESSAGE_COUNT=$(wc -l < "$TRANSCRIPT_PATH" | tr -d ' ')
fi

# Update progress.md with checkpoint
if [ -f "$PROJECT_DIR/progress.md" ]; then
  cat >> "$PROJECT_DIR/progress.md" << EOF

---

### Compaction Checkpoint - $TIMESTAMP
- Trigger: $TRIGGER
- Messages processed: $MESSAGE_COUNT
- Review tasks above and continue from last incomplete item

EOF
fi

# Update CLAUDE.md with session marker (only if it exists and has our format)
if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
  # Check if there's already a "Last updated" line and update it
  if grep -q "^\*Last updated:" "$PROJECT_DIR/CLAUDE.md"; then
    sed -i '' "s/^\*Last updated:.*/*Last updated: $TIMESTAMP (post-compaction)*/" "$PROJECT_DIR/CLAUDE.md" 2>/dev/null || true
  fi
fi

exit 0
