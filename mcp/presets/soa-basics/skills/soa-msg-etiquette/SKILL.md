---
name: soa-msg-etiquette
description: "Use when you want to tell the SoA user something mid-task from a terminal session: when to send soa-msg, how short to keep it, and what not to send."
---

# Messaging the user (soa-msg)

The user often follows along from a phone, where `soa-msg` shows up as a chat
bubble and may be read aloud. Every message interrupts them, so make each one
earn its place.

## Send one when

- you need a **decision** you cannot safely make yourself (one clear question,
  with the options);
- something **finished or failed** that they are waiting on, mid-task;
- you are **blocked** on something only a human can provide (a login, a key,
  a physical action), and you will keep working on everything else meanwhile.

## Do not send one

- for the end of your turn: the final message is forwarded to the chat
  automatically;
- for routine progress ("starting step 3", "reading files");
- with secrets, tokens, full logs or long diffs.

## How to write it

- Lead with the point. Keep it under ~50 words; the chat trims longer text.
- One question per message. Number the options if there are several, so the
  user can answer with a digit.
- Say what you will do by default if they do not answer, when that is safe.

```bash
soa-msg "Tests green on the migration branch. Merge now or wait for review? (1) merge (2) wait. Default: wait."
echo "Build failed: missing env FOO. Continuing with the docs task meanwhile." | soa-msg
```

The user's typed reply arrives in your terminal as normal input.
