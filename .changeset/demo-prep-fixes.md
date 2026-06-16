---
"@omnirun/cli": patch
---

Fix beamup preview/gateway URLs leaking the legacy claudebox.io domain by passing the OmniRun preview domain into every beamup Sandbox.create call, redact OAuth credential material from the Claude beamup flow output, and correct the README local-dev install steps and a malformed LLM model id.
