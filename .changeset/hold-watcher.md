---
"@crafter/awake": minor
---

Replace the one-shot timer with a watcher that supervises the whole hold. It catches deadlines missed by clock changes, covers `--forever`, turns the display off when the lid closes so macOS can lock the screen (`--no-lock` opts out), sleeps a closed Mac when a hold ends, and adds `--while-pid`.
