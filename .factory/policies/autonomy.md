# Autonomy Policy

| Level | Examples | Gate |
|---|---|---|
| automatic | bounded code/docs/tests/mechanical fixes | deterministic verification |
| review | normal user-facing feature work | human review before merge |
| approval | architecture, security, production, auth, paid services, major scope | explicit approval before implementation |

Default repair limit: 2 attempts.

Any material requirement or architecture conflict is a stop condition.
