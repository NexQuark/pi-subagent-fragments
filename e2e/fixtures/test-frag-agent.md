---
name: e2e-frag-test
description: e2e fragments test agent
systemPromptFragments: ["./test-frag-role.md", "./test-frag-style.md"]
systemPromptMode: append
pane: false
---

AGENT-BODY-START
You are a test agent. Respond with FRAGMENT-A-START / FRAGMENT-B-START marker strings verbatim.
AGENT-BODY-END
