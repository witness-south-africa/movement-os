"""Read-only, current-state intake for movement-os governance work."""

import argparse
import json
from pathlib import Path
import subprocess
import sys


REPO = "witness-south-africa/movement-os"


def read_command(*args, cwd=None):
    return subprocess.run(args, check=True, capture_output=True, text=True,
                          timeout=30, cwd=cwd).stdout.rstrip("\n")


def read_json(*args, cwd=None):
    return json.loads(read_command(*args, cwd=cwd))


def review_threads(number):
    query = """
    query($number: Int!, $cursor: String) {
      repository(owner: "witness-south-africa", name: "movement-os") {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            nodes { id isResolved isOutdated }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
    """
    nodes = []
    cursor = None
    while True:
        args = ["gh", "api", "graphql", "-f", f"query={query}",
                "-F", f"number={number}"]
        if cursor:
            args += ["-f", f"cursor={cursor}"]
        result = read_json(*args)
        if result.get("errors"):
            raise ValueError("GitHub could not read review threads")
        page = result["data"]["repository"]["pullRequest"]["reviewThreads"]
        nodes.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            return nodes
        cursor = page["pageInfo"]["endCursor"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--issue", type=int)
    target.add_argument("--pr", type=int)
    parser.add_argument("--discussion", action="store_true",
                        help="Include all PR comment and review pages")
    parser.add_argument("--worktree", type=Path, default=Path.cwd())
    args = parser.parse_args()
    if args.discussion and not args.pr:
        parser.error("--discussion requires --pr")
    worktree = read_command("git", "-C", str(args.worktree), "rev-parse", "--show-toplevel")
    actual_repo = read_json("gh", "repo", "view", "--json", "nameWithOwner", cwd=worktree)
    # Resolve the selected checkout's remote, then pin every GitHub query.
    if actual_repo["nameWithOwner"] != REPO:
        raise ValueError(f"Expected repository {REPO}")
    git = ["git", "-C", worktree]
    live_main = read_json("gh", "api", f"repos/{REPO}/git/ref/heads/main")["object"]["sha"]
    result = {
        "repository": REPO,
        "worktree": worktree,
        "branch": read_command(*git, "branch", "--show-current"),
        "head": read_command(*git, "rev-parse", "HEAD"),
        "local_origin_main": read_command(*git, "rev-parse", "origin/main"),
        "live_main": live_main,
        "worktree_status": read_command(*git, "status", "--porcelain=v1"),
    }
    if args.issue:
        result["issue"] = read_json("gh", "issue", "view", str(args.issue), "--repo", REPO,
                                    "--json", "number,title,state,body,url")
    if args.pr:
        fields = "number,title,body,state,url,baseRefName,baseRefOid,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,files"
        pr = read_json("gh", "pr", "view", str(args.pr), "--repo", REPO, "--json", fields)
        pr["review_threads"] = review_threads(args.pr)
        if args.discussion:
            for field, endpoint in (("comments", "issues"), ("reviews", "pulls")):
                pages = read_json("gh", "api", "--paginate", "--slurp",
                                  f"repos/{REPO}/{endpoint}/{args.pr}/{field}?per_page=100")
                pr[field] = [item for page in pages for item in page]
        # Reading checks and threads takes multiple requests; reject a mixed-head snapshot.
        refreshed_head = read_json("gh", "pr", "view", str(args.pr), "--repo", REPO,
                                  "--json", "headRefOid")["headRefOid"]
        if refreshed_head != pr["headRefOid"]:
            raise ValueError("PR head changed during intake; run intake again")
        result["pr"] = pr
        result["checkout_matches_pr_head"] = result["head"] == pr["headRefOid"]
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError, KeyError) as error:
        print(f"Intake failed: {error}", file=sys.stderr)
        sys.exit(1)
