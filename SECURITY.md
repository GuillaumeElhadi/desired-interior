# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |

Pre-release and older versions receive no security fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's [private vulnerability reporting](https://github.com/GuillaumeElhadi/desired-interior/security/advisories/new)
to report a vulnerability confidentially. You will receive a response within **7 days** acknowledging
receipt, and a follow-up within **30 days** with a remediation timeline or a decision to decline.

If GitHub's advisory system is unavailable, email **guillaume.elhadi@gmail.com** with the subject
line `[SECURITY] desired-interior` and include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

Please allow reasonable time for a fix before public disclosure.

## Security features enabled on this repository

| Feature                         | Status                                          |
| ------------------------------- | ----------------------------------------------- |
| CodeQL static analysis          | ✅ — runs on every PR to `main` and weekly      |
| Secret scanning                 | ✅                                              |
| Secret scanning push protection | ✅ — blocks commits containing detected secrets |
| Dependabot vulnerability alerts | ✅                                              |
| Private vulnerability reporting | ✅                                              |
