# The software factory runs on Trigger.dev, not GitHub Actions

The factory chained its tasks by having one workflow put a label on an issue or PR so that the next workflow started, and that only worked because a long-lived `FACTORY_PAT` stood in for the `GITHUB_TOKEN`. The chain was fragile: no real queue, no retries, nothing keeping two runs off one ticket, and no record of which runs were queued, in flight or finished. So Trigger.dev Cloud is now the factory's orchestrator _and_ its runner: it chains runs in code, with concurrency and idempotency keys per issue or PR, and gives each run a fresh container. GitHub Issues stays the ticket tracker, GitHub the git host, and the feedback button the ticket source; only the orchestrator and runner slots changed.

The services around it:

- **Trigger entry**: a standalone webhook receiver on Vercel checks GitHub's signature, keeps only events a collaborator caused (and ignores events the factory's own bot caused), and calls `tasks.trigger()`. It is the one place untrusted GitHub input enters the factory, so the filtering the `agent:*` labels used to give lives there.
- **GitHub identity**: a GitHub App, not a PAT. Its webhook feeds the receiver, and each run mints a short-lived installation token, so the factory's commits and comments show as its bot.
- **Runner image**: Trigger.dev build extensions install git, gh, jq and the Claude CLI. Sandcastle keeps `noSandbox()`, as it did on Actions; the Docker image in `.sandcastle/` stays for local runs only.
- **Observability platform**: deliberately none. The Trigger.dev dashboard is enough until prompt tuning or cost needs tracing.
- **Code**: the tasks and the receiver live in `factory/` in this repo, next to the prompts they use. A human still merges every PR, including one that changes `factory/`.
- **GitHub Actions**: keeps one job, a `ci.yml` running `npm run check` on every PR as a required status check. It is an automated check that does not depend on the agent behaving, and it covers human PRs too. The four `agent-*.yml` workflows are retired, one task at a time.

## Considered Options

- **Inngest plus a separate microVM runner (E2B, Daytona, Modal)**: rejected for now. It allows a runner per task, but adds a vendor and a host for the functions. Trigger.dev fills both slots, and a Trigger.dev task can still call a microVM API later.
- **Own server and database as the orchestrator**: rejected, because it means building the queue, retries, locking and run history that a durable workflow engine already provides, and an unreliable orchestrator is the problem being fixed.
- **A bundled agent platform (Claude Code routines, Managed Agents)**: rejected, because it gives up the Sandcastle tasks and the agent loop, and its chaining is no sturdier than labels.
- **Self-hosted Trigger.dev**: rejected for now. Running the orchestrator ourselves brings back the operational fragility we are moving away from. The tasks run unchanged if we move later.
- **The receiver as a route in the app, or a Trigger.dev cron that polls GitHub**: rejected. A route ties the factory to app deploys, and polling delays every trigger and burns API calls.
- **Cloudflare Workers for the receiver**: rejected narrowly. The Trigger.dev SDK and `@octokit/webhooks` are Node-first and run unchanged on Vercel.

## Consequences

- Runs authenticate to Claude with `CLAUDE_CODE_OAUTH_TOKEN`, now stored as a Trigger.dev environment variable next to the GitHub App's private key. Billing the API instead is a change in `.sandcastle/agent-workflows/shared/common.ts`.
- Not decided here, because they are task decisions: whether the feedback button triggers explore directly or still files an issue, how explore, implement and review chain and cap their loops, and the order in which tasks leave Actions.
