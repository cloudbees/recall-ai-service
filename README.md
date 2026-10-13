# recall-ai-service

> [!WARNING]
> **Demonstration use only — not a CloudBees product.**
>
> This repository is part of a hands-on workshop for CloudBees Unify. It is a
> reference application built to teach concepts such as feature flags and
> progressive delivery, and it is **not** an official, supported, or maintained
> CloudBees product.
>
> **It is not safe for production use.** Authentication, access control, input
> handling and network safeguards have been deliberately simplified for teaching
> and have known security gaps. Run it only for the duration of a workshop or
> demonstration and tear it down afterwards. Do not use it with live data from
> personal, customer, or business accounts, or with any confidential
> information, and do not use it as a template for production code without a
> full security review.
>
> The recall information it displays comes from public FDA and CPSC sources and
> is shown for demonstration only; it is not compliance or legal advice.
>
> Provided "as is", without warranty of any kind, under the terms of the
> [LICENSE](LICENSE).

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
