export function githubActionsTemplate(): string {
  return `name: fluxometer-report
on:
  schedule:
    - cron: "0 8 * * *"
  workflow_dispatch: {}
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger fluxometer daily report
        env:
          FLUXOMETER_CRON_SECRET: \${{ secrets.FLUXOMETER_CRON_SECRET }}
          FLUXOMETER_REPORT_URL: \${{ secrets.FLUXOMETER_REPORT_URL }}
        run: |
          curl -fsS -X POST \\
            -H "x-fluxometer-secret: $FLUXOMETER_CRON_SECRET" \\
            "$FLUXOMETER_REPORT_URL"
`;
}

export function vercelCronTemplate(): string {
  return `${JSON.stringify(
    { crons: [{ path: "/api/fluxometer/report", schedule: "0 8 * * *" }] },
    null,
    2,
  )}\n`;
}
