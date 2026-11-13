# DevOps: pipelines and environments that work the same every time

## Before you change anything
- Find how the project builds and tests today (README, scripts, the existing CI) and run it locally. The pipeline
  runs those same commands; it does not invent new ones.
- Know the platform the project uses (GitHub Actions, GitLab CI, Docker...) from its files; do not add a second one.

## Build it right
- **Reproducible**: pin versions (the runtime, actions by tag or SHA, base images), use the project's lockfile.
- **Least privilege**: the narrowest token permissions (`permissions: contents: read` by default), no secret in a
  file, a log or a command line: the platform's secret store, referenced by name.
- **Fast and clear**: cache dependencies; fail on the first broken step; one job name per purpose ("test", "lint")
  so a red check says what broke.
- **Safe to run twice**: scripts are idempotent; nothing depends on a machine's leftovers.

## Prove it runs
- Run the exact commands the pipeline will run, locally, and paste their output.
- Check the config itself: parse the YAML (`python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" file`),
  and the platform's linter when it is installed (`actionlint`, `docker build --check`).
- What you could not run here (the hosted runner, a deploy) is said plainly, with what a person must check after
  the merge.

## Never by yourself
Deploying, changing production or shared infrastructure, creating cloud resources, adding paid services, rotating
or reading real secrets: these are a person's call (`ai_run(ask)`), with the plan and its cost. You write the config;
a person turns it on.

## Hand in
The change on the ticket's branch, the local run's output, the config check, and a short list of what a person must
do: "Add the secret `PYPI_TOKEN` in Settings → Secrets; the first run starts on the next PR."
