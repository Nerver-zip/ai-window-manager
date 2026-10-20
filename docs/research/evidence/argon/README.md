# Argon browser acceptance

Captured on 2026-10-20 using synthetic usage data, an isolated SQLite database,
and native operator authentication. No provider prompt or production deployment
was performed. Ratios and reset timestamps in these images are synthetic.

| Page           | Desktop 1440 × 900                   | Mobile 390 × 844                    | Mobile 360 × 800                    |
| -------------- | ------------------------------------ | ----------------------------------- | ----------------------------------- |
| Overview       | [Image](overview-1440x900.png)       | [Image](overview-390x844.png)       | [Image](overview-360x800.png)       |
| Usage          | [Image](usage-1440x900.png)          | [Image](usage-390x844.png)          | [Image](usage-360x800.png)          |
| Argon Schedule | [Image](schedule-argon-1440x900.png) | [Image](schedule-argon-390x844.png) | [Image](schedule-argon-360x800.png) |
| Settings       | [Image](settings-1440x900.png)       | [Image](settings-390x844.png)       | [Image](settings-360x800.png)       |

All twelve captures have no horizontal overflow and no browser page errors.
Argon has one weekly target and independent family navigation. Enhanced saves
use POST/303/fetch and replace the server-rendered schedule region without
changing `performance.timeOrigin`. Reload and server restart retain the saved
manual Argon weekly policy. Settings contain no provider credentials.

[Machine-readable layout checks](browser-checks.json).
