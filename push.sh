#!/usr/bin/env bash
set -e  # Exit on error
set -o pipefail

# --- Colors for better UX ---
RED="\033[0;31m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
NC="\033[0m" # No Color

echo -e "${CYAN}>>> Checking for Git repository...${NC}"

# --- Step 1: Check if current directory is a git repo ---
if [ ! -d ".git" ]; then
  echo -e "${YELLOW}No git repository found. Initializing a new one...${NC}"
  git init

  # Optionally ask for remote
  read -p "Enter remote repository URL (or leave blank to skip): " remote_url
  if [ -n "$remote_url" ]; then
    git remote add origin "$remote_url"
  fi
fi

# --- Step 2: Stage changes ---
echo -e "${CYAN}>>> Staging all changes...${NC}"
git add -A

# --- Step 3: Commit changes ---
read -p "Enter commit message (leave blank for default): " commit_msg
if [ -z "$commit_msg" ]; then
  commit_msg="update: $(date '+%Y-%m-%d %H:%M:%S')"
fi

git commit -m "$commit_msg" || echo -e "${YELLOW}No changes to commit.${NC}"

# --- Step 4: Push to remote ---
if git remote get-url origin >/dev/null 2>&1; then
  current_branch=$(git branch --show-current)

  if [ -z "$current_branch" ]; then
    current_branch="main"
    git checkout -b "$current_branch"
  fi

  echo -e "${CYAN}>>> Pushing to origin/${current_branch}...${NC}"
  git push -u origin "$current_branch"
else
  echo -e "${YELLOW}No remote repository configured.${NC}"
  echo "You can add one later with:"
  echo "  git remote add origin <url>"
  echo "Then rerun: push"
fi

echo -e "${GREEN}✔ Push complete.${NC}"

