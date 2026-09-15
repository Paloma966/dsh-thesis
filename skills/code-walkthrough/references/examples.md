# Worked example: gopherCron-style scheduler

A hypothetical distributed cron scheduler (modeled after gopherCron) walked
through every phase, with the tool calls the AI makes at each step.

## Phase 1 — Analyzing

Correct: state the analysis before modifying anything.

> This is a distributed cron scheduling system with two components:
>
> **Center** — manages tasks via HTTP API, stores metadata in MySQL, uses
> etcd for real-time task distribution and service discovery.
>
> **Agent** — runs on worker nodes, receives tasks via gRPC, schedules them
> locally with cron expressions, executes shell commands, reports results.
>
> Core data flow: Create task → Store in etcd → Agent watch picks it up →
> Scheduler triggers at cron time → Executer runs the shell command →
> Report to Center → Center logs to MySQL.
>
> I'll keep: task CRUD in etcd, the Agent scheduling loop, command
> execution, result reporting. I'll strip: workflow orchestration,
> webhooks, OIDC auth, Prometheus metrics, Admin UI, temporary tasks, RBAC.

Wrong: jumping straight to deleting files with no analysis — the learner
gets no chance to correct the scope.

The AI records the domain model, e.g. `ai_learning_update` with
`upsert_todo` for `common.TaskInfo` reading (difficulty 1), the etcd store
(difficulty 2), and the agent watch loop (difficulty 3).

## Phase 2 — Skeletonizing

Correct: an annotated stub with steps, hints, and a trap.

```go
// SaveTask persists a task to etcd. Called when the user creates or updates
// a task through the Center API.
//
// TODO t3 (★★): Implement task persistence
//   1. JSON-marshal the TaskInfo struct
//   2. Build the etcd key: common.BuildKey(task.ProjectID, task.TaskID)
//   3. Write with clientv3.WithLease() so the key auto-expires on crash
//   Hint: a.etcd.KV().Put(ctx, key, value, clientv3.WithLease(leaseID))
//   Trap: without a lease, dead tasks accumulate forever
func (a *app) SaveTask(task *common.TaskInfo, opts ...clientv3.OpOption) (*common.TaskInfo, error) {
    return nil, fmt.Errorf("TODO t3: SaveTask not implemented")
}
```

Wrong: `// TODO` and a nil return — no guidance.
Wrong: deleting the `App` interface because it "looks complex" — the
learner loses the dependency graph between handlers and the app layer.

The AI verifies the skeleton compiles (`go build ./...`), records
milestones, and advances to `learning`.

## Phase 3 — Milestones

```json
{
  "id": "m2",
  "title": "Task CRUD in etcd",
  "todos": ["t3", "t4", "t5", "t6"],
  "gate": { "build": ["go", "build", "./..."] },
  "questions": [
    {
      "ask": "Why are tasks stored in etcd instead of MySQL?",
      "expected": [
        "Agents need push-style notification; etcd Watch gives real-time prefix subscription",
        "MySQL has no built-in push; polling would add latency and load",
        "etcd leases give automatic cleanup for crashed Centers"
      ],
      "hints": [
        "Think about how the Agent learns that a new task exists",
        "What mechanism does MySQL lack for real-time notification?"
      ],
      "status": "unasked",
      "hintLevel": 0
    }
  ],
  "status": "pending"
}
```

## Phase 4 — Learning and checking

The learner implements t3–t6 and says "done". The AI reviews the code
against the original, then runs the gate:

```
ai_learning_update { action: "check_gate", milestoneId: "m2" }
→ gate "go build ./..." passed — milestone "m2" verified.
```

A failing gate looks like:

```
→ gate "go build ./..." failed (exit code 1); milestone marked failed.
  stderr tail: internal/store/task.go:42: undefined: clientv3
```

The learner fixes it; the next `check_gate` retries automatically.

## Phase 5 — Graded follow-up questions

```
AI: Your CRUD compiles and the gate is green. One question: you used a
    plain KV.Put. The original passes opts ...clientv3.OpOption — what
    would a caller use that for?

User: Um, etcd is faster?

AI: [weak answer — one hint] Think about what should happen to the task
    key when the Center process dies. Then: how does the Agent learn a
    new task was created — what mechanism would MySQL be missing?

User: Oh — leases so keys expire, and etcd Watch pushes prefix events
    that MySQL can't.

AI: [compare against expected points] Both points landed. One more: walk
    me through two Centers saving the same task simultaneously — does
    anything break?
```

The model grades against `expected` through `assess_answer`; never prints
the key. When the milestone's gate is green and all questions pass, the
next milestone starts — or the exercise completes.
