#!/bin/bash
# macOS-compatible scaffold tester (no GNU dependencies)
# Tests all 5 framework scaffolds + verifies init-project.js creates correct config

cd ~/Developer
mkdir -p llm-test-scaffolds
cd llm-test-scaffolds
rm -rf * test-results.log 2>/dev/null
touch test-results.log

# Force non-interactive mode for all CLIs
export CI=1

PASS=0
FAIL=0

echo "🧪 Starting scaffold tests..." | tee -a test-results.log

for fw in nextjs laravel wordpress vite tsjs; do
  echo "" | tee -a test-results.log
  echo "📁 Testing: $fw" | tee -a test-results.log
  mkdir -p "$fw-test"
  cd "$fw-test"
  git init -q

  case $fw in
    nextjs)
      echo "⏳ Setting up Next.js..." | tee -a ../test-results.log
      npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes 2>&1 | tee -a ../test-results.log
      ;;
    laravel)
      echo "⏳ Setting up Laravel..." | tee -a ../test-results.log
      composer create-project laravel/laravel . --no-interaction --no-install 2>&1 | tee -a ../test-results.log
      ;;
    wordpress)
      echo "⏳ Setting up WordPress structure..." | tee -a ../test-results.log
      mkdir -p wp-content/plugins/test-wp
      echo '<?php /** Plugin Name: Test WP Plugin */' > wp-content/plugins/test-wp/test.php
      echo "✅ WP structure created" | tee -a ../test-results.log
      ;;
    vite)
      echo "⏳ Setting up Vite..." | tee -a ../test-results.log
      npm create vite@latest . -- --template react-ts --yes 2>&1 | tee -a ../test-results.log
      ;;
    tsjs)
      echo "⏳ Setting up plain TS/JS..." | tee -a ../test-results.log
      npm init -y 2>&1 | tee -a ../test-results.log
      ;;
  esac

  echo "🔧 Running llm-init-project on $fw..." | tee -a ../test-results.log
  node ~/Developer/llm-tasks/scripts/init-project.js 2>&1 | tee -a ../test-results.log

  # Verify outputs
  ERRORS=""

  # Check .vscode/tasks.json exists and has all 4 modes
  if [ -f .vscode/tasks.json ]; then
    for mode in "Code Review" "Security Audit" "Generate Tests" "Generate Docs"; do
      if ! grep -q "$mode" .vscode/tasks.json; then
        ERRORS="$ERRORS\n  ❌ Missing VS Code task: $mode"
      fi
    done
  else
    ERRORS="$ERRORS\n  ❌ .vscode/tasks.json not created"
  fi

  # Check .husky/pre-commit exists
  if [ ! -f .husky/pre-commit ]; then
    ERRORS="$ERRORS\n  ❌ .husky/pre-commit not created"
  fi

  # Check *.llm-draft in .gitignore
  if [ -f .gitignore ]; then
    if ! grep -q '\.llm-draft' .gitignore; then
      ERRORS="$ERRORS\n  ❌ *.llm-draft not in .gitignore"
    fi
  else
    ERRORS="$ERRORS\n  ❌ .gitignore not found"
  fi

  # Check package.json has "type": "module"
  if ! grep -q '"type": "module"' package.json; then
    ERRORS="$ERRORS\n  ❌ package.json missing type:module"
  fi

  if [ -z "$ERRORS" ]; then
    echo "✅ $fw — ALL CHECKS PASSED" | tee -a ../test-results.log
    PASS=$((PASS + 1))
  else
    echo "⚠️  $fw — ISSUES FOUND:" | tee -a ../test-results.log
    echo -e "$ERRORS" | tee -a ../test-results.log
    FAIL=$((FAIL + 1))
  fi

  echo "----------------------------------------" | tee -a ../test-results.log
  cd ..
done

echo "" | tee -a test-results.log
echo "📊 Results: $PASS passed, $FAIL failed out of 5 frameworks" | tee -a test-results.log
echo "📊 Full results in $(pwd)/test-results.log"
echo "🧹 Cleanup: rm -rf ~/Developer/llm-test-scaffolds"
