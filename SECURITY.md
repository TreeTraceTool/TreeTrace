# Security policy

TreeTrace runs locally and never uploads your data, so most of its security surface is the redaction gate that runs before any artifact is written. Reports about that gate, or about anything else in the tool, are welcome.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

https://github.com/TreeTraceTool/TreeTrace/security/advisories/new

That keeps the report private until a fix is out. Please include the version, your platform and Node version, and a minimal way to reproduce. If a secret would slip through the redaction gate, describe the token shape rather than pasting a real secret.

Expect a first response within a few days. Once a fix ships, the advisory is published with credit to the reporter unless you ask to stay anonymous.

## Supported versions

The latest published 0.x release on npm receives security fixes. TreeTrace is pre-1.0, so older minor versions are not patched separately. Upgrade to the current release.

## Scope

- The redaction gate fails closed. Outside a terminal every detected secret is redacted automatically, and the rendered artifact is shadow-scanned before it is written. A report that shows a known secret shape passing through is in scope and high priority.
- TreeTrace ships with no runtime dependencies, so there is no third-party package supply chain to compromise in the installed tool.
- Reading a transcript must never write outside the target directory or run code carried in the transcript. Anything that breaks that boundary is in scope.
