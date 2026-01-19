#!/bin/bash
# Task Delegation Script for CSRF Protection Review Fixes
# Usage: ./delegate-tasks.sh [priority]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASKS_DIR="$SCRIPT_DIR/tasks"

echo "=========================================="
echo "Task Delegation for CSRF Review Fixes"
echo "=========================================="
echo ""

case "$1" in
  1)
    echo "Delegating Priority 1: SameSite属性の修正"
    cat "$TASKS_DIR/priority-1-samesite-fix.md"
    echo ""
    echo "Please implement the changes above."
    ;;
  2)
    echo "Delegating Priority 2: HttpOnly Cookieパターンへの移行"
    cat "$TASKS_DIR/priority-2-httponly-cookie-migration.md"
    echo ""
    echo "Please implement the changes above."
    ;;
  3)
    echo "Delegating Priority 3: 楽観的ロックの実装"
    cat "$TASKS_DIR/priority-3-optimistic-locking.md"
    echo ""
    echo "Please implement the changes above."
    ;;
  4)
    echo "Delegating Priority 4: エラーハンドリングの改善"
    cat "$TASKS_DIR/priority-4-error-handling.md"
    echo ""
    echo "Please implement the changes above."
    ;;
  all)
    echo "Delegating all tasks in priority order..."
    echo ""
    for i in 1 2 3 4; do
      echo "=========================================="
      echo "Priority $i"
      echo "=========================================="
      "$0" "$i"
      echo ""
    done
    ;;
  *)
    echo "Usage: $0 [1|2|3|4|all]"
    echo ""
    echo "Options:"
    echo "  1   - Priority 1: SameSite属性の修正"
    echo "  2   - Priority 2: HttpOnly Cookieパターンへの移行"
    echo "  3   - Priority 3: 楽観的ロックの実装"
    echo "  4   - Priority 4: エラーハンドリングの改善"
    echo "  all - Execute all tasks in priority order"
    exit 1
    ;;
esac
