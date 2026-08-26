# recall-ai-service

Recall Advisor AI service. A backend service with no public route. Owns the recall.recallAdvisor flag gate.

One of five components of the Product Recall Tracker. Start at the
[hands-on lab](https://github.com/cloudbees/recall-tracker-hands-on-lab) rather than here.

## Layout

```
apps/ai-service/     this component
packages/shared/   code shared with the other components, vendored
.cloudbees/        build and deploy workflows
```

The workspace layout is preserved from the monorepo this was generated from, so
the Dockerfile builds with the repo root as context and the Helm chart lives at
`apps/ai-service/chart`.

## Local use

```
npm install
npm run typecheck
```

Running the full application needs all the components together — see the lab.

## Configuration

Set values as variables and secrets in the CloudBees Unify UI, not in files.
Run the **Verify Setup** workflow in the Application repo to check them.
